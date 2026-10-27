import { afterEach, describe, expect, it } from 'vitest';
import type { EmbeddedViewOwner } from '../plugin-embedded/contracts';
import type { InstalledPlugin } from '../plugin-types';
import { createEmbeddedViewController } from '../plugin-embedded/controller';
import { registerEmbeddedViewHost, leaveEmbeddedViews, disposeEmbeddedViews } from '../plugin-embedded/requests';
import { dispatchApiCall } from '../plugin-sandbox/host-api';
import { checkPluginManifest } from '../extension-package';

const permissions = ['ui:embedded-view', 'ui:app-page'];
const plugin = (overrides: Partial<InstalledPlugin> = {}): InstalledPlugin => ({
  id: 'drawing', name: 'Drawing', author: 'test', description: '', type: 'ui-extension', version: '1',
  entrypoint: 'index.js', permissions, grantedPermissions: permissions, enabled: true, status: 'running', settings: {},
  tier: 'untrusted', frameOrigins: ['https://canvas.test'], framePaths: ['/drawing/'], ...overrides,
});
const command = { action: 'open', url: 'https://canvas.test/drawing/a#ticket', title: 'Drawing' };
let remove: (() => void) | undefined;
afterEach(() => { remove?.(); remove = undefined; });

describe('embedded view host authority', () => {
  it('requires both consent grants and a bridge-owned app-page instance, without an HTTP grant', async () => {
    for (const missing of permissions) {
      await expect(dispatchApiCall(plugin({ grantedPermissions: permissions.filter(value => value !== missing) }), 'ui.embeddedView', [command])).rejects.toThrow(/permission/);
    }
    await expect(dispatchApiCall(plugin(), 'ui.embeddedView', [command])).rejects.toThrow(/instance/);
    const controller = createEmbeddedViewController(() => 'a');
    const root = document.createElement('div');
    remove = registerEmbeddedViewHost({ pluginId: 'drawing', controller, root });
    const embeddedOwner = { slot: 'app-page', signal: new AbortController().signal, container: root };
    expect(await dispatchApiCall(plugin(), 'ui.embeddedView', [command], { privileged: false, embeddedOwner })).toMatchObject({ id: expect.any(String) });
    await expect(dispatchApiCall(plugin({ id: 'another-plugin' }), 'ui.embeddedView', [command], { embeddedOwner })).rejects.toThrow(/page/);
  });
  it('rejects background callers, extra fields and undeclared paths', async () => {
    const embeddedOwner: EmbeddedViewOwner = { slot: null, signal: new AbortController().signal, container: document.createElement('div') };
    await expect(dispatchApiCall(plugin(), 'ui.embeddedView', [command], { embeddedOwner })).rejects.toThrow(/instance/);
    embeddedOwner.slot = 'app-page';
    await expect(dispatchApiCall(plugin(), 'ui.embeddedView', [{ ...command, headers: { Authorization: 'injected' } }], { embeddedOwner })).rejects.toThrow(/fields/);
  });
  it('allows plugin cancellation, while forced authentication teardown never waits for a reply', async () => {
    const controller = createEmbeddedViewController(() => 'a');
    const root = document.createElement('div');
    remove = registerEmbeddedViewHost({ pluginId: 'drawing', controller, root });
    const scope = { slot: 'app-page', signal: new AbortController().signal, container: root };
    const opened = controller.open(scope, { ...command, action: 'open' }, { hostOrigin: 'https://mail.test', frameOrigins: ['https://canvas.test'], framePaths: ['/drawing/'] });
    const leaving = leaveEmbeddedViews('logout');
    const request = await controller.handle(scope, { action: 'next', id: opened.id });
    if (request?.type !== 'leave') throw new Error('leave event missing');
    controller.handle(scope, { action: 'reply', id: opened.id, requestId: request.requestId, allow: false });
    expect(await leaving).toBe(false);
    disposeEmbeddedViews();
    expect(controller.store.getState().view).toBeNull();
  });
  it('validates frame path policies during package installation', () => {
    const checked = checkPluginManifest({ ...plugin(), version: '1.0.0', framePaths: ['/drawing/', '/tool', '//evil.test', '/drawing/../admin', '/?query'] });
    expect(checked.errors).toEqual([]);
    expect(checked.manifest?.framePaths).toEqual(['/drawing/', '/tool']);
    expect(checked.warnings).toHaveLength(1);
  });
  it('rejects another app-page instance of the same plugin outside the mounted page', async () => {
    const controller = createEmbeddedViewController(() => 'a');
    const root = document.createElement('div');
    remove = registerEmbeddedViewHost({ pluginId: 'drawing', controller, root });
    const embeddedOwner = { slot: 'app-page', signal: new AbortController().signal, container: document.createElement('div') };
    await expect(dispatchApiCall(plugin(), 'ui.embeddedView', [command], { embeddedOwner })).rejects.toThrow(/page/);
  });
});
