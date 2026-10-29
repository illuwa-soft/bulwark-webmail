import { afterEach, describe, expect, it, vi } from 'vitest';
import { actionsFor, checkActions, resetActions, runAction, setFileEditorActions } from '@/lib/plugin-sandbox/actions';

afterEach(resetActions);

/** Models a host-created workspace and its exact live provider frame.
 * 호스트가 만든 작업 영역과 해당 제공자의 활성 프레임을 구성합니다. */
function frame(id: string) {
  const root = document.createElement('section');
  root.dataset.fileEditorInstance = id;
  const container = document.createElement('div');
  root.append(container);
  const abort = new AbortController();
  const invokeAction = vi.fn(async () => {});
  return { owner: { slot: 'file-editor', signal: abort.signal, container, invokeAction }, abort, invokeAction };
}

describe('instance-scoped file editor controls', () => {
  it('keeps two editors of the same provider separate and dispatches only to the declaring frame', async () => {
    const first = frame('first');
    const second = frame('second');
    setFileEditorActions('provider', 'Provider', checkActions([{ id: 'save', label: 'Save' }]), first.owner);
    setFileEditorActions('provider', 'Provider', checkActions([{ id: 'save', label: 'Save second' }]), second.owner);
    expect(actionsFor('file-editor-actions').map(action => action.instanceId).sort()).toEqual(['first', 'second']);
    const action = actionsFor('file-editor-actions').find(item => item.instanceId === 'second')!;
    await runAction(action, 'file-editor-actions', { accountId: 'native', file: { id: 'selected' } });
    expect(second.invokeAction).toHaveBeenCalledWith('file-editor-actions', 'save', { accountId: 'native', file: { id: 'selected' } });
    expect(first.invokeAction).not.toHaveBeenCalled();
    first.abort.abort();
    expect(actionsFor('file-editor-actions').map(item => item.instanceId)).toEqual(['second']);
  });

  it('does not run a disabled, superseded or aborted frame action', async () => {
    const current = frame('current');
    setFileEditorActions('provider', 'Provider', checkActions([{ id: 'save', label: 'Save', disabled: true }]), current.owner);
    await runAction(actionsFor('file-editor-actions')[0], 'file-editor-actions', {});
    expect(current.invokeAction).not.toHaveBeenCalled();
    setFileEditorActions('provider', 'Provider', checkActions([{ id: 'save', label: 'Save' }]), current.owner);
    const previous = actionsFor('file-editor-actions')[0];
    setFileEditorActions('provider', 'Provider', checkActions([{ id: 'save', label: 'New save' }]), current.owner);
    await runAction(previous, 'file-editor-actions', {});
    expect(current.invokeAction).not.toHaveBeenCalled();
    const live = actionsFor('file-editor-actions')[0];
    current.abort.abort();
    await runAction(live, 'file-editor-actions', {});
    expect(current.invokeAction).not.toHaveBeenCalled();
  });

  it('rejects background frames, undeclared workspace roots and non-boolean disabled values', () => {
    const current = frame('current');
    expect(() => setFileEditorActions('provider', 'Provider', [], { ...current.owner, slot: null })).toThrow();
    expect(() => setFileEditorActions('provider', 'Provider', [], { ...current.owner, container: document.createElement('div') })).toThrow();
    expect(() => checkActions([{ id: 'save', label: 'Save', disabled: 'yes' }])).toThrow();
  });
});
