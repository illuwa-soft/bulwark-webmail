import { createHmac } from 'node:crypto';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ credentials: vi.fn(), plugin: vi.fn(), config: vi.fn() }));
vi.mock('@/lib/stalwart/credentials', () => ({ getStalwartCredentials: mocks.credentials }));
vi.mock('@/lib/admin/plugin-registry', () => ({ getPlugin: mocks.plugin }));
vi.mock('@/lib/admin/plugin-config', () => ({ getPluginConfig: mocks.config }));
const { POST } = await import('@/app/api/plugin-assistant/route');

/** Build a same-origin request with no client authority over its actor.
 * 클라이언트가 actor 권한을 갖지 않는 동일 출처 요청을 만듭니다. */
function request(path = '/api/settings') {
  return new NextRequest('https://mail.example.com/api/plugin-assistant', { method: 'POST', headers: { Host: 'mail.example.com', Origin: 'https://mail.example.com', 'Content-Type': 'application/json', 'X-JMAP-Username': 'spoofed@example.com' }, body: JSON.stringify({ path, method: 'GET', actor: 'spoofed' }) });
}

beforeEach(() => {
  vi.restoreAllMocks();
  mocks.credentials.mockResolvedValue({ trusted: true, serverUrl: 'https://mail.example.com', authHeader: 'Basic native-test-auth', username: 'unverified-cookie-name' });
  mocks.plugin.mockResolvedValue({ enabled: true });
  mocks.config.mockResolvedValue({ origin: 'https://assistant.example.com', TOKEN: 'test-attestation-key' });
});

afterEach(() => vi.restoreAllMocks());

it('rejects cross-origin requests before checking native credentials', async () => {
  const input = request();
  input.headers.set('Origin', 'https://untrusted.example.com');
  mocks.credentials.mockClear();
  expect((await POST(input)).status).toBe(403);
  expect(mocks.credentials).not.toHaveBeenCalled();
});

it('rejects missing native credentials and untrusted JMAP servers', async () => {
  mocks.credentials.mockResolvedValueOnce(null);
  expect((await POST(request())).status).toBe(401);
  mocks.credentials.mockResolvedValueOnce({ trusted: false });
  expect((await POST(request())).status).toBe(401);
});

it('requires an enabled plugin and a configured HTTPS gateway', async () => {
  mocks.plugin.mockResolvedValueOnce({ enabled: false });
  expect((await POST(request())).status).toBe(403);
  mocks.config.mockResolvedValueOnce({ origin: 'http://assistant.example.com', TOKEN: 'test' });
  expect((await POST(request())).status).toBe(503);
});

it('rejects malformed gateway configuration without making a request', async () => {
  const network = vi.spyOn(globalThis, 'fetch');
  for (const origin of ['not-a-url', 'https://user:password@assistant.example.com', 'https://assistant.example.com/subpath']) {
    mocks.config.mockResolvedValueOnce({ origin, TOKEN: 'test' });
    expect((await POST(request())).status).toBe(503);
  }
  mocks.config.mockResolvedValueOnce({ origin: 'https://assistant.example.com', TOKEN: '' });
  expect((await POST(request())).status).toBe(503);
  expect(network).not.toHaveBeenCalled();
});

it('rejects malformed relay envelopes before making a server request', async () => {
  const network = vi.spyOn(globalThis, 'fetch');
  for (const body of ['{', 'null', '[]', '{"path":"/api/settings"}', '{"path":"/api/settings","method":"GET","body":{}}']) {
    expect((await POST(new NextRequest(request(), { body }))).status).toBe(400);
  }
  expect(network).not.toHaveBeenCalled();
});

it('rejects path traversal before making any server request', async () => {
  const network = vi.spyOn(globalThis, 'fetch');
  expect((await POST(request('/api/../admin/config'))).status).toBe(400);
  expect(network).not.toHaveBeenCalled();
});

it('signs the JMAP-verified account and never forwards its native password', async () => {
  const network = vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(Response.json({ username: 'verified@example.com' }))
    .mockResolvedValueOnce(Response.json({ models: [], mcps: [] }));
  expect((await POST(request())).status).toBe(200);
  const [url, options] = network.mock.calls[1];
  const headers = new Headers(options?.headers);
  expect(String(url)).toBe('https://assistant.example.com/api/settings');
  expect(headers.has('Authorization')).toBe(false);
  const actor = headers.get('X-Assistant-Actor')!;
  expect(JSON.parse(Buffer.from(actor, 'base64url').toString())).toEqual(['https://mail.example.com', 'verified@example.com']);
  const signature = createHmac('sha256', 'test-attestation-key').update([headers.get('X-Assistant-Timestamp'), actor, 'GET', '/api/settings', ''].join('\n')).digest('base64');
  expect(headers.get('X-Assistant-Signature')).toBe(signature);
});

it('follows a same-origin JMAP discovery redirect before attesting the native account', async () => {
  const network = vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(new Response(null, { status: 307, headers: { Location: '/jmap/session' } }))
    .mockResolvedValueOnce(Response.json({ username: 'verified@example.com' }))
    .mockResolvedValueOnce(Response.json({ models: [], mcps: [] }));
  expect((await POST(request())).status).toBe(200);
  expect(String(network.mock.calls[1][0])).toBe('https://mail.example.com/jmap/session');
  expect(new Headers(network.mock.calls[1][1]?.headers).get('Authorization')).toBe('Basic native-test-auth');
  expect(new Headers(network.mock.calls[2][1]?.headers).has('Authorization')).toBe(false);
});

it('never follows a discovery redirect to a different origin or URL userinfo', async () => {
  for (const location of ['https://untrusted.example.com/session', 'https://user:password@mail.example.com/session']) {
    const network = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(null, { status: 307, headers: { Location: location } }));
    expect((await POST(request())).status).toBe(502);
    expect(network).toHaveBeenCalledTimes(1);
    network.mockRestore();
  }
});

it('bounds same-origin discovery redirects instead of looping', async () => {
  const network = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(null, { status: 307, headers: { Location: '/.well-known/jmap' } }));
  expect((await POST(request())).status).toBe(502);
  expect(network).toHaveBeenCalledTimes(4);
});

it('rejects invalid native sessions and malformed canonical usernames', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(null, { status: 401 }));
  expect((await POST(request())).status).toBe(401);
  vi.mocked(globalThis.fetch).mockResolvedValueOnce(Response.json({ username: {} }));
  expect((await POST(request())).status).toBe(401);
});

it('returns a bounded generic failure when a remote connection fails', async () => {
  vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('private upstream details'));
  const response = await POST(request());
  expect(response.status).toBe(502);
  expect(await response.text()).not.toContain('private upstream details');
});
