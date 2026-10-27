import { describe, expect, it, vi } from 'vitest';
import { createEmbeddedViewController } from '../plugin-embedded/controller';
import { frameJson, readEmbeddedUrl, type EmbeddedViewOwner } from '../plugin-embedded/contracts';

const policy = { hostOrigin: 'https://mail.test', frameOrigins: ['https://canvas.test', 'https://form.test'], framePaths: ['/workspace/', '/canvas.html'] };
const launch = { action: 'open' as const, url: 'https://canvas.test/canvas.html#example', title: 'Canvas' };
const owner = (abort = new AbortController()): EmbeddedViewOwner => ({ slot: 'app-page', signal: abort.signal, container: document.createElement('div') });

function frameMessage(frame: Window, initial: { id: string; channel: string }, payload: unknown, overrides: Record<string, unknown> = {}) {
  return { source: frame, origin: 'https://canvas.test', data: { source: 'bulwark-embedded-view', ...initial, payload }, ...overrides } as MessageEvent;
}

describe('embedded view platform boundary', () => {
  it('uses declared HTTPS origins and launch paths rather than a provider protocol', () => {
    expect(readEmbeddedUrl(launch.url, policy)).toBe(launch.url);
    expect(readEmbeddedUrl('https://form.test/workspace/a', policy)).toBe('https://form.test/workspace/a');
    for (const url of ['http://canvas.test/canvas.html', 'https://mail.test/canvas.html', 'https://other.test/canvas.html', 'https://user:secret@canvas.test/canvas.html', 'https://canvas.test/other', 'https://canvas.test/workspace/../other', 'https://canvas.test/workspace/%2fother']) {
      expect(() => readEmbeddedUrl(url, policy)).toThrow();
    }
    expect(() => readEmbeddedUrl(launch.url, { ...policy, framePaths: [] })).toThrow();
    expect(() => readEmbeddedUrl(launch.url, { ...policy, frameOrigins: ['https://*.test'] })).toThrow();
  });

  it('delivers opaque JSON only from the expected window, origin, handle and channel', async () => {
    const controller = createEmbeddedViewController(() => 'account-a');
    const scope = owner();
    const opened = controller.open(scope, launch, policy);
    const postMessage = vi.fn();
    const frame = { postMessage } as unknown as Window;
    controller.bindFrame(frame);
    expect(await controller.handle(scope, { action: 'next', id: opened.id })).toEqual({ type: 'loaded' });
    const initial = { id: opened.id, channel: postMessage.mock.calls[0][0].channel };
    const payload = { example: [1, 'two', null] };
    controller.receive(frameMessage(frame, initial, payload, { origin: 'https://other.test' }));
    controller.receive(frameMessage(frame, initial, payload, { source: {} }));
    controller.receive(frameMessage(frame, { ...initial, channel: 'stale' }, payload));
    controller.receive(frameMessage(frame, initial, payload));
    expect(await controller.handle(scope, { action: 'next', id: opened.id })).toEqual({ type: 'message', data: payload });
    controller.handle(scope, { action: 'post', id: opened.id, data: [true, 'sample'] });
    expect(postMessage).toHaveBeenLastCalledWith({ source: 'bulwark-embedded-host', type: 'message', ...initial, payload: [true, 'sample'] }, 'https://canvas.test');
    controller.dispose();
  });

  it('does not transfer a channel to a reloaded or navigated document in the same WindowProxy', async () => {
    const controller = createEmbeddedViewController(() => 'a');
    const scope = owner();
    const opened = controller.open(scope, launch, policy);
    const postMessage = vi.fn();
    const frame = { postMessage } as unknown as Window;
    controller.bindFrame(frame);
    await controller.handle(scope, { action: 'next', id: opened.id });
    const waiting = controller.handle(scope, { action: 'next', id: opened.id });
    controller.bindFrame(frame);
    expect(await waiting).toBeNull();
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(controller.store.getState().view).toBeNull();
    expect(() => controller.handle(scope, { action: 'post', id: opened.id, data: 'late' })).toThrow();
  });

  it('reports a bounded data gap and never lets frame traffic evict a leave request', async () => {
    const controller = createEmbeddedViewController(() => 'a');
    const scope = owner();
    const opened = controller.open(scope, launch, policy);
    const postMessage = vi.fn();
    const frame = { postMessage } as unknown as Window;
    controller.bindFrame(frame);
    const initial = { id: opened.id, channel: postMessage.mock.calls[0][0].channel };
    const leaving = controller.leave('navigation');
    for (let value = 0; value < 40; value++) controller.receive(frameMessage(frame, initial, value));
    expect(await controller.handle(scope, { action: 'next', id: opened.id })).toEqual({ type: 'loaded' });
    const event = await controller.handle(scope, { action: 'next', id: opened.id });
    if (event?.type !== 'leave') throw new Error('leave event missing');
    controller.handle(scope, { action: 'reply', id: opened.id, requestId: event.requestId, allow: false });
    expect(await leaving).toBe(false);
    expect(await controller.handle(scope, { action: 'next', id: opened.id })).toEqual({ type: 'overflow', dropped: 24 });
    controller.dispose();
  });

  it('pins handles to their caller and account, and aborts pending waits on teardown', async () => {
    let account = 'a';
    const controller = createEmbeddedViewController(() => account);
    const abort = new AbortController();
    const scope = owner(abort);
    const opened = controller.open(scope, launch, policy);
    expect(() => controller.handle(owner(), { action: 'close', id: opened.id })).toThrow(/owner/);
    const waiting = controller.handle(scope, { action: 'next', id: opened.id });
    abort.abort();
    expect(await waiting).toBeNull();
    const nextScope = owner();
    const next = controller.open(nextScope, launch, policy);
    account = 'b';
    expect(() => controller.handle(nextScope, { action: 'next', id: next.id })).toThrow(/account/);
    expect(controller.store.getState().view).toBeNull();
  });

  it('bounds leave acknowledgement and discards expired control requests', async () => {
    const controller = createEmbeddedViewController(() => 'a', { leaveMs: 2, waitMs: 1 });
    const scope = owner();
    const opened = controller.open(scope, launch, policy);
    expect(await controller.leave('close')).toBe(false);
    expect(controller.store.getState().leaveFailed).toBe(true);
    expect(await controller.handle(scope, { action: 'next', id: opened.id })).toEqual({ type: 'idle' });
    controller.dispose();
  });

  it('retains the caller while a frame is detached and acknowledges only the matching leave request', async () => {
    const controller = createEmbeddedViewController(() => 'a');
    const scope = owner();
    const opened = controller.open(scope, launch, policy);
    const leaving = controller.leave('account-switch');
    const event = await controller.handle(scope, { action: 'next', id: opened.id });
    if (event?.type !== 'leave') throw new Error('leave event missing');
    expect(() => controller.handle(scope, { action: 'reply', id: opened.id, requestId: 'wrong', allow: true })).toThrow();
    controller.handle(scope, { action: 'update', id: opened.id, detached: true, preventUnload: true });
    expect(controller.store.getState()).toMatchObject({ detached: true, preventUnload: true });
    controller.handle(scope, { action: 'reply', id: opened.id, requestId: event.requestId, allow: true });
    expect(await leaving).toBe(true);
    expect(controller.handle(scope, { action: 'close', id: opened.id })).toEqual({ type: 'ok' });
  });

  it('rejects oversized and non-JSON payloads before retaining them', () => {
    expect(() => frameJson('x'.repeat(65_537))).toThrow();
    expect(() => frameJson({ value: Infinity })).toThrow();
    expect(() => frameJson({ value: undefined })).toThrow();
    expect(() => frameJson({ value: BigInt(1) })).toThrow();
  });
});
