import { actionsFor, type ActionOwner, type RegisteredAction } from '@/lib/plugin-sandbox/actions';

type EditorHost = { pluginId: string; root: Element; close(): Promise<boolean> };
const hosts = new Set<EditorHost>();

/** Finds a provider only for an explicitly claimed regular-file extension.
 * 명시적으로 지원을 선언한 일반 파일 확장자에 대해서만 편집기를 찾습니다. */
export function findFileEditor(name: string, directory: boolean, actions: RegisteredAction[] = actionsFor('file-open-actions')) {
  if (directory) return null;
  const extension = name.split('.').at(-1)?.toLowerCase() ?? '';

  return actions.find((action) => action.fileExtensions?.includes(extension)) ?? null;
}

/** Registers only the native Files host that owns the provider's exact frame subtree.
 * 제공자의 정확한 프레임 하위 트리를 소유하는 네이티브 파일 호스트만 등록합니다. */
export function registerFileEditorHost(host: EditorHost) {
  hosts.add(host);

  return () => { hosts.delete(host); };
}

/** A provider may close only its own live native file-editor. */
export function closeFileEditor(pluginId: string, owner: ActionOwner | undefined) {
  if (!owner || owner.slot !== 'file-editor' || owner.signal.aborted) throw new Error('A live file-editor instance is required');
  const host = [...hosts].find((candidate) => candidate.pluginId === pluginId && candidate.root.contains(owner.container));

  if (!host) throw new Error('The file editor host changed');

  return host.close();
}
