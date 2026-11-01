'use client';
import { QueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { apiFetch, withBasePath } from '@/lib/browser-navigation';
import type { OfficeAccount } from './account';

const information = z.object({
  ownerId: z.string().regex(/^[A-Za-z0-9_-]{43}$/), username: z.string(), enabled: z.boolean(), workspaceId: z.string().nullable(),
  connection: z.object({ serverUrl: z.string(), jwtHeader: z.string(), hasSecret: z.boolean(), canManage: z.boolean(), revision: z.number() })
});
const failure = z.object({ error: z.object({ code: z.string(), message: z.string().max(1024) }) });
export type OfficeInformation = z.infer<typeof information>;
export type OfficeChange =
  | { action: 'enable'; accessConsent: 'mail-server-unlimited-app-password' }
  | { action: 'disable' }
  | { action: 'connection.test' }
  | { action: 'connection.save'; connection: { serverUrl: string; jwtHeader: string; jwtSecret: string } };

export const officeQueries = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 }, mutations: { retry: false, gcTime: 0 } } });

/** Centralize slot-pinned transport; secrets exist only in the explicit request body.
 * 슬롯에 고정한 전송을 모으고 비밀값은 명시적인 요청 본문에만 둡니다. */
export async function officeInformation(account: OfficeAccount, change?: OfficeChange, expectedOwner?: string, signal?: AbortSignal) {
  const headers = new Headers({ 'X-JMAP-Cookie-Slot': String(account.slot), 'X-Office-Expected-Subject': encodeURIComponent(account.subject), 'X-Office-Expected-Origin': account.origin });
  if (expectedOwner) headers.set('X-Office-Account', expectedOwner);
  let method = 'GET';
  let body: string | undefined;
  if (change) {
    method = 'POST';
    body = JSON.stringify(change);
    headers.set('Content-Type', 'application/json');
  }
  const response = await apiFetch('/api/eurooffice/settings', { method, headers, body, signal, cache: 'no-store' });
  const value = await response.json();
  if (!response.ok) {
    const parsed = failure.safeParse(value);
    if (parsed.success) throw new Error(parsed.data.error.message);
    throw new Error('EuroOffice is unavailable');
  }
  return information.parse(value);
}

export function officeViewUrl(slot: number, ownerId: string) {
  return new URL(withBasePath(`/api/eurooffice/view/${slot}/${encodeURIComponent(ownerId)}/`), location.origin).href;
}
