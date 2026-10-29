import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstalledPlugin } from '@/lib/plugin-types';
import { useAccountStore } from '@/stores/account-store';
import { useAuthStore } from '@/stores/auth-store';
import { head, resolveHead, cancelForPlugin, resetDialogLimits } from '@/lib/plugin-sandbox/host-dialog';
import { proxyFetch, proxyGrantFiles, proxyFileGrant, proxyRevokeFiles } from '@/lib/plugin-sandbox/proxy-client';

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('@/lib/browser-navigation', async (original) => ({ ...await original<typeof import('@/lib/browser-navigation')>(), apiFetch }));
vi.mock('next-intl', async (original) => await original<typeof import('next-intl')>());

const plugin: InstalledPlugin = {
  id: 'document-ocr', name: 'Document OCR', version: '1.0.0', author: '', description: '', type: 'hook',
  permissions: ['files:read', 'http:proxy'], managed: true, entrypoint: 'index.js', enabled: true, status: 'running', settings: {},
  credentials: { processor: { label: 'OCR', scope: 'admin', inject: { type: 'bearer' }, secretKey: 'key', origin: 'https://processor.example', attestUser: true } },
};
const client = { getAccountId: () => 'mail-alice', getFilesAccountId: () => 'files-alice', getServerUrl: () => 'https://native.example', getUsername: () => 'alice@example.com' };

beforeEach(() => {
  apiFetch.mockReset();
  resetDialogLimits();
  useAuthStore.setState({ client: client as never });
  vi.spyOn(useAccountStore.getState(), 'getActiveAccount').mockReturnValue({ cookieSlot: 2 } as never);
});
afterEach(() => { cancelForPlugin(plugin.id); vi.restoreAllMocks(); useAuthStore.setState({ client: null }); });

describe('host-owned background read consent', () => {
  it('does not mint access on inspection or cancellation, and shows account, destination, scope and expiry', async () => {
    apiFetch.mockImplementation(async () => Response.json({ origin: 'https://processor.example', grant: { granted: false, paths: [], expiresAt: null } }));
    expect((await proxyFileGrant(plugin, ['processor'])).granted).toBe(false);
    const pending = proxyGrantFiles(plugin, ['processor', { paths: ['documents/reports'], expiresIn: 3600 }]);
    await vi.waitFor(() => expect(head()).not.toBeNull());
    expect(head()?.message).toContain('alice@example.com');
    expect(head()?.message).toContain('https://processor.example');
    expect(head()?.message).toContain('documents/reports');
    expect(head()?.message).toMatch(/closed|닫/);
    resolveHead(false);
    expect((await pending).granted).toBe(false);
    expect(apiFetch.mock.calls.every(([, init]) => !init.method)).toBe(true);
    expect(apiFetch.mock.calls.every(([, init]) => init.headers['x-jmap-cookie-slot'] === '2')).toBe(true);
  });

  it('mints only after confirmation and can revoke through the host', async () => {
    apiFetch.mockImplementation(async (_url, init) => {
      if (init.method === 'POST') return Response.json({ granted: true, paths: ['documents'], expiresAt: Date.now() + 60000 });
      if (init.method === 'DELETE') return Response.json({ granted: false, paths: [], expiresAt: null });
      return Response.json({ origin: 'https://processor.example' });
    });
    const pending = proxyGrantFiles(plugin, ['processor', { paths: ['documents'], expiresIn: 60 }]);
    await vi.waitFor(() => expect(head()).not.toBeNull());
    expect(apiFetch).toHaveBeenCalledTimes(1);
    resolveHead(true);
    expect((await pending).granted).toBe(true);
    expect(JSON.parse(apiFetch.mock.calls[1][1].body)).toEqual({ paths: ['documents'], expiresIn: 60, expectedOrigin: 'https://processor.example' });
    expect(await proxyRevokeFiles(plugin, ['processor'])).toBe(true);
  });

  it('refuses account changes while consent is open', async () => {
    apiFetch.mockResolvedValue(Response.json({ origin: 'https://processor.example' }));
    const pending = proxyGrantFiles(plugin, ['processor', { paths: ['documents'] }]);
    await vi.waitFor(() => expect(head()).not.toBeNull());
    useAuthStore.setState({ client: { ...client } as never });
    resolveHead(true);
    await expect(pending).rejects.toThrow(/account changed/);
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it('pins the proxy request to the active cookie slot even when a plugin supplies its own header', async () => {
    apiFetch.mockResolvedValue(Response.json({ ok: true }));
    await proxyFetch(plugin, ['processor', '/jobs', { headers: { 'X-JMAP-Cookie-Slot': '0', 'X-Bulwark-Identity': 'forged' } }], null);
    expect(apiFetch.mock.calls[0][1].headers['x-jmap-cookie-slot']).toBe('2');
    expect(new Headers(apiFetch.mock.calls[0][1].headers).get('x-jmap-cookie-slot')).toBe('2');
    expect(new Headers(apiFetch.mock.calls[0][1].headers).has('x-bulwark-identity')).toBe(false);
  });
});
