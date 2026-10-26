import { createStore } from 'zustand/vanilla';
import { object, readDocument, readReceipt, type OfficeDocument, type OfficeReceipt, type OfficeRequest } from './contracts';
import { officeMessages } from './messages';

export type OfficeState = {
  phase: 'idle' | 'opening' | 'loading' | 'ready' | 'saving' | 'closing' | 'error';
  document: OfficeDocument | null;
  ready: boolean;
  dirty: boolean;
  generation: number;
  channel: string;
  error: string | null;
  detached: boolean;
};
export type OpenOffice = {
  fileId: string;
  pluginId: string;
  hostOrigin: string;
  allowedOrigins: readonly string[];
  request: OfficeRequest;
};
const initial: OfficeState = { phase: 'idle', document: null, ready: false, dirty: false, generation: 0, channel: '', error: null, detached: false };

/** Own one editor per app page, preserving the plugin slot while its promise waits for close.
 * 문서함 플러그인을 유지하고 닫기 결과를 기다리며 앱 페이지당 편집기 하나를 소유합니다. */
export function createOfficeController(identity: () => string, options: { pollMs?: number; timeoutMs?: number; locale?: string } = {}) {
  const messages = officeMessages(options.locale);
  const store = createStore<OfficeState>()(() => ({ ...initial }));
  let request: OfficeRequest | null = null;
  let owner = '';
  let epoch = 0;
  let finish: ((receipt: OfficeReceipt | null) => void) | null = null;
  let reject: ((error: Error) => void) | null = null;
  let saving: Promise<boolean> | null = null;
  let closing: Promise<boolean> | null = null;
  let pendingSaveId: string | null = null;
  let pendingGeneration = 0;
  const current = () => identity() === owner;
  const error = (message: string) => store.setState({ phase: 'error', ready: false, error: message });

  const reset = () => {
    epoch++;
    request = null;
    pendingSaveId = null;
    store.setState({ ...initial });
    finish = null;
    reject = null;
  };

  const open = (input: OpenOffice): Promise<OfficeReceipt | null> => {
    if (store.getState().phase !== 'idle') return Promise.reject(new Error('An Office document is already open'));
    if (!input.fileId || input.fileId.length > 256) return Promise.reject(new Error('Invalid Office file'));
    owner = identity();
    if (!owner) return Promise.reject(new Error('Office requires an active account'));
    const attempt = ++epoch;
    request = input.request;
    store.setState({ phase: 'opening', error: null });
    return new Promise((resolve, rejectOpen) => {
      finish = resolve;
      reject = rejectOpen;
      void input.request({ action: 'session.open', fileId: input.fileId }).then(value => {
        if (attempt !== epoch) return;
        if (!current()) throw new Error('Office account changed');
        const channel = crypto.randomUUID();
        const document = readDocument(value, input.hostOrigin, input.allowedOrigins, channel);
        store.setState({ document, channel, phase: 'loading' });
      }).catch(() => {
        if (attempt === epoch) error(messages.openError);
      });
    });
  };

  const receive = (event: MessageEvent, frame: Window | null) => {
    const state = store.getState();
    if (!current() || state.detached || !frame || !state.document || event.source !== frame) return;
    if (event.origin !== new URL(state.document.editorUrl).origin) return;
    if (!event.data || typeof event.data !== 'object') return;
    const data = event.data;
    if (data.source !== 'bulwark-eurooffice' || data.sessionId !== state.document.sessionId || data.channel !== state.channel) return;
    if (data.event === 'ready' && state.phase !== 'error') store.setState({ phase: 'ready', ready: true, error: null });
    if (data.event === 'dirty') store.setState({ dirty: true, generation: state.generation + 1 });
    if (data.event === 'error') error(messages.editorError);
  };

  const performSave = async () => {
    const state = store.getState();
    const document = state.document;
    const send = request;
    if (!current() || !document || !send || !state.ready) return false;
    const attempt = epoch;
    const generation = state.generation;
    store.setState({ phase: 'saving', error: null });
    try {
      const accepted = object(await send({ action: 'session.save', sessionId: document.sessionId }));
      if (attempt !== epoch || !current()) return false;
      if (accepted.requested !== true || typeof accepted.requestId !== 'string') throw new Error('Save not accepted');
      pendingSaveId = accepted.requestId;
      pendingGeneration = generation;
      const deadline = Date.now() + (options.timeoutMs ?? 90_000);
      while (Date.now() < deadline && attempt === epoch && current()) {
        const receipt = readReceipt(await send({ action: 'session.status', sessionId: document.sessionId }), document.sessionId);
        if (attempt !== epoch || !current()) return false;
        if (receipt.state === 'conflict' || receipt.state === 'uncertain') throw new Error('Save needs reconciliation');
        if (receipt.savedAt && receipt.saveRequestId === accepted.requestId) {
          const dirty = store.getState().generation !== generation;
          store.setState({ document: { ...document, ...receipt }, phase: 'ready', dirty });
          pendingSaveId = null;
          return !dirty;
        }
        await new Promise(resolve => setTimeout(resolve, options.pollMs ?? 1000));
      }
      throw new Error('Save was not confirmed');
    } catch {
      if (attempt === epoch) error(messages.saveError);
      return false;
    }
  };
  const save = () => {
    if (saving) return saving;
    const task = performSave().finally(() => { if (saving === task) saving = null; });
    saving = task;
    return saving;
  };

  const performClose = async (confirm: () => boolean | Promise<boolean>) => {
    const attempt = epoch;
    if (store.getState().phase === 'opening') return false;
    if (saving && !(await saving)) return false;
    if (store.getState().dirty) {
      if (!(await confirm()) || !(await save())) return false;
    }
    const state = store.getState();
    if (attempt !== epoch || !current()) return state.phase === 'idle';
    const send = request;
    if (state.document && send && current()) {
      try {
        store.setState({ phase: 'closing', ready: false, detached: true });
        await send({ action: 'session.end', sessionId: state.document.sessionId });
        if (attempt !== epoch || !current()) return false;
        const deadline = Date.now() + (options.timeoutMs ?? 90_000);
        let closed = false;
        while (Date.now() < deadline && attempt === epoch && current()) {
          const receipt = readReceipt(await send({ action: 'session.status', sessionId: state.document.sessionId }), state.document.sessionId);
          if (attempt !== epoch || !current()) return false;
          if (receipt.state === 'closed') { store.setState({ document: { ...state.document, ...receipt } }); closed = true; break; }
          if (receipt.state === 'conflict' || receipt.state === 'uncertain') throw new Error('Final save needs reconciliation');
          await new Promise(resolve => setTimeout(resolve, options.pollMs ?? 1000));
        }
        if (!closed) throw new Error('Final callback was not confirmed');
      }
      catch { if (attempt === epoch) error(messages.closeError); return false; }
    }
    const resolve = finish;
    const document = store.getState().document;
    let receipt: OfficeReceipt | null = null;
    if (document) receipt = { sessionId: document.sessionId, state: document.state, savedAt: document.savedAt, saveRequestId: document.saveRequestId };
    reset();
    resolve?.(receipt);
    return true;
  };
  const close = (confirm: () => boolean | Promise<boolean>) => {
    if (closing) return closing;
    const task = performClose(confirm).finally(() => { if (closing === task) closing = null; });
    closing = task;
    return closing;
  };

  const dispose = () => {
    const fail = reject;
    reset();
    saving = null;
    closing = null;
    fail?.(new Error('Office host closed'));
  };

  const heartbeat = async () => {
    const attempt = epoch;
    const document = store.getState().document;
    if (!current() || !document || !request || store.getState().phase !== 'ready') return;
    try { readReceipt(await request({ action: 'session.status', sessionId: document.sessionId }), document.sessionId); }
    catch { if (attempt === epoch && current()) error(messages.editorError); }
  };
  const recheck = async () => {
    const attempt = epoch;
    const state = store.getState();
    if (!current() || !state.document || !request) return false;
    try {
      const receipt = readReceipt(await request({ action: 'session.status', sessionId: state.document.sessionId }), state.document.sessionId);
      if (attempt !== epoch || !current() || !receipt.savedAt || !pendingSaveId || receipt.saveRequestId !== pendingSaveId) return false;
      if (receipt.state !== 'saved' && receipt.state !== 'closed') return false;
      store.setState({ document: { ...state.document, ...receipt }, phase: 'ready', ready: !state.detached, dirty: store.getState().generation !== pendingGeneration, error: null });
      pendingSaveId = null;
      return true;
    } catch { return false; }
  };
  const abandon = async (confirm: () => boolean | Promise<boolean>) => {
    const attempt = epoch;
    if (store.getState().phase !== 'error' || !(await confirm())) return false;
    const document = store.getState().document;
    try {
      if (document && request && current()) await request({ action: 'session.end', sessionId: document.sessionId });
      if (attempt !== epoch) return false;
      const resolve = finish;
      reset();
      resolve?.(null);
      return true;
    } catch { if (attempt === epoch) error(messages.closeError); return false; }
  };
  return { store, messages, open, receive, save, close, dispose, heartbeat, recheck, abandon };
}
export type OfficeController = ReturnType<typeof createOfficeController>;
