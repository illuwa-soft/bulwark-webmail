import { afterEach, describe, expect, it } from 'vitest';
import type { EmbeddedViewOwner } from '../plugin-embedded/contracts';
import type { InstalledPlugin } from '../plugin-types';
import { createEmbeddedViewController } from '../plugin-embedded/controller';
import { registerEmbeddedViewHost, leaveEmbeddedViews, leaveEmbeddedWorkspace, disposeEmbeddedViews } from '../plugin-embedded/requests';
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
  it('closes only the selected Files workspace while another document of the same provider stays open', async () => {
    const first = createEmbeddedViewController(() => 'a');
    const second = createEmbeddedViewController(() => 'a');
    const parent = document.createElement('div');
    const firstRoot = document.createElement('div');
    parent.append(firstRoot);
    const secondRoot = document.createElement('div');
    const disposeFirst = registerEmbeddedViewHost({ pluginId: 'drawing', controller: first, root: firstRoot });
    const disposeSecond = registerEmbeddedViewHost({ pluginId: 'drawing', controller: second, root: secondRoot });
    const firstOwner = { slot: 'file-editor', container: firstRoot, signal: new AbortController().signal };
    const secondOwner = { ...firstOwner, container: secondRoot };
    const policy = { hostOrigin: 'https://mail.test', frameOrigins: ['https://canvas.test'], framePaths: ['/drawing/'] };
    const firstView = first.open(firstOwner, { ...command, action: 'open' }, policy);
    second.open(secondOwner, { ...command, action: 'open' }, policy);

    try {
      const closing = leaveEmbeddedWorkspace('drawing', parent, 'close');
      expect(await first.handle(firstOwner, { action: 'next', id: firstView.id })).toMatchObject({ type: 'leave' });
      first.handle(firstOwner, { action: 'close', id: firstView.id });
      expect(await closing).toBe(true);
      expect(second.store.getState().view).not.toBeNull();
    } finally {
      disposeFirst();
      disposeSecond();
    }
  });

  it('accepts the Files surface grant without granting access to an app-page instance', async () => {
    const filePermissions = ['ui:embedded-view', 'ui:files', 'files:read'];
    const provider = plugin({ permissions: filePermissions, grantedPermissions: filePermissions });
    const controller = createEmbeddedViewController(() => 'a');
    const root = document.createElement('div');
    remove = registerEmbeddedViewHost({ pluginId: provider.id, controller, root });
    const embeddedOwner = { slot: 'file-editor', signal: new AbortController().signal, container: root };
    expect(await dispatchApiCall(provider, 'ui.embeddedView', [command], { embeddedOwner })).toMatchObject({ id: expect.any(String) });
    await expect(dispatchApiCall(provider, 'ui.embeddedView', [command], { embeddedOwner: { ...embeddedOwner, slot: 'app-page' } })).rejects.toThrow(/permission/);
    await expect(dispatchApiCall(provider, 'ui.closeFileEditor', [], { embeddedOwner: { ...embeddedOwner, slot: 'background' } })).rejects.toThrow(/live file-editor/);
    await expect(dispatchApiCall(plugin({ permissions: [], grantedPermissions: [] }), 'files.refresh', [])).rejects.toThrow(/files:read/);
  });

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
