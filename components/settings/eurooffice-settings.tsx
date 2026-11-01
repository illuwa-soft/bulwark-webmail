'use client';
import { useState } from 'react';
import { useLocale } from 'next-intl';
import { useMutation } from '@tanstack/react-query';
import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import { useEuroOffice } from '@/hooks/use-eurooffice';
import { officeInformation, officeQueries, type OfficeInformation } from '@/lib/eurooffice/client';
import { leaveOfficeViews } from '@/lib/eurooffice/lifecycle';
import { useAuthStore } from '@/stores/auth-store';
import { sameOfficeAccount, type OfficeAccount } from '@/lib/eurooffice/account';
import type { QueryKey } from '@tanstack/react-query';
import { ToggleSwitch } from './settings-section';

const english = {
  enabled: 'Enable EuroOffice for this account', consent: 'Enabling grants Office its own Native file access for this account until you disable it or revoke access. Your mail password is not stored.',
  setup: 'The installation administrator configures one shared editor server. Files and activation stay separate for every account.',
  hostSetup: 'The operator must configure the webmail server connector before enabling this account.',
  server: 'EuroOffice server URL', header: 'JWT header', secret: 'JWT signing key (leave blank to retain)', save: 'Save shared settings', test: 'Test connection', saved: 'Shared signing key configured', close: 'Save and close the Office document before continuing.', loading: 'Checking this account…'
};
const korean: typeof english = {
  enabled: '이 계정에서 EuroOffice 사용', consent: '활성화하면 이 계정의 파일 접근용 Office 서비스 권한을 발급합니다. 비활성화하거나 권한을 폐기할 때까지 유지하며 메일 비밀번호는 저장하지 않습니다.',
  setup: '설치 관리자가 편집 서버를 한 번 등록합니다. 활성화 상태와 파일함은 계정마다 분리됩니다.',
  hostSetup: '운영자가 웹메일 서버의 게이트웨이 연결을 설정해야 계정별로 활성화할 수 있습니다.',
  server: 'EuroOffice 서버 주소', header: 'JWT 헤더', secret: 'JWT 서명키 (비워 두면 기존 값 유지)', save: '공통 설정 저장', test: '연결 검사', saved: '공통 서명키 등록됨', close: '열린 Office 문서를 저장하고 닫은 뒤 다시 시도해 주세요.', loading: '현재 계정을 확인하고 있습니다…'
};

export function EuroOfficeSettings({ configured }: { configured: boolean }) {
  const locale = useLocale();
  let copy = english;
  if (locale.startsWith('ko')) copy = korean;
  const { accountId, context, ready, queryKey, query } = useEuroOffice(configured);
  const toggle = useMutation({
    mutationFn: async () => {
      const auth = useAuthStore.getState();
      if (!query.data || !context || !sameOfficeAccount(context, auth.client, auth.activeAccountId)) throw new Error('Account changed');
      if (!(await leaveOfficeViews('disable'))) throw new Error(copy.close);
      const current = useAuthStore.getState();
      if (!sameOfficeAccount(context, current.client, current.activeAccountId)) throw new Error('Account changed');
      if (query.data.enabled) return officeInformation(context, { action: 'disable' }, query.data.ownerId);
      return officeInformation(context, { action: 'enable', accessConsent: 'mail-server-unlimited-app-password' }, query.data.ownerId);
    },
    onSuccess: (data) => officeQueries.setQueryData(queryKey, data),
    onSettled: () => officeQueries.invalidateQueries({ queryKey }),
    retry: false, gcTime: 0
  }, officeQueries);
  if (!accountId) return null;
  return <section data-eurooffice-integration data-search-label="EuroOffice" className="mb-4 space-y-3 rounded-lg border border-border p-3">
    <div className="flex items-center justify-between gap-3"><h3 className="font-semibold">EuroOffice</h3>
      <ToggleSwitch checked={ready && query.data?.enabled === true} disabled={!ready || !query.data || toggle.isPending} onChange={() => toggle.mutate()} ariaLabel={copy.enabled} />
    </div>
    <p className="text-xs text-muted-foreground">{copy.setup}</p>
    {!configured && <p className="text-xs text-muted-foreground">{copy.hostSetup}</p>}
    <p className="text-xs text-muted-foreground">{copy.consent}</p>
    {query.isLoading && <p role="status">{copy.loading}</p>}
    {(query.error || toggle.error) && <p role="alert" className="text-sm text-destructive">{(toggle.error ?? query.error)?.message}</p>}
    {query.data && <p className="text-xs"><bdi>{query.data.username}</bdi></p>}
    {ready && query.data?.connection.canManage && context && <InstallationConnection key={`${query.data.ownerId}:${query.data.connection.revision}`} info={query.data} account={context} queryKey={queryKey} copy={copy} />}
    {query.data && !query.data.connection.canManage && <p className="text-xs"><bdi>{query.data.connection.serverUrl}</bdi></p>}
  </section>;
}

function InstallationConnection({ info, account, queryKey, copy }: { info: OfficeInformation; account: OfficeAccount; queryKey: QueryKey; copy: typeof english }) {
  const [store] = useState(() => createStore(() => ({ serverUrl: info.connection.serverUrl, jwtHeader: info.connection.jwtHeader, jwtSecret: '' })));
  const draft = useStore(store);
  const save = useMutation({ mutationFn: async () => {
    const auth = useAuthStore.getState();
    if (!sameOfficeAccount(account, auth.client, auth.activeAccountId)) { store.setState({ jwtSecret: '' }); throw new Error('Account changed'); }
    try { return await officeInformation(account, { action: 'connection.save', connection: store.getState() }, info.ownerId); }
    finally { store.setState({ jwtSecret: '' }); }
  }, onSuccess: async (data) => { officeQueries.setQueryData(queryKey, data); await officeQueries.invalidateQueries({ queryKey: ['eurooffice'] }); }, retry: false, gcTime: 0 }, officeQueries);
  const test = useMutation({ mutationFn: () => {
    const auth = useAuthStore.getState();
    if (!sameOfficeAccount(account, auth.client, auth.activeAccountId)) throw new Error('Account changed');
    return officeInformation(account, { action: 'connection.test' }, info.ownerId);
  }, retry: false, gcTime: 0 }, officeQueries);
  return <form className="space-y-2" onSubmit={(event) => { event.preventDefault(); save.mutate(); }}>
    <fieldset disabled={save.isPending || test.isPending} className="space-y-2">
      <label className="block text-sm">{copy.server}<input required type="url" dir="ltr" value={draft.serverUrl} onChange={(event) => store.setState({ serverUrl: event.target.value })} className="mt-1 block w-full rounded border border-border bg-background p-2" /></label>
      <label className="block text-sm">{copy.header}<select dir="ltr" value={draft.jwtHeader} onChange={(event) => store.setState({ jwtHeader: event.target.value })} className="ms-2 rounded border border-border bg-background p-2"><option>AuthorizationJwt</option><option>Authorization</option></select></label>
      <label className="block text-sm">{copy.secret}<input type="password" autoComplete="off" dir="ltr" value={draft.jwtSecret} onChange={(event) => store.setState({ jwtSecret: event.target.value })} className="mt-1 block w-full rounded border border-border bg-background p-2" /></label>
      <div className="flex gap-2"><button type="submit" className="rounded border border-border px-3 py-1">{copy.save}</button><button type="button" disabled={!info.connection.hasSecret} onClick={() => test.mutate()} className="rounded border border-border px-3 py-1">{copy.test}</button></div>
    </fieldset>
    {info.connection.hasSecret && <p className="text-xs">{copy.saved}</p>}
    {test.isSuccess && <p role="status">✓ {copy.test}</p>}
    {(save.error || test.error) && <p role="alert" className="text-sm text-destructive">{(save.error ?? test.error)?.message}</p>}
  </form>;
}
