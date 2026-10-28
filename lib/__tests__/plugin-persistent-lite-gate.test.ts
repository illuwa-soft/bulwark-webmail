import { afterAll, expect, it, vi } from 'vitest';
import type { InstalledPlugin } from '@/lib/plugin-types';

vi.stubEnv('NEXT_PUBLIC_BULWARK_LITE', '1');
const { dispatchApiCall } = await import('@/lib/plugin-sandbox/host-api');
afterAll(() => vi.unstubAllEnvs());

it('rejects persistent storage in Lite before capturing a cookie-backed account', async () => {
  const permissions = ['storage:persistent-read', 'storage:persistent-write'];
  const plugin: InstalledPlugin = { id: 'notes', name: 'Notes', version: '1', author: 'test', description: '', type: 'hook', entrypoint: 'index.js', enabled: true, status: 'running', settings: {}, permissions, grantedPermissions: permissions };
  await expect(dispatchApiCall(plugin, 'storage.persistent.get', ['key'])).rejects.toThrow('fullServerRequired');
  await expect(dispatchApiCall(plugin, 'storage.persistent.set', ['key', 'value', { expectedRevision: null }])).rejects.toThrow('fullServerRequired');
});
