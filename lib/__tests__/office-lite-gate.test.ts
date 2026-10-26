import { afterAll, expect, it, vi } from 'vitest';
import type { InstalledPlugin } from '../plugin-types';

vi.stubEnv('NEXT_PUBLIC_BULWARK_LITE', '1');
const { dispatchApiCall } = await import('../plugin-sandbox/host-api');
const { OFFICE_API_PATH, readDocument } = await import('../office/contracts');
afterAll(() => vi.unstubAllEnvs());

it('refuses the server-backed editor in Lite even when a plugin declares every grant', async () => {
  expect(OFFICE_API_PATH).toBeNull();
  expect(() => readDocument({}, 'https://mail.test', [], 'channel')).toThrow('Office editors require the full app');
  const permissions = ['ui:office-editor', 'ui:app-page', 'http:post'];
  const plugin: InstalledPlugin = {
    id: 'office', name: 'Office', version: '1', author: 'test', description: '', type: 'ui-extension',
    entrypoint: 'index.js', enabled: true, status: 'running', settings: {}, permissions, grantedPermissions: permissions,
  };
  await expect(dispatchApiCall(plugin, 'office.openEditor', [{ fileId: 'a' }])).rejects.toThrow('Office editors require the full app');
});
