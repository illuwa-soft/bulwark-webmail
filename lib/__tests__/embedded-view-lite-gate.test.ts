import { afterAll, expect, it, vi } from 'vitest';
import type { InstalledPlugin } from '../plugin-types';

vi.stubEnv('NEXT_PUBLIC_BULWARK_LITE', '1');
const { dispatchApiCall } = await import('../plugin-sandbox/host-api');
afterAll(() => vi.unstubAllEnvs());

it('hides host-owned embedded views in Lite without retaining a provider API path', async () => {
  const permissions = ['ui:embedded-view', 'ui:app-page'];
  const plugin: InstalledPlugin = {
    id: 'drawing', name: 'Drawing', version: '1', author: 'test', description: '', type: 'ui-extension',
    entrypoint: 'index.js', enabled: true, status: 'running', settings: {}, permissions, grantedPermissions: permissions,
  };
  await expect(dispatchApiCall(plugin, 'ui.embeddedView', [{ action: 'open', title: 'Drawing', url: 'https://canvas.test/drawing/a' }])).rejects.toThrow('Embedded views require the full app');
});
