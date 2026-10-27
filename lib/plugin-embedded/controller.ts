import { createStore } from 'zustand/vanilla';
import { frameJson, readEmbeddedUrl, type EmbeddedViewCommand, type EmbeddedViewEvent, type EmbeddedViewOwner, type FramePolicy, type LeaveReason } from './contracts';

type View = { id: string; url: string; title: string };
type State = { view: View | null; detached: boolean; preventUnload: boolean; leaveFailed: boolean };
type Control = Extract<EmbeddedViewEvent, { type: 'loaded' | 'leave' }>;
const initial: State = { view: null, detached: false, preventUnload: false, leaveFailed: false };

/** Frame authority and lifecycle only. Payloads have no application meaning here. */
export function createEmbeddedViewController(identity: () => string, options: { waitMs?: number; leaveMs?: number } = {}) {
  const store = createStore<State>()(() => ({ ...initial }));
  let owner: EmbeddedViewOwner | null = null;
  let account = '';
  let id = '';
  let frame: Window | null = null;
  let channel = '';
  let bound = false;
  let removeAbort: (() => void) | null = null;
  let controls: Control[] = [];
  const messages: Extract<EmbeddedViewEvent, { type: 'message' }>[] = [];
  let dropped = 0;
  let waiting: ((event: EmbeddedViewEvent | null) => void) | null = null;
  let pendingLeave: { requestId: string; promise: Promise<boolean>; resolve(value: boolean): void } | null = null;

  const finishWait = (event: EmbeddedViewEvent | null) => {
    const done = waiting;
    waiting = null;
    done?.(event);
  };
  const takeEvent = (): EmbeddedViewEvent | null => {
    const control = controls.shift();
    if (control) return control;
    if (dropped) {
      const count = dropped;
      dropped = 0;
      return { type: 'overflow', dropped: count };
    }
    return messages.shift() ?? null;
  };
  const wake = () => {
    if (!waiting) return;
    const event = takeEvent();
    if (event) finishWait(event);
  };
  const finishLeave = (allow: boolean, failed = false) => {
    const pending = pendingLeave;
    if (!pending) return;
    pendingLeave = null;
    controls = controls.filter(event => event.type !== 'leave' || event.requestId !== pending.requestId);
    store.setState({ leaveFailed: failed });
    pending.resolve(allow);
  };
  const dispose = () => {
    removeAbort?.(); removeAbort = null;
    frame = null; channel = ''; bound = false;
    controls = []; messages.length = 0; dropped = 0;
    finishWait(null);
    finishLeave(false);
    store.setState({ ...initial });
  };
  const assertOwner = (scope: EmbeddedViewOwner, requestedId: string) => {
    if (owner !== scope || requestedId !== id) throw new Error('Embedded view owner changed');
    if (account !== identity() || scope.signal.aborted) { dispose(); throw new Error('Embedded view account changed'); }
  };
  const open = (scope: EmbeddedViewOwner, input: Extract<EmbeddedViewCommand, { action: 'open' }>, policy: FramePolicy) => {
    if (scope.slot !== 'app-page' || scope.signal.aborted) throw new Error('Embedded views require a live app-page instance');
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
    // WindowProxy identity survives navigation. A new document must request a new view.
    if (bound) { dispose(); return; }
    bound = true; frame = value; channel = crypto.randomUUID();
    frame.postMessage({ source: 'bulwark-embedded-host', type: 'init', id, channel }, new URL(view.url).origin);
    controls.push({ type: 'loaded' });
    wake();
  };
  const receive = (event: MessageEvent) => {
    const view = store.getState().view;
    if (!view || !frame || event.source !== frame || event.origin !== new URL(view.url).origin || account !== identity()) return;
    const data = event.data;
    if (!data || data.source !== 'bulwark-embedded-view' || data.id !== id || data.channel !== channel) return;
    try {
      const payload = frameJson(data.payload);
      if (messages.length >= 16) { messages.shift(); dropped++; }
      messages.push({ type: 'message', data: payload });
      wake();
    } catch { /* malformed or oversized frame payload */ }
  };
  const next = () => {
    if (!store.getState().view) return Promise.resolve(null);
    if (waiting) throw new Error('An embedded event wait is already pending');
    const event = takeEvent();
    if (event) return Promise.resolve(event);
    return new Promise<EmbeddedViewEvent | null>(resolve => {
      const timer = setTimeout(() => finishWait({ type: 'idle' }), options.waitMs ?? 20_000);
      waiting = value => { clearTimeout(timer); resolve(value); };
    });
  };
  const leave = (reason: LeaveReason): Promise<boolean> => {
    if (!store.getState().view) return Promise.resolve(true);
    if (pendingLeave) return pendingLeave.promise;
    store.setState({ leaveFailed: false });
    const requestId = crypto.randomUUID();
    let resolve!: (value: boolean) => void;
    const promise = new Promise<boolean>(done => { resolve = done; });
    const timer = setTimeout(() => {
      if (pendingLeave?.requestId === requestId) finishLeave(false, true);
    }, options.leaveMs ?? 180_000);
    pendingLeave = { requestId, promise, resolve: value => { clearTimeout(timer); resolve(value); } };
    controls.push({ type: 'leave', requestId, reason });
    wake();
    return promise;
  };
  const handle = (scope: EmbeddedViewOwner, command: Exclude<EmbeddedViewCommand, { action: 'open' }>): EmbeddedViewEvent | null | { type: 'ok' } | Promise<EmbeddedViewEvent | null> => {
    assertOwner(scope, command.id);
    if (command.action === 'next') return next();
    if (command.action === 'close' && !store.getState().view) return { type: 'ok' };
    if (!store.getState().view) throw new Error('Embedded view is closed');
    if (command.action === 'close') { finishLeave(true); dispose(); }
    if (command.action === 'reply') {
      if (!pendingLeave || pendingLeave.requestId !== command.requestId) throw new Error('Leave request changed');
      finishLeave(command.allow, !command.allow);
      if (command.allow) dispose();
    }
    if (command.action === 'update') {
      const patch = { ...store.getState() };
      if (command.detached) { patch.detached = true; frame = null; }
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
