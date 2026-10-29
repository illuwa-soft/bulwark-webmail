import { createStore } from 'zustand/vanilla';
import { frameJson, readEmbeddedUrl, type EmbeddedViewCommand, type EmbeddedViewEvent, type EmbeddedViewOwner, type FramePolicy, type LeaveReason } from './contracts';

type View = { id: string; url: string; title: string };
type State = { view: View | null; detached: boolean; preventUnload: boolean; leaveFailed: boolean };
const initial: State = { view: null, detached: false, preventUnload: false, leaveFailed: false };

/** Own only frame authority and lifecycle. Provider messages remain opaque JSON.
 * 프레임 권한·수명만 소유하고 제공자 메시지는 불투명한 JSON으로 유지합니다. */
export function createEmbeddedViewController(identity: () => string, options: { waitMs?: number; leaveMs?: number } = {}) {
  const store = createStore<State>()(() => ({ ...initial }));
  let owner: EmbeddedViewOwner | null = null;
  let account = '';
  let id = '';
  let frame: Window | null = null;
  let channel = '';
  let removeAbort: (() => void) | null = null;
  const queue: EmbeddedViewEvent[] = [];
  let waiting: ((event: EmbeddedViewEvent | null) => void) | null = null;
  let pendingLeave: { requestId: string; promise: Promise<boolean>; resolve(value: boolean): void } | null = null;

  const finishWait = (event: EmbeddedViewEvent | null) => { const done = waiting; waiting = null; done?.(event); };
  const enqueue = (event: EmbeddedViewEvent) => {
    if (waiting) { finishWait(event); return; }
    if (queue.length >= 16) queue.shift();
    queue.push(event);
  };
  const dispose = () => {
    removeAbort?.(); removeAbort = null;
    frame = null; channel = '';
    queue.length = 0;
    finishWait(null);
    pendingLeave?.resolve(false); pendingLeave = null;
    store.setState({ ...initial });
  };
  const assertOwner = (scope: EmbeddedViewOwner, requestedId: string) => {
    if (owner !== scope || requestedId !== id) throw new Error('Embedded view owner changed');
    if (account !== identity() || scope.signal.aborted) { dispose(); throw new Error('Embedded view account changed'); }
  };
  const open = (scope: EmbeddedViewOwner, input: Extract<EmbeddedViewCommand, { action: 'open' }>, policy: FramePolicy) => {
    if (!['app-page', 'file-editor'].includes(scope.slot ?? '') || scope.signal.aborted) throw new Error('Embedded views require a live app-page or file-editor instance');
    if (store.getState().view) throw new Error('An embedded view is already open');
    const url = readEmbeddedUrl(input.url, policy);
    account = identity();
    if (!account) throw new Error('Embedded views require an active account');
    owner = scope; id = crypto.randomUUID();
    scope.signal.addEventListener('abort', dispose, { once: true });
    removeAbort = () => scope.signal.removeEventListener('abort', dispose);
    store.setState({ view: { id, url, title: input.title }, detached: false, preventUnload: true, leaveFailed: false });
    return { id };
  };
  const bindFrame = (value: Window | null) => {
    const view = store.getState().view;
    if (!value || !view || store.getState().detached) return;
    frame = value; channel = crypto.randomUUID(); queue.length = 0;
    frame.postMessage({ source: 'bulwark-embedded-host', type: 'init', id, channel }, new URL(view.url).origin);
    enqueue({ type: 'loaded' });
  };
  const receive = (event: MessageEvent) => {
    const view = store.getState().view;
    if (!view || !frame || event.source !== frame || event.origin !== new URL(view.url).origin || account !== identity()) return;
    const data = event.data;
    if (!data || data.source !== 'bulwark-embedded-view' || data.id !== id || data.channel !== channel) return;
    try { enqueue({ type: 'message', data: frameJson(data.payload) }); } catch { /* malformed or oversized frame payload */ }
  };
  const next = () => {
    if (!store.getState().view) return Promise.resolve(null);
    if (queue.length) return Promise.resolve(queue.shift()!);
    if (waiting) throw new Error('An embedded event wait is already pending');
    return new Promise<EmbeddedViewEvent | null>(resolve => {
      const timer = setTimeout(() => finishWait({ type: 'idle' }), options.waitMs ?? 20_000);
      waiting = event => { clearTimeout(timer); resolve(event); };
    });
  };
  const reply = (requestId: string, allow: boolean) => {
    if (!pendingLeave || pendingLeave.requestId !== requestId) throw new Error('Leave request changed');
    const pending = pendingLeave; pendingLeave = null;
    // An explicit refusal keeps editing; the timeout alone exposes host-owned recovery.
    // 명시적인 이탈 거절은 편집을 유지하고 응답 시간 초과만 호스트 복구를 표시합니다.
    store.setState({ leaveFailed: false });
    pending.resolve(allow);
    if (allow) dispose();
  };
  const leave = (reason: LeaveReason): Promise<boolean> => {
    if (!store.getState().view) return Promise.resolve(true);
    if (pendingLeave) return pendingLeave.promise;
    store.setState({ leaveFailed: false });
    const requestId = crypto.randomUUID();
    let resolve!: (value: boolean) => void;
    const promise = new Promise<boolean>(done => { resolve = done; });
    const timer = setTimeout(() => {
      if (pendingLeave?.requestId !== requestId) return;
      pendingLeave = null; store.setState({ leaveFailed: true }); resolve(false);
    }, options.leaveMs ?? 180_000);
    pendingLeave = { requestId, promise, resolve: value => { clearTimeout(timer); resolve(value); } };
    enqueue({ type: 'leave', requestId, reason });
    return promise;
  };
  const handle = (scope: EmbeddedViewOwner, command: Exclude<EmbeddedViewCommand, { action: 'open' }>): EmbeddedViewEvent | null | { type: 'ok' } | Promise<EmbeddedViewEvent | null> => {
    assertOwner(scope, command.id);
    if (command.action === 'next') return next();
    if (command.action === 'close' && !store.getState().view) return { type: 'ok' };
    if (!store.getState().view) throw new Error('Embedded view is closed');
    if (command.action === 'close') {
      const pending = pendingLeave; pendingLeave = null;
      pending?.resolve(true); dispose();
    }
    if (command.action === 'reply') reply(command.requestId, command.allow);
    if (command.action === 'update') {
      const patch = { ...store.getState() };
      if (command.detached !== undefined) { patch.detached = command.detached; if (command.detached) frame = null; }
      if (command.preventUnload !== undefined) patch.preventUnload = command.preventUnload;
      store.setState(patch);
    }
    if (command.action === 'post') {
      const payload = frameJson(command.data);
      if (!frame || !channel) throw new Error('Embedded frame is not ready');
      frame.postMessage({ source: 'bulwark-embedded-host', type: 'message', id, channel, payload }, new URL(store.getState().view!.url).origin);
    }
    return { type: 'ok' };
  };
  return { store, open, bindFrame, receive, handle, leave, dispose };
}
export type EmbeddedViewController = ReturnType<typeof createEmbeddedViewController>;
