import type { InstalledPlugin } from '../plugin-types';
import type { FileNode } from '../jmap/types';
import { fileHooks } from '../plugin-hooks';
import { fileToView } from '../plugin-projection';
import { readFileName, readId, readObject, readString, withinRate } from './host-api-input';
import { writeScope } from './host-api-write-scope';

type Scope = ReturnType<typeof writeScope>;

function ownId(value: unknown, method: string): string {
  const id = readId(value, method);
  if (id.includes(':')) throw new Error(`${method}: only the primary FileNode account is supported`);
  return id;
}

async function ownNode(scope: Scope, id: string, method: string): Promise<FileNode> {
  const [node] = await scope.client.getFileNodes([id]);
  scope.check();
  if (!node || node.id !== id || node.isShared || (node.accountId && node.accountId !== scope.client.getFilesAccountId())) throw new Error(`${method}: primary-account file not found`);
  return node;
}

async function parent(scope: Scope, value: unknown, method: string) {
  if (value === undefined || value === null) return null;
  const id = ownId(value, method);
  const node = await ownNode(scope, id, method);
  if (node.type !== 'd' && node.blobId !== null) throw new Error(`${method}: parent must be a directory`);
  return id;
}

async function parentPath(scope: Scope, parentId: string | null, method: string) {
  const names: string[] = [];
  const seen = new Set<string>();
  let id = parentId;
  while (id !== null) {
    if (seen.has(id) || seen.size === 64) throw new Error(`${method}: invalid parent hierarchy`);
    seen.add(id);
    const node = await ownNode(scope, ownId(id, method), method);
    names.unshift(node.name);
    id = node.parentId;
  }
  return '/' + names.join('/');
}

function rate(plugin: InstalledPlugin, method: string) {
  if (!withinRate('files.write', plugin.id, 20)) throw new Error(`${method}: at most 20 file mutations a minute`);
}

/** Primary-account metadata only, including directories and binary files, without a blob id. */
export async function doFilesGet(plugin: InstalledPlugin, idArg: unknown) {
  const method = 'files.get';
  const id = ownId(idArg, method);
  const scope = writeScope(plugin, 'files:read', method);
  const node = await ownNode(scope, id, method);
  return fileToView(node, await parentPath(scope, node.parentId, method));
}

/** Creates a bounded UTF-8 file or a directory, without accepting an arbitrary blob id. */
export async function doFilesCreate(plugin: InstalledPlugin, directory: boolean, input: unknown) {
  const method = directory ? 'files.createDirectory' : 'files.createText';
  const data = readObject(input, method, 'file', directory ? ['name', 'parentId'] : ['name', 'text', 'parentId']);
  const name = readFileName(data.name, method, 'name');
  const text = directory ? '' : readString(data.text, method, 'text', 65536);
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength > 65536) throw new Error(`${method}: text is larger than 65536 UTF-8 bytes`);
  const scope = writeScope(plugin, 'files:write', method);
  const parentId = await parent(scope, data.parentId, method);
  const path = await parentPath(scope, parentId, method);
  scope.check();
  rate(plugin, method);
  if (directory) {
    const node = await scope.client.createFileDirectory(name, parentId);
    scope.check();
    void fileHooks.onDirectoryCreate.emit(fileToView(node, path));
    return fileToView(node, path);
  }
  if (!(await fileHooks.onBeforeFileUpload.intercept({ name, size: bytes.byteLength, type: 'text/plain', path }))) throw new Error(`${method}: upload stopped by a plugin`);
  scope.check();
  const uploaded = await scope.client.uploadBlob(new File([bytes], name, { type: 'text/plain' }), scope.client.getFilesAccountId());
  scope.check();
  const node = await scope.client.createFileNode(name, uploaded.blobId, 'text/plain', bytes.byteLength, parentId);
  scope.check();
  void fileHooks.onAfterFileUpload.emit(fileToView(node, path));
  return fileToView(node, path);
}

/** Updates only names/parents in the primary FileNode account, preserving hook vetoes. */
export async function doFilesUpdate(plugin: InstalledPlugin, idArg: unknown, input: unknown) {
  const method = 'files.update';
  const id = ownId(idArg, method);
  const data = readObject(input, method, 'patch', ['name', 'parentId']);
  if (!Object.keys(data).length) throw new Error(`${method}: an update is required`);
  const scope = writeScope(plugin, 'files:write', method);
  const node = await ownNode(scope, id, method);
  const file = fileToView(node, await parentPath(scope, node.parentId, method));
  const patch: Partial<Pick<FileNode, 'name' | 'parentId'>> = {};
  let toPath = file.path;
  if (data.name !== undefined) {
    patch.name = readFileName(data.name, method, 'name');
    if (!(await fileHooks.onBeforeFileRename.intercept({ file, newName: patch.name }))) throw new Error(`${method}: rename stopped by a plugin`);
  }
  if (Object.hasOwn(data, 'parentId')) {
    patch.parentId = await parent(scope, data.parentId, method);
    toPath = await parentPath(scope, patch.parentId, method);
    if (patch.parentId === id) throw new Error(`${method}: cannot move a directory into itself`);
    if (!(await fileHooks.onBeforeFileMove.intercept({ files: [file], toPath }))) throw new Error(`${method}: move stopped by a plugin`);
  }
  scope.check();
  rate(plugin, method);
  await scope.client.updateFileNode(id, patch);
  scope.check();
  const actual = await ownNode(scope, id, method);
  if ((patch.name !== undefined && actual.name !== patch.name) || (patch.parentId !== undefined && actual.parentId !== patch.parentId)) throw new Error(`${method}: metadata update was not confirmed`);
  const updated = fileToView(actual, await parentPath(scope, actual.parentId, method));
  if (patch.name !== undefined) void fileHooks.onFileRename.emit({ file: updated, previousName: file.name });
  if (patch.parentId !== undefined) void fileHooks.onFileMove.emit({ files: [updated], toPath });
  return updated;
}

/** Requests a non-recursive server-side delete; missing receipts never become success. */
export async function doFilesRemove(plugin: InstalledPlugin, idArg: unknown) {
  const method = 'files.remove';
  const id = ownId(idArg, method);
  const scope = writeScope(plugin, 'files:write', method);
  const node = await ownNode(scope, id, method);
  const file = fileToView(node, await parentPath(scope, node.parentId, method));
  if (!(await fileHooks.onBeforeFileDelete.intercept({ files: [file] }))) throw new Error(`${method}: deletion stopped by a plugin`);
  scope.check();
  rate(plugin, method);
  const result = await scope.client.destroyFileNodes([id], { recursive: false });
  scope.check();
  if (!result.destroyed.includes(id) || result.notDestroyed.includes(id)) throw new Error(`${method}: deletion not confirmed; a directory must be empty and have no children`);
  void fileHooks.onAfterFileDelete.emit({ files: [file] });
  return { id, deleted: true };
}
