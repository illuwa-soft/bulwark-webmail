import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { usePluginFileEditor } from '@/hooks/use-plugin-file-editor';
import { PluginFileEditor } from '@/components/files/plugin-file-editor';
import { resetActions, setPluginActions } from '@/lib/plugin-sandbox/actions';
import { useFileStore, type FileResource } from '@/stores/file-store';

const initial = useFileStore.getState();
const notes = {
  id: 'note', name: 'guide.md', serverName: 'guide.md', isDirectory: false,
  contentType: 'text/markdown', contentLength: 128, lastModified: '2026-10-28T00:00:00Z',
  blobId: 'private-note-blob', parentId: null, ownerAccountId: 'native-account',
} satisfies FileResource;
const drawing = { ...notes, id: 'native-account:scene', name: 'scene.mesh', serverName: 'scene.mesh', contentType: 'application/octet-stream' } satisfies FileResource;

afterEach(() => {
  cleanup();
  resetActions();
  useFileStore.setState(initial, true);
});

describe('provider-neutral file workspaces', () => {
  it('hosts a Markdown reader and a CAD workspace without assuming a native mutation on close', async () => {
    let reads = 0;
    useFileStore.setState({ client: null, resources: [notes, drawing], refresh: async () => { reads++; } });
    setPluginActions('reader', 'Markdown reader', 'file-open-actions', [{ id: 'read', label: 'Read', fileExtensions: ['md'] }]);
    setPluginActions('cad', 'CAD', 'file-open-actions', [{ id: 'draw', label: 'Draw', fileExtensions: ['mesh'] }]);
    const { result } = renderHook(() => usePluginFileEditor('login-a'));

    act(() => { expect(result.current.open(notes.name)).toBe(true); });
    expect(result.current.target).toMatchObject({ pluginId: 'reader', accountId: 'native-account', file: { id: 'note', name: notes.name } });
    expect(result.current.target?.file).not.toHaveProperty('blobId');
    await act(async () => { await result.current.close(); });
    expect(result.current.target).toBeNull();
    expect(reads).toBe(0);

    act(() => { expect(result.current.open(drawing.name, 'cad')).toBe(true); });
    expect(result.current.target).toMatchObject({ pluginId: 'cad', accountId: 'native-account', file: { id: 'scene' } });
    await act(async () => { await result.current.close(); });
    expect(reads).toBe(0);
  });

  it('revokes the selected workspace on an account change or provider removal', () => {
    useFileStore.setState({ client: null, resources: [notes] });
    setPluginActions('reader', 'Reader', 'file-open-actions', [{ id: 'read', label: 'Read', fileExtensions: ['md'] }]);
    const { result, rerender } = renderHook(({ owner }) => usePluginFileEditor(owner), { initialProps: { owner: 'login-a' } });
    act(() => { result.current.open(notes.name); });
    rerender({ owner: 'login-b' });
    expect(result.current.target).toBeNull();
    act(() => { result.current.open(notes.name); });
    expect(result.current.target?.pluginId).toBe('reader');
    act(resetActions);
    expect(result.current.target).toBeNull();
  });

  it('uses a generic host close control for a non-Office provider', async () => {
    let closed = false;
    render(<PluginFileEditor target={{ pluginId: 'reader', ownerId: 'login-a', accountId: 'native-account', file: { id: 'note', name: notes.name, type: 'file', size: 128, mimeType: 'text/markdown', path: '/', modified: notes.lastModified } }} onClose={async () => { closed = true; }} />);
    const close = screen.getByRole('button', { name: /^close$/ });
    await act(async () => { fireEvent.click(close); });
    expect(closed).toBe(true);
  });
});
