import { afterEach, describe, expect, it } from 'vitest';
import { checkActions, resetActions, setPluginActions } from '@/lib/plugin-sandbox/actions';
import { findFileEditor, registerFileEditorHost, closeFileEditor } from '@/lib/plugin-sandbox/file-editors';

afterEach(resetActions);

describe('native file editor declarations', () => {
  it('allows closing only from the exact live provider subtree and still awaits the host guard', async () => {
    const root = document.createElement('div');
    const container = document.createElement('div');
    root.append(container);
    const scope = { slot: 'file-editor', container, signal: new AbortController().signal };
    let allowed = false;
    const unregister = registerFileEditorHost({ pluginId: 'office', root, close: async () => allowed });

    try {
      expect(() => closeFileEditor('office', undefined)).toThrow();
      expect(() => closeFileEditor('office', { ...scope, slot: 'background' })).toThrow();
      expect(() => closeFileEditor('foreign', scope)).toThrow();
      expect(() => closeFileEditor('office', { ...scope, container: document.createElement('div') })).toThrow();
      expect(await closeFileEditor('office', scope)).toBe(false);
      allowed = true;
      expect(await closeFileEditor('office', scope)).toBe(true);
      const abort = new AbortController();
      abort.abort();
      expect(() => closeFileEditor('office', { ...scope, signal: abort.signal })).toThrow();
    } finally {
      unregister();
    }
    expect(() => closeFileEditor('office', scope)).toThrow();
  });

  it('matches extensions without relying on a correct MIME type and never intercepts folders', () => {
    setPluginActions('office', 'Office', 'file-open-actions', checkActions([
      { id: 'open', label: 'Open document', fileExtensions: ['docx', 'xlsx', 'pptx', 'pdf'] }
    ]));
    expect(findFileEditor('BUDGET.XLSX', false)?.pluginId).toBe('office');
    expect(findFileEditor('paper.pdf', false)?.pluginId).toBe('office');
    expect(findFileEditor('notes.txt', false)).toBeNull();
    expect(findFileEditor('artwork.ai', false)).toBeNull();
    expect(findFileEditor('folder.xlsx', true)).toBeNull();
    resetActions();
    expect(findFileEditor('paper.pdf', false)).toBeNull();
  });

  it('rejects wildcards, path fragments and unbounded extension claims', () => {
    for (const extensions of [['*'], ['../docx'], ['.pdf'], Array.from({ length: 21 }, () => 'pdf')]) {
      expect(() => checkActions([{ id: 'open', label: 'Open', fileExtensions: extensions }])).toThrow();
    }
  });
});
