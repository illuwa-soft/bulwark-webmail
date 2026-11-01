import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, cleanup } from '@testing-library/react';
import type { InstalledPlugin } from '@/lib/plugin-types';
import type { AccountEntry } from '@/stores/account-store';

vi.mock('next-intl', () => ({ useTranslations: () => (key: string, values?: { name?: string }) => `${key} ${values?.name ?? ''}`.trim(), useLocale: () => 'ko' }));
vi.mock('@/hooks/use-config', () => ({ useConfig: () => ({ demoMode: false }) }));
vi.mock('@/stores/auth-store', async () => {
  const { create } = await import('zustand');
  return { useAuthStore: create(() => ({ activeAccountId: null, client: null, isAuthenticated: false })) };
});
const transport = vi.hoisted(() => vi.fn());
vi.mock('@/lib/browser-navigation', async (original) => ({
  ...await original<typeof import('@/lib/browser-navigation')>(), apiFetch: (...args: unknown[]) => transport(...args)
}));

import { PluginsSettings } from '../plugins-settings';
import { usePluginStore } from '@/stores/plugin-store';
import { usePolicyStore } from '@/stores/policy-store';
import { useAuthStore } from '@/stores/auth-store';
import { useAccountStore } from '@/stores/account-store';
import { JMAPClient } from '@/lib/jmap/client';
import { officeQueries } from '@/lib/eurooffice/client';
import { registerOfficeFrame } from '@/lib/eurooffice/lifecycle';

const enabled = [true, false];
let administrators = false;

/** UI-only peers; proxy and Worker tests separately prove Native authentication and authorization.
 * UI 상대만 모사하며 Native 인증·권한은 별도 프록시·Worker 시험이 검증합니다. */
function information(slot: number) {
  let ownerId = 'a'.repeat(43);
  let username = 'member@example.test';
  if (slot === 1) { ownerId = 'b'.repeat(43); username = 'other@example.test'; }
  return { ownerId, username, enabled: enabled[slot], workspaceId: `workspace-${slot}`, connection: { serverUrl: 'https://docs.example.test/suite', jwtHeader: 'AuthorizationJwt', hasSecret: true, canManage: administrators, revision: 1, jwtSecret: 'unexpected-upstream-secret-must-be-stripped' } };
}

function account(id: string, slot: number): AccountEntry {
  return { id, label: id, serverUrl: 'https://native.example.test', username: id, authMode: 'token', cookieSlot: slot, rememberMe: true, displayName: id, email: `${id}@example.test`, avatarColor: '#123456', lastLoginAt: 0, isConnected: true, hasError: false, isDefault: slot === 0 };
}

function select(id: string, subject: string) {
  const client = JMAPClient.withBearer('https://native.example.test', 'fixture-only-bearer', 'constructor-alias');
  vi.spyOn(client, 'getSessionUsername').mockReturnValue(subject);
  useAuthStore.setState({ activeAccountId: id, client, isAuthenticated: true });
}

beforeEach(() => {
  enabled[0] = true; enabled[1] = false; administrators = false;
  officeQueries.clear();
  useAccountStore.setState({ accounts: [account('a', 0), account('b', 1)] });
  select('a', 'member@example.test');
  usePolicyStore.setState({ loaded: true, isFeatureEnabled: () => true, isPluginForceEnabled: () => false });
  const agent: InstalledPlugin = { id: 'bulwark-agent', name: 'Illuwa Agent', version: '0.6.1', author: 'fixture', description: '', type: 'hook', permissions: [], entrypoint: 'index.js', enabled: true, status: 'running', managed: true, settings: {} };
  usePluginStore.setState({ plugins: [agent], initialized: true, initializePlugins: async () => {} });
  transport.mockReset();
  transport.mockImplementation(async (_path: string, options: RequestInit) => {
    const headers = new Headers(options.headers);
    const slot = Number(headers.get('X-JMAP-Cookie-Slot'));
    expect(headers.has('Authorization')).toBe(false);
    expect(headers.get('X-Office-Expected-Origin')).toBe('https://native.example.test');
    if (options.method === 'POST') {
      const input = JSON.parse(String(options.body));
      if (input.action === 'disable') enabled[slot] = false;
      if (input.action === 'enable') { expect(input.accessConsent).toBe('mail-server-unlimited-app-password'); enabled[slot] = true; }
    }
    return Response.json(information(slot));
  });
});
afterEach(() => { cleanup(); officeQueries.clear(); vi.restoreAllMocks(); });

it('keeps the actual Agent toggle independent of the server-owned Office switch', async () => {
  render(<PluginsSettings />);
  const office = await screen.findByRole('switch', { name: '이 계정에서 EuroOffice 사용' });
  await waitFor(() => expect(office).toHaveAttribute('aria-checked', 'true'));
  fireEvent.click(screen.getByRole('switch', { name: /Illuwa Agent/ }));
  expect(usePluginStore.getState().plugins[0].enabled).toBe(false);
  expect(office).toHaveAttribute('aria-checked', 'true');
  fireEvent.click(office);
  await waitFor(() => expect(office).toHaveAttribute('aria-checked', 'false'));
  expect(usePluginStore.getState().plugins[0].enabled).toBe(false);
  expect(enabled[0]).toBe(false);
  fireEvent.click(screen.getByRole('switch', { name: /Illuwa Agent/ }));
  expect(usePluginStore.getState().plugins[0].enabled).toBe(true);
  expect(office).toHaveAttribute('aria-checked', 'false');
  expect(screen.queryByLabelText('JWT 서명키 (비워 두면 기존 값 유지)')).not.toBeInTheDocument();
  expect(JSON.stringify(officeQueries.getQueryCache().getAll().map((query) => query.state.data))).not.toContain('unexpected-upstream-secret');
});

it('rejects a stale toggle after the account changes while the document is closing', async () => {
  const frame = document.createElement('iframe');
  document.body.append(frame);
  const peer = frame.contentWindow!;
  const send = vi.spyOn(peer, 'postMessage').mockImplementation(() => {});
  const unregister = registerOfficeFrame(peer);
  try {
    render(<PluginsSettings />);
    await waitFor(() => expect(screen.getByRole('switch', { name: '이 계정에서 EuroOffice 사용' })).toHaveAttribute('aria-checked', 'true'));
    window.dispatchEvent(new MessageEvent('message', { source: peer, origin: location.origin, data: { source: 'office-app', event: 'ready' } }));
    fireEvent.click(screen.getByRole('switch', { name: '이 계정에서 EuroOffice 사용' }));
    await waitFor(() => expect(send).toHaveBeenCalled());
    const request = send.mock.calls[0][0] as { requestId: string };
    act(() => select('b', 'other@example.test'));
    act(() => window.dispatchEvent(new MessageEvent('message', { source: peer, origin: location.origin, data: { source: 'office-app', event: 'leave-result', requestId: request.requestId, canLeave: true } })));
    await waitFor(() => expect(officeQueries.isMutating()).toBe(0));
    expect(transport.mock.calls.filter(([, options]) => options.method === 'POST')).toHaveLength(0);
    expect(enabled).toEqual([true, false]);
  } finally { unregister(); frame.remove(); }
});

it('restores each account switch independently instead of sharing one browser-global preference', async () => {
  const view = render(<PluginsSettings />);
  await waitFor(() => expect(screen.getByRole('switch', { name: '이 계정에서 EuroOffice 사용' })).toHaveAttribute('aria-checked', 'true'));
  act(() => select('b', 'other@example.test'));
  view.rerender(<PluginsSettings />);
  await waitFor(() => expect(screen.getByText('other@example.test')).toBeInTheDocument());
  expect(screen.getByRole('switch', { name: '이 계정에서 EuroOffice 사용' })).toHaveAttribute('aria-checked', 'false');
  fireEvent.click(screen.getByRole('switch', { name: '이 계정에서 EuroOffice 사용' }));
  await waitFor(() => expect(enabled[1]).toBe(true));
  expect(enabled[0]).toBe(true);
});

it('does not carry an unsent signing-key draft between two installation administrators', async () => {
  administrators = true;
  const view = render(<PluginsSettings />);
  const secret = await screen.findByLabelText('JWT 서명키 (비워 두면 기존 값 유지)');
  fireEvent.change(secret, { target: { value: 'local-admin-a-draft-only' } });
  officeQueries.setQueryData(['eurooffice', 'b', 1, 'other@example.test', 'https://native.example.test'], information(1));
  act(() => select('b', 'other@example.test'));
  view.rerender(<PluginsSettings />);
  await waitFor(() => expect(screen.getByText('other@example.test')).toBeInTheDocument());
  expect(screen.getByLabelText('JWT 서명키 (비워 두면 기존 값 유지)')).toHaveValue('');
  expect(officeQueries.getMutationCache().getAll().every((mutation) => mutation.state.variables === undefined)).toBe(true);
});
