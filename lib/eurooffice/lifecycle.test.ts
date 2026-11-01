import { afterEach, expect, it, vi } from 'vitest';
import { registerOfficeFrame, leaveOfficeViews, disposeOfficeViews } from './lifecycle';

afterEach(() => { disposeOfficeViews(); vi.restoreAllMocks(); document.body.innerHTML = ''; });

it('requires the exact frame, origin and request ID to acknowledge a final close', async () => {
  const iframe = document.createElement('iframe');
  document.body.append(iframe);
  const peer = iframe.contentWindow!;
  const send = vi.spyOn(peer, 'postMessage').mockImplementation(() => {});
  const unregister = registerOfficeFrame(peer);
  window.dispatchEvent(new MessageEvent('message', { source: peer, origin: location.origin, data: { source: 'office-app', event: 'ready' } }));
  const closing = leaveOfficeViews('account-switch');
  const request = send.mock.calls[0][0] as { requestId: string };
  let resolved = false;
  void closing.then(() => { resolved = true; });
  window.dispatchEvent(new MessageEvent('message', { source: window, origin: location.origin, data: { source: 'office-app', event: 'leave-result', requestId: request.requestId, canLeave: true } }));
  await Promise.resolve();
  expect(resolved).toBe(false);
  window.dispatchEvent(new MessageEvent('message', { source: peer, origin: location.origin, data: { source: 'office-app', event: 'leave-result', requestId: request.requestId, canLeave: false } }));
  expect(await closing).toBe(false);
  unregister();
});

it('does not require a save from an inert frame that has not completed initialization', async () => {
  const iframe = document.createElement('iframe');
  document.body.append(iframe);
  const unregister = registerOfficeFrame(iframe.contentWindow!);
  expect(await leaveOfficeViews('logout')).toBe(true);
  unregister();
});
