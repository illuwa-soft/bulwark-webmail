import { describe, expect, it } from 'vitest';
import { dispatchApiCall } from '../plugin-sandbox/host-api';
import { checkPluginManifest } from '../extension-package';
import type { InstalledPlugin } from '../plugin-types';

const plugin: InstalledPlugin = {
  id: 'retired-capabilities', name: 'Retired capabilities', version: '1.0.0',
  author: 'Test', description: '', type: 'hook', entrypoint: 'index.js',
  permissions: ['http:proxy', 'files:read', 'ui:app-page'],
  enabled: true, status: 'running', settings: {},
};

describe('retired downstream plugin capabilities', () => {
  it.each(['ui.embeddedView', 'proxy.fileGrant', 'proxy.grantFiles', 'proxy.revokeFiles'])(
    'rejects %s before any network request or side effect', async (method) => {
      await expect(dispatchApiCall(plugin, method, [])).rejects.toThrow(`Unknown API method "${method}"`);
    },
  );

  it('rejects installation requests for host-owned external views', () => {
    const checked = checkPluginManifest({ ...plugin, permissions: ['ui:embedded-view'], framePaths: ['/editor/'] });
    expect(checked.manifest).toBeNull();
    expect(checked.errors.some((error) => error.includes('Unknown permissions'))).toBe(true);
    expect(checked.errors.some((error) => error.includes('external views are not supported'))).toBe(true);
  });

  it('rejects account attestation while retaining the ordinary credential proxy', () => {
    const credentials = { processor: { label: 'Processor', scope: 'admin', inject: { type: 'bearer' }, secretKey: 'key', origin: 'https://processor.test' } };
    const manifest = { ...plugin, configSchema: { key: { type: 'secret', label: 'Key' } }, credentials };
    expect(checkPluginManifest(manifest).errors).toEqual([]);
    const retired = checkPluginManifest({ ...manifest, credentials: { processor: { ...credentials.processor, attestUser: true } } });
    expect(retired.manifest).toBeNull();
    expect(retired.errors.some((error) => error.includes('attestation is not supported'))).toBe(true);
  });
});
