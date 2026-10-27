import { afterEach, describe, expect, it } from 'vitest';
import type { InstalledPlugin } from '../plugin-types';
import { createEmbeddedViewController } from '../plugin-embedded/controller';
import { disposeEmbeddedViews, leaveEmbeddedViews, registerEmbeddedViewHost } from '../plugin-embedded/requests';
import { dispatchApiCall } from '../plugin-sandbox/host-api';
import { checkPluginManifest } from '../extension-package';

const permissions = ['ui:embedded-view', 'ui:app-page'];
const plugin = (overrides: Partial<InstalledPlugin> = {}): InstalledPlugin => ({
  id: 'example-view', name: 'Example view', version: '1.0.0', author: 'test', description: '', type: 'ui-extension',
  entrypoint: 'index.js', permissions, grantedPermissions: permissions, enabled: true, status: 'running', settings: {},
  tier: 'untrusted', frameOrigins: ['https://canvas.test'], framePaths: ['/workspace/'], ...overrides,
});
const command = { action: 'open', url: 'https://canvas.test/workspace/', title: 'Example view' };
let remove: (() => void) | undefined;
afterEach(() => { remove?.(); remove = undefined; });

describe('embedded view API authority', () => {
  it('needs explicit consent and a live page instance, without any HTTP permission', async () => {
    for (const missing of permissions) {
      await expect(dispatchApiCall(plugin({ grantedPermissions: permissions.filter(value => value !== missing) }), 'ui.embeddedView', [command])).rejects.toThrow(/permission/);
    }
    await expect(dispatchApiCall(plugin(), 'ui.embeddedView', [command])).rejects.toThrow(/instance/);
    const controller = createEmbeddedViewController(() => 'a');
    const root = document.createElement('div');
    const container = document.createElement('div');
    root.append(container);
    remove = registerEmbeddedViewHost({ pluginId: 'example-view', controller, root });
    const embeddedOwner = { slot: 'app-page', signal: new AbortController().signal, container };
    expect(await dispatchApiCall(plugin(), 'ui.embeddedView', [command], { privileged: false, embeddedOwner })).toMatchObject({ id: expect.any(String) });
    await expect(dispatchApiCall(plugin({ id: 'another' }), 'ui.embeddedView', [command], { embeddedOwner })).rejects.toThrow(/page/);
  });

  it('refuses another instance of the same plugin outside the mounted page', async () => {
    const controller = createEmbeddedViewController(() => 'a');
    remove = registerEmbeddedViewHost({ pluginId: 'example-view', controller, root: document.createElement('div') });
    const embeddedOwner = { slot: 'app-page', signal: new AbortController().signal, container: document.createElement('div') };
    await expect(dispatchApiCall(plugin(), 'ui.embeddedView', [command], { embeddedOwner })).rejects.toThrow(/page/);
  });

  it('refuses non-page instances and sealed-command injection', async () => {
    const context = { signal: new AbortController().signal, container: document.createElement('div') };
    await expect(dispatchApiCall(plugin(), 'ui.embeddedView', [command], { embeddedOwner: { ...context, slot: null } })).rejects.toThrow(/instance/);
    await expect(dispatchApiCall(plugin(), 'ui.embeddedView', [{ ...command, headers: { Authorization: 'injected' } }], { embeddedOwner: { ...context, slot: 'app-page' } })).rejects.toThrow(/fields/);
  });

  it('permits cancellation of a voluntary leave while forced teardown disposes immediately', async () => {
    const controller = createEmbeddedViewController(() => 'a');
    const root = document.createElement('div');
    remove = registerEmbeddedViewHost({ pluginId: 'example-view', controller, root });
    const owner = { slot: 'app-page', signal: new AbortController().signal, container: root };
    const opened = controller.open(owner, { ...command, action: 'open' }, { hostOrigin: 'https://mail.test', frameOrigins: ['https://canvas.test'], framePaths: ['/workspace/'] });
    const leaving = leaveEmbeddedViews('logout');
    const event = await controller.handle(owner, { action: 'next', id: opened.id });
    if (event?.type !== 'leave') throw new Error('leave event missing');
    controller.handle(owner, { action: 'reply', id: opened.id, requestId: event.requestId, allow: false });
    expect(await leaving).toBe(false);
    disposeEmbeddedViews();
    expect(controller.store.getState().view).toBeNull();
  });

  it('carries only validated launch paths through package validation', () => {
    const checked = checkPluginManifest({ ...plugin(), framePaths: ['/workspace/', '/canvas.html', '//other.test', '/workspace/../other', '/?query'] });
    expect(checked.errors).toEqual([]);
    expect(checked.manifest?.framePaths).toEqual(['/workspace/', '/canvas.html']);
    expect(checked.warnings).toHaveLength(1);
  });
});
