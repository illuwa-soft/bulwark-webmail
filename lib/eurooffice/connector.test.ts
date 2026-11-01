// @vitest-environment node
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const auth = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('@/lib/stalwart/credentials', () => ({ getStalwartCredentials: (...args: unknown[]) => auth.get(...args) }));
vi.mock('@/lib/admin/config-manager', () => ({ configManager: { ensureLoaded: async () => {}, getPolicy: () => ({ features: { pluginsEnabled: true } }) } }));
import { officeProxy, officeSettings } from './connector';

beforeEach(() => {
  vi.stubEnv('EUROOFFICE_GATEWAY_URL', 'https://office.example.test');
  auth.get.mockResolvedValue({ authHeader: 'Bearer native-account-b', username: 'account-b@example.test', serverUrl: 'https://native.example.test/jmap', slot: 1, trusted: true });
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it('requires an explicit authenticated cookie slot instead of falling back to another account', async () => {
  const request = new NextRequest('https://mail.example.test/api/eurooffice/settings');
  expect((await officeSettings(request)).status).toBe(400);
  expect(auth.get).not.toHaveBeenCalled();
  auth.get.mockResolvedValue(null);
  expect((await officeSettings(new NextRequest(request, { headers: { 'x-jmap-cookie-slot': '1' } }))).status).toBe(401);
});

it('forwards only the selected Native credential and never a previous Office cookie or forged account headers', async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response('bytes', { headers: { 'set-cookie': 'office_workspace_session=wrong', 'content-type': 'video/mp4' } }));
  vi.stubGlobal('fetch', fetcher);
  const owner = 'b'.repeat(43);
  const request = new NextRequest('https://mail.example.test/api/eurooffice/view/1/' + owner + '/api/v1/eurooffice/workspace/content/file-b?workspaceId=workspace-b&version=v1', {
    headers: { cookie: 'office_workspace_session=account-a', 'x-office-account': 'forged-account-a', authorization: 'Bearer forged', range: 'bytes=0-9' }
  });
  const response = await officeProxy(request, { slot: '1', owner, path: ['api', 'v1', 'eurooffice', 'workspace', 'content', 'file-b'] });
  expect(response.status).toBe(200);
  const [url, options] = fetcher.mock.calls[0];
  expect(String(url)).toBe('https://office.example.test/api/v1/eurooffice/workspace/content/file-b?workspaceId=workspace-b&version=v1');
  const headers = new Headers(options.headers);
  expect(headers.get('authorization')).toBe('Bearer native-account-b');
  expect(headers.get('x-office-account')).toBe(owner);
  expect(headers.get('x-office-native-origin')).toBe('https://native.example.test');
  expect(headers.get('range')).toBe('bytes=0-9');
  expect(headers.has('cookie')).toBe(false);
  expect(response.headers.has('set-cookie')).toBe(false);
});

it('denies embedded login, ticket exchange, traversal and redirected credential forwarding', async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: { location: 'https://outside.example' } }));
  vi.stubGlobal('fetch', fetcher);
  const owner = 'b'.repeat(43);
  const request = new NextRequest('https://mail.example.test/api/eurooffice/view/1/' + owner);
  for (const path of [['api', 'v1', 'eurooffice', 'workspace', 'login'], ['api', 'v1', 'eurooffice', 'workspace', 'connect'], ['..', 'admin']]) {
    expect((await officeProxy(request, { slot: '1', owner, path })).status).toBe(403);
  }
  expect(fetcher).not.toHaveBeenCalled();
  expect((await officeProxy(request, { slot: '1', owner, path: [] })).status).toBe(502);
  expect(fetcher.mock.calls[0][1].redirect).toBe('manual');
});
