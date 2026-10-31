import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createConfig } from '@/lib/__tests__/fixtures/config';

vi.hoisted(() => {
  // Seed before auth modules load, as on an upgraded device.
  // 업그레이드된 기기처럼 인증 모듈을 불러오기 전에 이전 선택을 준비합니다.
  localStorage.setItem('account-list-preferences', JSON.stringify({ version: 0, state: { rememberAccountList: true } }));
});

vi.mock('@/lib/jmap/client', () => {
  class JMAPClient {
    constructor(public serverUrl: string, public username: string, public password: string) {}
    static withBearer() { throw new Error('not used'); }
    async connect() {}
    getSessionUsername() { return this.username; }
    getUsername() { return this.username; }
    async getIdentities() { return [{ id: 'a', email: this.username, name: this.username, mayDelete: false }]; }
    getAuthHeader() { return 'Basic eA=='; }
    onConnectionChange() {}
    onRateLimit() {}
    getRateLimitRemainingMs() { return 0; }
    supportsContacts() { return false; }
    supportsPrincipals() { return false; }
    supportsVacationResponse() { return false; }
    supportsCalendars() { return false; }
    supportsSieve() { return false; }
    disconnect() {}
    getAccountId() { return 'acct'; }
    async getEmails() { return { emails: [], total: 0 }; }
    async getTagCounts() { return {}; }
  }
  class RateLimitError extends Error {}
  class RequestTimeoutError extends Error {}
  return { JMAPClient, RateLimitError, RequestTimeoutError };
});
vi.mock('@/lib/stalwart/principal', () => ({ fetchPrincipalDisplayName: async () => null }));

import * as navigation from '@/lib/browser-navigation';
import { useAuthStore } from '../auth-store';
import { useAccountStore } from '../account-store';
const server = 'https://gmail.example.com';
const username = 'user@gmail.com';
const retiredPreference = JSON.stringify({ version: 0, state: { rememberAccountList: true } });
const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
  const url = String(input);
  if (url.includes('/api/config')) return Response.json(createConfig());
  if (url.includes('/api/auth/session') && init?.method === 'PUT') return new Response('{}', { status: 401 });
  return new Response('{}');
});

beforeEach(() => {
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(navigation, 'replaceWindowLocation').mockImplementation(() => {});
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem('account-list-preferences', retiredPreference);
  useAccountStore.setState({ accounts: [], activeAccountId: null, defaultAccountId: null });
  useAuthStore.setState({ isAuthenticated: false, client: null, activeAccountId: null, isDemoMode: false });
});

afterEach(async () => {
  await useAuthStore.getState().logoutAll();
  vi.restoreAllMocks();
});

it('forgets a signed-out account even when the retired device preference is enabled', async () => {
  await useAuthStore.getState().login(server, username, 'test-password', undefined, true);
  const id = useAuthStore.getState().activeAccountId!;
  await useAuthStore.getState().logout();
  expect(useAccountStore.getState().getAccountById(id)).toBeUndefined();
  expect(localStorage.getItem('account-registry')).toBeNull();
  expect(fetchMock.mock.calls.some(([url, init]) => String(url).includes('/api/auth/session') && init?.method === 'DELETE')).toBe(true);
});

it('forgets every account and its live clients on explicit sign-out of all accounts', async () => {
  await useAuthStore.getState().login(server, username, 'test-password', undefined, true);
  await useAuthStore.getState().login(server, 'other@gmail.com', 'other-test-password', undefined, true);
  const ids = useAccountStore.getState().accounts.map((account) => account.id);
  expect(ids).toHaveLength(2);
  await useAuthStore.getState().logoutAll();
  expect(useAccountStore.getState().accounts).toEqual([]);
  expect(useAuthStore.getState().isAuthenticated).toBe(false);
  for (const id of ids) expect(useAuthStore.getState().getClientForAccount(id)).toBeUndefined();
});

it('keeps the next signed-in account connected when signing out of only the active account', async () => {
  await useAuthStore.getState().login(server, username, 'test-password', undefined, true);
  const first = useAuthStore.getState().activeAccountId!;
  await useAuthStore.getState().login(server, 'other@gmail.com', 'other-test-password', undefined, true);
  const second = useAuthStore.getState().activeAccountId!;
  await useAuthStore.getState().logout();
  expect(useAccountStore.getState().getAccountById(second)).toBeUndefined();
  expect(useAuthStore.getState().activeAccountId).toBe(first);
  expect(useAuthStore.getState().isAuthenticated).toBe(true);
});
