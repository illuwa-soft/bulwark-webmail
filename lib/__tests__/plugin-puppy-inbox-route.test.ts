import { createHmac, createHash, createDecipheriv } from 'node:crypto';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ credentials: vi.fn(), plugin: vi.fn(), config: vi.fn() }));
vi.mock('@/lib/stalwart/credentials', () => ({ getStalwartCredentials: mocks.credentials }));
vi.mock('@/lib/admin/plugin-registry', () => ({ getPlugin: mocks.plugin }));
vi.mock('@/lib/admin/plugin-config', () => ({ getPluginConfig: mocks.config }));
const { POST } = await import('@/app/api/plugin-puppy-inbox/route');

/** Builds a synthetic native request without browser authority over the actor.
 * 브라우저가 actor를 결정하지 않는 합성 네이티브 요청을 만듭니다. */
function request(path = '/api/status') {
  return new NextRequest('https://mail.example.com/api/plugin-puppy-inbox', { method: 'POST', headers: { Host: 'mail.example.com', Origin: 'https://mail.example.com', 'Content-Type': 'application/json' }, body: JSON.stringify({ path, body: {} }) });
}

beforeEach(() => {
  vi.restoreAllMocks();
  mocks.credentials.mockResolvedValue({ trusted: true, serverUrl: 'https://mail.example.com', authHeader: 'Basic fixture-native' });
  mocks.plugin.mockResolvedValue({ enabled: true, permissions: ['files:read', 'http:post'] });
  mocks.config.mockResolvedValue({ origin: 'https://processor.example.com', TOKEN: 'fixture-shared-key' });
});
afterEach(() => vi.restoreAllMocks());

it('verifies native identity, signs the command and seals background access without leaking it to the browser', async () => {
  const network = vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(Response.json({ username: 'verified@example.com', primaryAccounts: { 'urn:ietf:params:jmap:filenode': 'files-account-1' } }))
    .mockResolvedValueOnce(Response.json({ jobs: [], error: null }));
  const response = await POST(request());
  expect(response.status).toBe(200);
  const [url, options] = network.mock.calls[1];
  const headers = new Headers(options?.headers);
  expect(String(url)).toBe('https://processor.example.com/api/status');
  expect(headers.has('Authorization')).toBe(false);
  const actor = headers.get('X-Puppy-Actor')!;
  const access = headers.get('X-Puppy-Access')!;
  expect(JSON.parse(Buffer.from(actor, 'base64url').toString())).toEqual(['https://mail.example.com', 'verified@example.com', 'files-account-1']);
  const bytes = Buffer.from(access, 'base64url');
  const decipher = createDecipheriv('aes-256-gcm', createHash('sha256').update('fixture-shared-key').digest(), bytes.subarray(0, 12));
  decipher.setAuthTag(bytes.subarray(-16));
  expect(Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString()).toBe('Basic fixture-native');
  expect(headers.get('X-Puppy-Signature')).toBe(createHmac('sha256', 'fixture-shared-key').update([headers.get('X-Puppy-Timestamp'), actor, access, 'POST', '/api/status', '{}'].join('\n')).digest('base64'));
  expect(await response.text()).not.toMatch(/fixture-native|fixture-shared-key|X-Puppy-Access/);
});

it('rejects cross-origin, missing credentials and a plugin without the requested permissions', async () => {
  const cross = request(); cross.headers.set('Origin', 'https://other.example.com');
  expect((await POST(cross)).status).toBe(403);
  mocks.credentials.mockResolvedValueOnce(null);
  expect((await POST(request())).status).toBe(401);
  mocks.plugin.mockResolvedValueOnce({ enabled: true, permissions: ['files:read'] });
  expect((await POST(request())).status).toBe(403);
});

it('limits the relay to Puppy commands and rejects invalid configuration', async () => {
  expect((await POST(request('/api/../admin/config'))).status).toBe(400);
  mocks.config.mockResolvedValueOnce({ origin: 'http://processor.example.com', TOKEN: 'fixture' });
  expect((await POST(request())).status).toBe(503);
});

it('requires a native file account identity before delegating background access', async () => {
  const network = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json({ username: 'verified@example.com' }));
  expect((await POST(request())).status).toBe(401);
  expect(network).toHaveBeenCalledTimes(1);
});

it('follows native same-origin discovery and rejects cross-origin redirects', async () => {
  const network = vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(new Response(null, { status: 307, headers: { Location: '/jmap/session' } }))
    .mockResolvedValueOnce(Response.json({ username: 'verified@example.com', primaryAccounts: { 'urn:ietf:params:jmap:filenode': 'files-account-1' } }))
    .mockResolvedValueOnce(Response.json({ jobs: [] }));
  expect((await POST(request())).status).toBe(200);
  expect(String(network.mock.calls[1][0])).toBe('https://mail.example.com/jmap/session');
  network.mockReset().mockResolvedValueOnce(new Response(null, { status: 307, headers: { Location: 'https://other.example.com/session' } }));
  expect((await POST(request())).status).toBe(502);
  expect(network).toHaveBeenCalledTimes(1);
});
