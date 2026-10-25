import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET, HEAD } from '@/app/api/download/route';
import { getStalwartCredentials } from '@/lib/stalwart/credentials';
import { fetchJmapSession } from '@/lib/stalwart/jmap-api';
import { fetchJmapServer } from '@/lib/stalwart/server-fetch';

vi.mock('@/lib/stalwart/credentials', () => ({ getStalwartCredentials: vi.fn() }));
vi.mock('@/lib/stalwart/jmap-api', () => ({ fetchJmapSession: vi.fn() }));
vi.mock('@/lib/stalwart/server-fetch', () => ({ fetchJmapServer: vi.fn() }));
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }));

const creds = { serverUrl: 'https://mail.example.test', username: 'owner@example.test', authHeader: 'Bearer test-only-secret', slot: 3, trusted: true, hasSessionCookie: true };

function request(values: Record<string, string> = {}, headers: Record<string, string> = {}, method = 'GET') {
  const params = new URLSearchParams({ slot: '3', clientAccountId: 'owner@example.test@mail.example.test', serverUrl: creds.serverUrl,
    accountId: 'shared-account', blobId: 'blob-1', name: '한글 report.pdf', type: 'application/pdf', ...values });
  return new NextRequest('https://webmail.example.test/api/download?' + params, { method, headers });
}

beforeEach(() => {
  vi.mocked(getStalwartCredentials).mockResolvedValue(creds);
  vi.mocked(fetchJmapSession).mockResolvedValue({ primaryAccounts: {}, downloadUrl: 'https://public.example.test/custom/download/{accountId}/{blobId}/{name}?accept={type}' });
  vi.mocked(fetchJmapServer).mockResolvedValue(new Response('probe', { headers: { 'Content-Length': '5', 'Content-Type': 'application/pdf', ETag: '"v1"' } }));
});
afterEach(() => vi.clearAllMocks());

describe('cookie-authenticated streaming downloads', () => {
  it('streams the first bytes before origin completion and keeps credentials off the URL', async () => {
    let controller: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; value.enqueue(new TextEncoder().encode('first')); } });
    const upstream = new Response(body, { headers: { 'Content-Type': 'application/pdf', 'Set-Cookie': 'private=bad' } });
    const readBlob = vi.spyOn(upstream, 'blob');
    const readArray = vi.spyOn(upstream, 'arrayBuffer');
    vi.mocked(fetchJmapServer).mockResolvedValue(upstream);
    const req = request();
    const response = await GET(req);
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Disposition')).toContain("filename*=UTF-8''%ED%95%9C%EA%B8%80%20report.pdf");
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('Set-Cookie')).toBeNull();
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('first');
    controller!.enqueue(new TextEncoder().encode('second'));
    controller!.close();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('second');
    expect(readBlob).not.toHaveBeenCalled();
    expect(readArray).not.toHaveBeenCalled();
    const [url, init, trusted] = vi.mocked(fetchJmapServer).mock.calls[0];
    expect(url).toBe('https://mail.example.test/custom/download/shared-account/blob-1/%ED%95%9C%EA%B8%80%20report.pdf?accept=application%2Fpdf');
    expect(url).not.toContain('test-only-secret');
    expect(new Headers(init!.headers).get('Authorization')).toBe(creds.authHeader);
    expect(init!.signal).toBe(req.signal);
    expect(trusted).toBe(true);
  });

  it('keeps the stored server origin even when the advertised path starts with two slashes', async () => {
    vi.mocked(fetchJmapSession).mockResolvedValue({ primaryAccounts: {}, downloadUrl: 'https://public.example.test//other.example.test/download/{blobId}' });
    expect((await GET(request())).status).toBe(200);
    expect(vi.mocked(fetchJmapServer).mock.calls[0][0]).toBe('https://mail.example.test//other.example.test/download/blob-1');
  });

  it('preserves the guarded fetch for a custom server', async () => {
    vi.mocked(getStalwartCredentials).mockResolvedValue({ ...creds, trusted: false });
    await GET(request());
    expect(vi.mocked(fetchJmapServer).mock.calls[0][2]).toBe(false);
  });

  it('preserves a native partial response and byte-range validators', async () => {
    vi.mocked(fetchJmapServer).mockResolvedValue(new Response('part', { status: 206,
      headers: { 'Content-Range': 'bytes 4-7/12', 'Content-Length': '4', 'Accept-Ranges': 'bytes', ETag: '"v1"' } }));
    const response = await GET(request({}, { Range: 'bytes=4-7', 'If-Range': '"v1"' }));
    expect(response.status).toBe(206);
    expect(response.headers.get('Content-Range')).toBe('bytes 4-7/12');
    expect(response.headers.get('Content-Length')).toBe('4');
    expect(await response.text()).toBe('part');
    const forwarded = new Headers(vi.mocked(fetchJmapServer).mock.calls[0][1]!.headers);
    expect(forwarded.get('Range')).toBe('bytes=4-7');
    expect(forwarded.get('If-Range')).toBe('"v1"');
    expect(forwarded.get('Accept-Encoding')).toBe('identity');
  });

  it('keeps HEAD bodyless while forwarding native metadata', async () => {
    vi.mocked(fetchJmapServer).mockResolvedValue(new Response(null, { headers: { 'Content-Length': '104857600' } }));
    const response = await HEAD(request({}, {}, 'HEAD'));
    expect(response.body).toBeNull();
    expect(response.headers.get('Content-Length')).toBe('104857600');
    expect(vi.mocked(fetchJmapServer).mock.calls[0][1]!.method).toBe('HEAD');
  });

  it('serves a byte slice when a JMAP origin ignores Range and has no ETag', async () => {
    vi.mocked(fetchJmapServer).mockResolvedValue(new Response('0123456789', { headers: { 'Content-Length': '10' } }));
    const response = await GET(request({}, { Range: 'bytes=2-4' }));
    expect(response.status).toBe(206);
    expect(response.headers.get('Content-Range')).toBe('bytes 2-4/10');
    expect(response.headers.get('Content-Length')).toBe('3');
    expect(response.headers.get('ETag')).toMatch(/^"bulwark-/);
    expect(await response.text()).toBe('234');
  });

  it('does not append another representation when If-Range fails', async () => {
    vi.mocked(fetchJmapServer).mockResolvedValue(new Response('0123456789', { headers: { 'Content-Length': '10' } }));
    const response = await GET(request({}, { Range: 'bytes=2-', 'If-Range': '"other-version"' }));
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Range')).toBeNull();
    expect(await response.text()).toBe('0123456789');
  });

  it.each(['', '-1', '3x', '50', '999'])('rejects invalid slot %s without trying another account', async (slot) => {
    expect((await GET(request({ slot }))).status).toBe(400);
    expect(getStalwartCredentials).not.toHaveBeenCalled();
  });

  it('refuses an anonymous download', async () => {
    vi.mocked(getStalwartCredentials).mockResolvedValue(null);
    expect((await GET(request())).status).toBe(401);
    expect(fetchJmapServer).not.toHaveBeenCalled();
  });

  it.each([{ slot: 2 }, { username: 'different@example.test' }, { serverUrl: 'https://other.example.test' }])(
    'refuses cookie-slot reuse or a different calling login', async (change) => {
      vi.mocked(getStalwartCredentials).mockResolvedValue({ ...creds, ...change });
      expect((await GET(request())).status).toBe(403);
      expect(fetchJmapSession).not.toHaveBeenCalled();
    },
  );

  it('does not use a client-supplied server as the fetch destination', async () => {
    expect((await GET(request({ serverUrl: 'https://attacker.example.test' }))).status).toBe(403);
    expect(fetchJmapServer).not.toHaveBeenCalled();
  });

  it('sanitizes filename control characters', async () => {
    const response = await GET(request({ name: 'evil"\r\nInjected: header.bin' }));
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Disposition')).not.toMatch(/[\r\n]/);
    expect(response.headers.get('Injected')).toBeNull();
  });

  it.each([401, 403, 404, 429, 500])('preserves native refusal %s without creating an attachment', async (status) => {
    vi.mocked(fetchJmapServer).mockResolvedValue(new Response('private upstream body', { status }));
    const response = await GET(request());
    expect(response.status).toBe(status);
    expect(response.headers.get('Content-Disposition')).toBeNull();
    expect(await response.text()).not.toContain('private upstream body');
    expect(fetchJmapServer).toHaveBeenCalledOnce();
  });

  it('retains an unsatisfiable native range', async () => {
    vi.mocked(fetchJmapServer).mockResolvedValue(new Response(null, { status: 416, headers: { 'Content-Range': 'bytes */12' } }));
    const response = await GET(request({}, { Range: 'bytes=99-' }));
    expect(response.status).toBe(416);
    expect(response.headers.get('Content-Range')).toBe('bytes */12');
  });

  it('contains cancellation failures from a refused origin stream', async () => {
    const body = new ReadableStream({ cancel: () => Promise.reject(new Error('test-only-cancel-failure')) });
    vi.mocked(fetchJmapServer).mockResolvedValue(new Response(body, { status: 403 }));
    expect((await GET(request())).status).toBe(403);
    await new Promise(resolve => setTimeout(resolve, 0));
  });

  it('returns a sanitized failure without retrying a failed stream setup', async () => {
    vi.mocked(fetchJmapServer).mockRejectedValue(new Error('test-only-private-error'));
    const response = await GET(request());
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain('test-only-private-error');
    expect(fetchJmapServer).toHaveBeenCalledOnce();
  });
});
