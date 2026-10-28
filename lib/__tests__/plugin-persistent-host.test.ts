import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dispatchApiCall } from '@/lib/plugin-sandbox/host-api';
import { useAuthStore } from '@/stores/auth-store';
import { useAccountStore } from '@/stores/account-store';
import type { InstalledPlugin } from '@/lib/plugin-types';
const send = vi.hoisted(() => vi.fn());
vi.mock('@/lib/browser-navigation', async (original) => ({ ...await original<typeof import('@/lib/browser-navigation')>(), apiFetch: send }));
vi.mock('@/stores/toast-store', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));
const fingerprint = 'a'.repeat(64);
const reader: InstalledPlugin = { id: 'notes', name: 'Notes', version: '1', author: 'test', description: '', type: 'hook', permissions: ['storage:persistent-read', 'storage:persistent-write', 'http:post'], grantedPermissions: ['storage:persistent-read', 'storage:persistent-write', 'http:post'], managed: true, bundleHash: fingerprint, enabled: true, status: 'running', entrypoint: 'index.js', settings: {}, apiPostPaths: ['/api/plugin-storage', '/api/%70lugin-storage'] };
beforeEach(() => {
  send.mockReset(); send.mockResolvedValue(Response.json({ result: { value: null, revision: null } }));
  useAccountStore.setState({ activeAccountId: 'alice', accounts: [{ id: 'alice', username: 'alice', serverUrl: 'https://mail.example.test', cookieSlot: 2 } as never] });
  useAuthStore.setState({ client: { getUsername: () => 'alice', getServerUrl: () => 'https://mail.example.test' } as never });
});
afterEach(() => { useAuthStore.setState({ client: null }); useAccountStore.setState({ activeAccountId: null, accounts: [] }); });

describe('persistent sandbox bridge', () => {
  it('pins slot/package headers and refuses another namespace selector', async () => {
    await dispatchApiCall(reader, 'storage.persistent.get', ['note']);
    expect(send).toHaveBeenCalledWith('/api/plugin-storage', expect.objectContaining({ headers: expect.objectContaining({ 'X-JMAP-Cookie-Slot': '2', 'X-Bulwark-Plugin-Id': 'notes', 'X-Bulwark-Plugin-Fingerprint': fingerprint }), body: JSON.stringify({ operation: 'get', key: 'note' }) }));
    send.mockClear();
    await expect(dispatchApiCall(reader, 'storage.persistent.set', ['note', 'x', { expectedRevision: null, pluginId: 'other' }])).rejects.toThrow('invalid');
    expect(send).not.toHaveBeenCalled();
  });

  it('gates reads/writes and prevents the generic HTTP facade from bypassing the namespace', async () => {
    await expect(dispatchApiCall({ ...reader, permissions: [], grantedPermissions: [] }, 'storage.persistent.get', ['note'])).rejects.toThrow('permission');
    await expect(dispatchApiCall(reader, 'http.post', ['/api/plugin-storage', {}])).rejects.toThrow('not available');
    await expect(dispatchApiCall(reader, 'http.post', ['/api/%70lugin-storage', {}])).rejects.toThrow('not available');
    expect(send).not.toHaveBeenCalled();
  });

  it('discards late data after an account switch and never retries a conflict or transport failure', async () => {
    send.mockImplementationOnce(async () => { useAccountStore.setState({ activeAccountId: 'bob' }); return Response.json({ result: { value: 'private', revision: null } }); });
    await expect(dispatchApiCall(reader, 'storage.persistent.get', ['note'])).rejects.toThrow('accountChanged');
    useAccountStore.setState({ activeAccountId: 'alice' });
    send.mockClear(); send.mockResolvedValueOnce(Response.json({ error: { code: 'conflict' } }, { status: 409 }));
    await expect(dispatchApiCall(reader, 'storage.persistent.set', ['note', 'x', { expectedRevision: null }])).rejects.toThrow('storage.persistent.conflict');
    expect(send).toHaveBeenCalledTimes(1);
    send.mockClear(); send.mockRejectedValueOnce(new Error('network'));
    await expect(dispatchApiCall(reader, 'storage.persistent.set', ['note', 'x', { expectedRevision: null }])).rejects.toThrow();
    expect(send).toHaveBeenCalledTimes(1);
  });
});
