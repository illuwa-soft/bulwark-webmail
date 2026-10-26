import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InstalledPlugin } from '../plugin-types';
import { registerOfficeHost, leaveOffice, disposeOffice } from '../office/requests';
import { dispatchApiCall } from '../plugin-sandbox/host-api';

const permissions = ['ui:office-editor', 'ui:app-page', 'http:post'];
const plugin = (overrides: Partial<InstalledPlugin> = {}): InstalledPlugin => ({
  id: 'office', name: 'Office', author: 'test', description: '', type: 'ui-extension', version: '1',
  entrypoint: 'index.js', permissions, grantedPermissions: permissions, enabled: true, status: 'running', settings: {},
  tier: 'untrusted', apiPostPaths: ['/api/v1/eurooffice-plugin'], frameOrigins: ['https://editor.test'], ...overrides,
});
let remove: (() => void) | undefined;
afterEach(() => { remove?.(); remove = undefined; });

describe('Office host API authority', () => {
  it('requires explicit editor consent plus the page and authenticated POST grants', async () => {
    for (const missing of permissions) {
      await expect(dispatchApiCall(plugin({ grantedPermissions: permissions.filter(value => value !== missing) }), 'office.openEditor', [{ fileId: 'a' }])).rejects.toThrow(/permission|needs/);
    }
  });
  it('works from the untrusted tier only in its own mounted host page', async () => {
    const open = vi.fn(async () => null);
    remove = registerOfficeHost({ pluginId: 'office', active: () => true, open, leave: async () => true, dispose: vi.fn() });
    expect(await dispatchApiCall(plugin(), 'office.openEditor', [{ fileId: 'a' }], { privileged: false })).toBeNull();
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ fileId: 'a', pluginId: 'office', allowedOrigins: ['https://editor.test'] }));
    await expect(dispatchApiCall(plugin({ id: 'other' }), 'office.openEditor', [{ fileId: 'a' }])).rejects.toThrow(/page/);
  });
  it('rejects URL injection, extra fields and calls without a host page', async () => {
    await expect(dispatchApiCall(plugin(), 'office.openEditor', [{ fileId: 'a', url: 'https://evil.test' }])).rejects.toThrow(/only fileId/);
    await expect(dispatchApiCall(plugin(), 'office.openEditor', [{ fileId: 'a' }])).rejects.toThrow(/page/);
  });
  it('allows cancellation of voluntary leave, but forced authentication teardown disposes immediately', async () => {
    const dispose = vi.fn();
    remove = registerOfficeHost({ pluginId: 'office', active: () => true, open: async () => null, leave: async () => false, dispose });
    expect(await leaveOffice()).toBe(false);
    disposeOffice();
    expect(dispose).toHaveBeenCalledOnce();
  });
});
