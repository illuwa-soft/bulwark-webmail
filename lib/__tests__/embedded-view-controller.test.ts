import { describe, expect, it, vi } from 'vitest';
import { createEmbeddedViewController } from '../plugin-embedded/controller';
import { readEmbeddedUrl, type EmbeddedViewOwner } from '../plugin-embedded/contracts';

const policy = { hostOrigin: 'https://mail.test', frameOrigins: ['https://editor.test', 'https://canvas.test'], framePaths: ['/workbench/', '/drawing/', '/canvas.html'] };
const launch = { action: 'open' as const, url: 'https://editor.test/workbench/document#one-use-ticket', title: 'Document workspace' };
const owner = (abort = new AbortController()): EmbeddedViewOwner => ({ slot: 'app-page', signal: abort.signal, container: document.createElement('div') });

describe('provider-neutral embedded views', () => {
  it('admits different applications, but refuses same-origin, unapproved and out-of-path documents', () => {
    expect(readEmbeddedUrl(launch.url, policy)).toBe(launch.url);
    expect(readEmbeddedUrl('https://canvas.test/drawing/a', policy)).toBe('https://canvas.test/drawing/a');
    expect(readEmbeddedUrl('https://canvas.test/canvas.html', policy)).toBe('https://canvas.test/canvas.html');
    for (const url of ['http://editor.test/workbench/a', 'https://mail.test/workbench/a', 'https://evil.test/workbench/a', 'https://user:secret@editor.test/workbench/a', 'https://editor.test/settings', 'https://editor.test/workbench/../settings', 'https://editor.test/workbench/%2fsettings']) {
      expect(() => readEmbeddedUrl(url, policy)).toThrow();
    }
    expect(() => readEmbeddedUrl(launch.url, { ...policy, framePaths: [] })).toThrow();
  });

  it('forwards opaque JSON only from the actual frame, exact origin and fresh channel', async () => {
    const controller = createEmbeddedViewController(() => 'account-a');
    const scope = owner();
    const opened = controller.open(scope, launch, policy);
    const postMessage = vi.fn();
    const frame = { postMessage } as unknown as Window;
    controller.bindFrame(frame);
    expect(await controller.handle(scope, { action: 'next', id: opened.id })).toEqual({ type: 'loaded' });
    const initial = postMessage.mock.calls[0][0];
    const message = (overrides: Record<string, unknown> = {}) => ({ source: frame, origin: 'https://editor.test', data: { source: 'bulwark-embedded-view', id: opened.id, channel: initial.channel, payload: { providerStatus: 'saved' } }, ...overrides }) as MessageEvent;
    controller.receive(message({ origin: 'https://evil.test' }));
    controller.receive(message({ source: {} }));
    controller.receive(message({ data: { ...initial, source: 'bulwark-embedded-view', channel: 'old', payload: 1 } }));
    controller.receive(message());
    expect(await controller.handle(scope, { action: 'next', id: opened.id })).toEqual({ type: 'message', data: { providerStatus: 'saved' } });
    expect(controller.store.getState()).not.toHaveProperty('savedAt');
    await controller.handle(scope, { action: 'post', id: opened.id, data: { command: 'provider-owned' } });
    expect(postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ payload: { command: 'provider-owned' }, channel: initial.channel }), 'https://editor.test');
    controller.bindFrame(frame);
    expect(postMessage.mock.calls.at(-1)?.[0].channel).not.toBe(initial.channel);
    controller.dispose();
  });

  it('binds handles to the precise caller and account, including in-flight event waits', async () => {
    let account = 'account-a';
    const controller = createEmbeddedViewController(() => account);
    const abort = new AbortController();
    const scope = owner(abort);
    const opened = controller.open(scope, launch, policy);
    expect(() => controller.handle(owner(), { action: 'close', id: opened.id })).toThrow(/owner/);
    const waiting = controller.handle(scope, { action: 'next', id: opened.id });
    abort.abort();
    expect(await waiting).toBeNull();
    expect(controller.store.getState().view).toBeNull();
    const second = owner();
    const next = controller.open(second, launch, policy);
    account = 'account-b';
    expect(() => controller.handle(second, { action: 'post', id: next.id, data: 'late' })).toThrow(/account/);
    expect(controller.store.getState().view).toBeNull();
  });

  it('keeps the plugin alive after detaching the external frame and waits for its leave decision', async () => {
    const controller = createEmbeddedViewController(() => 'account-a', { leaveMs: 50 });
    const scope = owner();
    const opened = controller.open(scope, launch, policy);
    const first = controller.leave('account-switch');
    const event = await controller.handle(scope, { action: 'next', id: opened.id });
    expect(event).toMatchObject({ type: 'leave', reason: 'account-switch' });
    if (event?.type !== 'leave') throw new Error('leave event missing');
    controller.handle(scope, { action: 'reply', id: opened.id, requestId: event.requestId, allow: false });
    expect(await first).toBe(false);
    expect(controller.store.getState().view).not.toBeNull();
    const second = controller.leave('navigation');
    const request = await controller.handle(scope, { action: 'next', id: opened.id });
    if (request?.type !== 'leave') throw new Error('leave event missing');
    controller.handle(scope, { action: 'update', id: opened.id, detached: true, preventUnload: true });
    expect(controller.store.getState()).toMatchObject({ detached: true, preventUnload: true });
    controller.handle(scope, { action: 'reply', id: opened.id, requestId: request.requestId, allow: true });
    expect(await second).toBe(true);
    expect(controller.store.getState().view).toBeNull();
  });

  it('bounds waits and message size, and leaves a timed-out plugin with a host-owned escape', async () => {
    const controller = createEmbeddedViewController(() => 'a', { waitMs: 1, leaveMs: 2 });
    const scope = owner();
    const opened = controller.open(scope, launch, policy);
    expect(await controller.handle(scope, { action: 'next', id: opened.id })).toEqual({ type: 'idle' });
    expect(() => controller.handle(scope, { action: 'post', id: opened.id, data: 'x'.repeat(65537) })).toThrow(/size/);
    expect(await controller.leave('close')).toBe(false);
    expect(controller.store.getState().leaveFailed).toBe(true);
    controller.dispose();
    expect(controller.store.getState().view).toBeNull();
  });
});
