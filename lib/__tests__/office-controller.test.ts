import { describe, expect, it, vi } from 'vitest';
import { createOfficeController } from '../office/controller';
import { readDocument } from '../office/contracts';

const document = { sessionId: 'session-a', state: 'editing', savedAt: null, saveRequestId: null, fileName: 'Sales.xlsx', editorUrl: `https://editor.test/api/v1/eurooffice/embed/session-a#${'a'.repeat(43)}` };
const input = { fileId: 'file-a', pluginId: 'office', hostOrigin: 'https://mail.test', allowedOrigins: ['https://editor.test'] };
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

describe('host-owned Office editor', () => {
  it('refuses same-origin, unapproved, credentialed and redirected-path frames', () => {
    for (const editorUrl of [document.editorUrl.replace('editor.test', 'mail.test'), document.editorUrl.replace('editor.test', 'evil.test'), document.editorUrl.replace('editor.test', 'user:secret@editor.test'), document.editorUrl.replace('/embed/session-a', '/settings')]) {
      expect(() => readDocument({ ...document, editorUrl }, input.hostOrigin, input.allowedOrigins, 'nonce')).toThrow();
    }
  });
  it('keeps the caller pending, checks the real frame, origin and channel, and waits for the exact save receipt', async () => {
    let ended = false;
    const request = vi.fn(async (command) => {
      if (command.action === 'session.end') { ended = true; return {}; }
      if (command.action === 'session.open') return document;
      if (command.action === 'session.save') return { requested: true, requestId: 'save-a' };
      if (command.action === 'session.status') return { ...document, state: ended ? 'closed' : 'saved', savedAt: new Date().toISOString(), saveRequestId: 'save-a' };
      return {};
    });
    const controller = createOfficeController(() => 'account-a', { pollMs: 1, timeoutMs: 50 });
    const result = controller.open({ ...input, request });
    await tick();
    expect(controller.store.getState().phase).toBe('loading');
    const frame = {} as Window;
    const message = (event: string, origin = 'https://editor.test', channel = controller.store.getState().channel) => ({ origin, source: frame, data: { source: 'bulwark-eurooffice', sessionId: document.sessionId, channel, event } }) as MessageEvent;
    controller.receive(message('dirty', 'https://evil.test'), frame);
    controller.receive(message('dirty', 'https://editor.test', 'old-instance'), frame);
    expect(controller.store.getState().dirty).toBe(false);
    controller.receive(message('ready'), frame);
    controller.receive(message('dirty'), frame);
    expect(await controller.close(() => false)).toBe(false);
    expect(controller.store.getState().dirty).toBe(true);
    expect(await controller.close(() => true)).toBe(true);
    const receipt = await result;
    expect(receipt).toMatchObject({ state: 'closed', saveRequestId: 'save-a' });
    expect(receipt).not.toHaveProperty('editorUrl');
    expect(receipt).not.toHaveProperty('fileName');
    expect(request.mock.calls.filter(([command]) => command.action === 'session.save')).toHaveLength(1);
  });
  it('never treats an older receipt or an editor saved message as the requested native commit', async () => {
    const request = vi.fn(async command => {
      if (command.action === 'session.open') return document;
      if (command.action === 'session.save') return { requested: true, requestId: 'new-save' };
      return { ...document, state: 'saved', savedAt: new Date().toISOString(), saveRequestId: 'old-save' };
    });
    const controller = createOfficeController(() => 'a', { pollMs: 1, timeoutMs: 10 });
    const result = controller.open({ ...input, request }).catch(() => null);
    await tick();
    const frame = {} as Window;
    const send = (event: string) => controller.receive({ source: frame, origin: 'https://editor.test', data: { source: 'bulwark-eurooffice', sessionId: document.sessionId, channel: controller.store.getState().channel, event } } as MessageEvent, frame);
    send('ready'); send('dirty'); send('saved');
    expect(await controller.save()).toBe(false);
    expect(controller.store.getState().dirty).toBe(true);
    expect(controller.store.getState().document?.savedAt).toBeNull();
    controller.dispose();
    await result;
  });
  it('does not mount a delayed session after the active account changes', async () => {
    let owner = 'a';
    let resolve!: (value: unknown) => void;
    const controller = createOfficeController(() => owner);
    const result = controller.open({ ...input, request: () => new Promise(done => { resolve = done; }) }).catch(() => null);
    owner = 'b'; resolve(document);
    await tick();
    expect(controller.store.getState().document).toBeNull();
    controller.dispose(); await result;
  });
});
