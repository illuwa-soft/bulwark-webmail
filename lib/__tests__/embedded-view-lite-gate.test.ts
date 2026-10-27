import { afterAll, expect, it, vi } from 'vitest';
import type { InstalledPlugin } from '../plugin-types';
import { applyLitePolicy } from '../lite-config';
import { buildCsp, buildStalwartEntryCsp } from '../../scripts/lite/lib.mjs';

vi.stubEnv('NEXT_PUBLIC_BULWARK_LITE', '1');
const { dispatchApiCall } = await import('../plugin-sandbox/host-api');
afterAll(() => vi.unstubAllEnvs());

it('follows the existing Lite plugin-host policy even with forged grants and a page scope', async () => {
  const permissions = ['ui:embedded-view', 'ui:app-page'];
  const plugin: InstalledPlugin = {
    id: 'example-view', name: 'Example view', version: '1.0.0', author: 'test', description: '', type: 'ui-extension',
    entrypoint: 'index.js', enabled: true, status: 'running', settings: {}, permissions, grantedPermissions: permissions,
  };
  const policy = applyLitePolicy({ features: { pluginsEnabled: true, pluginsUploadEnabled: true }, forceEnabledPlugins: ['example-view'] });
  expect(policy.features.pluginsEnabled).toBe(false);
  expect(policy.features.pluginsUploadEnabled).toBe(false);
  expect(policy.forceEnabledPlugins).toEqual([]);
  const embeddedOwner = { slot: 'app-page', signal: new AbortController().signal, container: document.body };
  await expect(dispatchApiCall(plugin, 'ui.embeddedView', [{ action: 'open', title: 'Example', url: 'https://canvas.test/workspace/' }], { embeddedOwner })).rejects.toThrow('Plugin embedded views are unavailable in Lite');
});

it('does not broaden either Lite target CSP to external frames or eval', () => {
  for (const csp of [buildCsp(), buildStalwartEntryCsp()]) {
    expect(csp).toContain("frame-src 'self' blob:");
    expect(csp).not.toContain('frame-src https:');
    expect(csp).not.toContain("'unsafe-eval'");
  }
});
