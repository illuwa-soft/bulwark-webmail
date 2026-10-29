/**
 * A slot frame renders the props the host sent with init and follows every
 * props-update after that. An update that landed after the slot's first
 * render but before it subscribed was dropped, so the slot kept the replaced
 * props and their callbacks, which the host had already forgotten:
 * "unknown callback" (#1266).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { act, render, cleanup, screen, waitFor } from '@testing-library/react';

const HOST_ORIGIN = window.location.origin;

// The slot component shows its label, and tells the test when it renders.
const BUNDLE = `module.exports = { slots: { 'email-banner': { component: function (props) {
  globalThis.__slotRendered && globalThis.__slotRendered(props);
  return React.createElement('span', null, props.label);
} } } };`;
const hooks = globalThis as { __slotRendered?: (props: unknown) => void };

function post(source: unknown, origin: string, data: unknown): void {
  const ev = new MessageEvent('message', { data, origin });
  Object.defineProperty(ev, 'source', { value: source });
  window.dispatchEvent(ev);
}

let hostWindow: { postMessage: ReturnType<typeof vi.fn> };
const realParent = Object.getOwnPropertyDescriptor(window, 'parent');

beforeEach(() => {
  // The runtime keeps its host binding and boot flag at module scope.
  vi.resetModules();
  hostWindow = { postMessage: vi.fn() };
  Object.defineProperty(window, 'parent', { configurable: true, get: () => hostWindow as unknown as Window });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete hooks.__slotRendered;
  if (realParent) Object.defineProperty(window, 'parent', realParent);
});

describe('slot props in the sandbox runtime', () => {
  it('executes the declaring file editor hook through the actual runtime RPC without background activation', async () => {
    const { SandboxRuntime } = await import('@/lib/plugin-sandbox/runtime');
    render(React.createElement(SandboxRuntime));
    act(() => post(hostWindow, HOST_ORIGIN, {
      type: 'init',
      payload: {
        mode: 'slot', pluginId: 'editor', tier: 'untrusted', slot: 'file-editor', locale: 'en',
        manifest: { id: 'editor', version: '1.0.0', permissions: ['http:post'], settings: {} },
        code: `const api = require('@plugin-host'); module.exports = {
          activate: function () { throw new Error('A slot must not activate the background'); },
          slots: { 'file-editor': { component: function () { return React.createElement('span', null, 'Editor ready'); } } },
          hooks: { onAction: function (event) { return api.http.post('/api/editor-fixture', { action: event.actionId, fileId: event.context.file.id }); } }
        };`,
        extraProps: { file: { id: 'selected-native-file' } },
        theme: { dark: false, fontFamily: 'sans-serif', vars: {} },
      },
    }));
    await screen.findByText('Editor ready');
    const event = { surface: 'file-editor-actions', actionId: 'save', context: { file: { id: 'selected-native-file' } } };
    post({}, HOST_ORIGIN, { type: 'hook-invoke', id: 'foreign-source', hookName: 'onAction', args: [event] });
    post(hostWindow, 'https://other.test', { type: 'hook-invoke', id: 'foreign-origin', hookName: 'onAction', args: [event] });
    expect(hostWindow.postMessage.mock.calls.some(([message]) => message.type === 'api-request')).toBe(false);
    post(hostWindow, HOST_ORIGIN, { type: 'hook-invoke', id: 'native-save', hookName: 'onAction', args: [event] });
    const apiCall = () => hostWindow.postMessage.mock.calls.map(([message]) => message).find(message => message.type === 'api-request');
    await waitFor(() => expect(apiCall()).toMatchObject({ method: 'http.post', args: ['/api/editor-fixture', { action: 'save', fileId: 'selected-native-file' }, undefined] }));
    const result = { ok: true, status: 200, data: { saved: true } };
    post(hostWindow, HOST_ORIGIN, { type: 'api-response', id: apiCall().id, ok: true, result });
    await waitFor(() => expect(hostWindow.postMessage).toHaveBeenCalledWith({ type: 'hook-result', id: 'native-save', ok: true, result }, HOST_ORIGIN));
  }, 30_000);

  it.each(['settings-page', 'email-banner'])('does not register an editor action hook in the unrelated %s slot', async (slot) => {
    const { SandboxRuntime } = await import('@/lib/plugin-sandbox/runtime');
    render(React.createElement(SandboxRuntime));
    act(() => post(hostWindow, HOST_ORIGIN, {
      type: 'init',
      payload: {
        mode: 'slot', pluginId: 'other', tier: 'untrusted', slot, locale: 'en',
        manifest: { id: 'other', version: '1.0.0', permissions: [], settings: {} },
        code: `module.exports = { slots: { '${slot}': { component: function () { return React.createElement('span', null, 'Other ready'); } } }, hooks: { onAction: function () { return 'unexpected'; } } };`,
        extraProps: {}, theme: { dark: false, fontFamily: 'sans-serif', vars: {} },
      },
    }));
    await screen.findByText('Other ready');
    post(hostWindow, HOST_ORIGIN, { type: 'hook-invoke', id: 'unrelated-slot', hookName: 'onAction', args: [] });
    expect(hostWindow.postMessage).toHaveBeenCalledWith({ type: 'hook-result', id: 'unrelated-slot', ok: false, error: 'no handler for onAction' }, HOST_ORIGIN);
  });

  it('shows an update that arrives before the slot has subscribed to updates', async () => {
    const { SandboxRuntime } = await import('@/lib/plugin-sandbox/runtime');
    render(React.createElement(SandboxRuntime));

    // The first render has read the init props; its effects have not run yet.
    let posted = false;
    hooks.__slotRendered = () => {
      if (posted) return;
      posted = true;
      post(hostWindow, HOST_ORIGIN, { type: 'props-update', props: { label: 'new' } });
    };
    post(hostWindow, HOST_ORIGIN, {
      type: 'init',
      payload: {
        mode: 'slot',
        pluginId: 'x',
        tier: 'privileged',
        slot: 'email-banner',
        locale: 'en',
        manifest: { id: 'x', version: '1.0.0', permissions: [], settings: {} },
        code: BUNDLE,
        extraProps: { label: 'old' },
        theme: { dark: false, fontFamily: 'sans-serif', vars: {} },
      },
    });

    await waitFor(() => expect(posted).toBe(true));
    await waitFor(() => expect(screen.getByText('new')).toBeInTheDocument());
  }, 30_000);
});
