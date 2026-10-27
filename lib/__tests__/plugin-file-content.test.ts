import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IJMAPClient } from '../jmap/client-interface';
import type { InstalledPlugin } from '../plugin-types';
import { useAuthStore } from '@/stores/auth-store';
import { dispatchApiCall } from '../plugin-sandbox/host-api';

vi.mock('@/stores/toast-store', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));

const plugin: InstalledPlugin = { id: 'file-reader', name: 'Reader', version: '1', author: 'test', description: '', type: 'hook', permissions: ['files:read'], grantedPermissions: ['files:read'], entrypoint: 'index.js', enabled: true, status: 'running', settings: {} };
const content = new Uint8Array([1, 2, 3]).buffer;
let client: Record<string, ReturnType<typeof vi.fn>>;

beforeEach(() => {
  plugin.grantedPermissions = ['files:read'];
  client = {
    getServerUrl: vi.fn(() => 'https://mail.example.test'),
    getUsername: vi.fn(() => 'alice'),
    getAccountId: vi.fn(() => 'mail-a'),
    getFilesAccountId: vi.fn(() => 'files-a'),
    getFileNodes: vi.fn(async () => [{ id: 'f', name: 'photo.png', type: 'image/png', size: 3, blobId: 'file-blob', parentId: null }]),
    fetchBlobArrayBuffer: vi.fn(async () => content),
  };
  useAuthStore.setState({ client: client as unknown as IJMAPClient });
});
afterEach(() => useAuthStore.setState({ client: null }));

describe('file-owned bounded content', () => {
  it('reads bytes through the owning FileNode without exposing blob IDs or credentials', async () => {
    expect(await dispatchApiCall(plugin, 'files.readContent', ['f'])).toEqual({ id: 'f', name: 'photo.png', type: 'image/png', size: 3, data: content });
    expect(client.fetchBlobArrayBuffer).toHaveBeenCalledWith('file-blob', 'photo.png', 'image/png', 'files-a', 25 * 1024 * 1024 + 1);
  });

  it('requires files:read and refuses arbitrary account IDs, directories and oversized metadata', async () => {
    await expect(dispatchApiCall({ ...plugin, grantedPermissions: [] }, 'files.readContent', ['f'])).rejects.toThrow(/permission/);
    await expect(dispatchApiCall(plugin, 'files.readContent', ['other:f'])).rejects.toThrow(/primary/);
    client.getFileNodes.mockResolvedValueOnce([{ id: 'f', blobId: null, type: 'd' }]);
    await expect(dispatchApiCall(plugin, 'files.readContent', ['f'])).rejects.toThrow(/file/);
    client.getFileNodes.mockResolvedValueOnce([{ id: 'f', blobId: 'b', size: 26 * 1024 * 1024 }]);
    await expect(dispatchApiCall(plugin, 'files.readContent', ['f'])).rejects.toThrow(/large|limit/);
    expect(client.fetchBlobArrayBuffer).not.toHaveBeenCalled();
  });

  it.each(['account', 'permission'])('discards content when %s changes while downloading', async (change) => {
    client.fetchBlobArrayBuffer.mockImplementationOnce(async () => {
      if (change === 'account') useAuthStore.setState({ client: null });
      if (change === 'permission') plugin.grantedPermissions = [];
      return content;
    });
    await expect(dispatchApiCall(plugin, 'files.readContent', ['f'])).rejects.toThrow(/changed|revoked/);
  });

  it('rejects bytes over the cap even if the metadata claims a small file', async () => {
    client.fetchBlobArrayBuffer.mockResolvedValueOnce(new ArrayBuffer(25 * 1024 * 1024 + 1));
    await expect(dispatchApiCall(plugin, 'files.readContent', ['f'])).rejects.toThrow(/large|limit/);
  });

  it.each([{ accountId: 'other' }, { isShared: true }])('refuses a node outside the primary files account: %j', async (extra) => {
    client.getFileNodes.mockResolvedValueOnce([{ id: 'f', name: 'private.png', type: 'image/png', size: 3, blobId: 'private-blob', ...extra }]);
    await expect(dispatchApiCall(plugin, 'files.readContent', ['f'])).rejects.toThrow(/primary/);
    expect(client.fetchBlobArrayBuffer).not.toHaveBeenCalled();
  });
});
