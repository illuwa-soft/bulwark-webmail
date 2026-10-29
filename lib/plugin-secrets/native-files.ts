import { createHash } from 'node:crypto';
import { fetchJmapSession, postJmap, rebaseApiUrl } from '@/lib/stalwart/jmap-api';
import { fetchJmapServer, isTrustedJmapServerUrl } from '@/lib/stalwart/server-fetch';
import { decodeFileNodeName } from '@/lib/jmap/filenode-name';

const FILES = 'urn:ietf:params:jmap:filenode';
const MAIL = 'urn:ietf:params:jmap:mail';
export type NativeAccess = { serverUrl: string; username: string; authHeader: string };
export type NativeIdentity = { subject: string; accountId: string; access: NativeAccess; apiUrl: string; downloadUrl: string; trusted: boolean; pageSize: number };
type Node = { id: string; parentId: string | null; name: string; type: string; blobId: string | null; size: number; modified: string };
export type GrantedRoot = { id: string; path: string; directory: boolean };
export type ResourceFile = { fileId: string; name: string; path: string; mime: string; size: number; modified: string; version: string };
const properties = ['id', 'parentId', 'name', 'type', 'blobId', 'size', 'modified'];

/** Resolve native identity on the host; passwords/tokens stay in this process.
 * 호스트에서 네이티브 계정을 확인하며 비밀번호·토큰은 호스트 안에 둡니다. */
export async function nativeIdentity(access: NativeAccess): Promise<NativeIdentity> {
  const trusted = await isTrustedJmapServerUrl(access.serverUrl);
  const session = await fetchJmapSession(access.serverUrl, access.authHeader, { trusted });
  const primary = session?.primaryAccounts ?? {};
  const principal = primary[MAIL] ?? primary[FILES] ?? Object.values(primary)[0];
  const apiUrl = rebaseApiUrl(session, access.serverUrl);
  if (!principal || !apiUrl) throw new Error('Native account is unavailable');
  const core = session?.capabilities?.['urn:ietf:params:jmap:core'] as { maxObjectsInGet?: number } | undefined;
  const template = (session as { downloadUrl?: string } | null)?.downloadUrl ?? '/jmap/download/{accountId}/{blobId}/{name}?accept={type}';
  const path = template.replace(/^[a-z]+:\/\/[^/]+/i, '');
  return {
    subject: createHash('sha256').update(JSON.stringify([access.serverUrl.replace(/\/+$/, ''), principal])).digest('hex'),
    accountId: primary[FILES] ?? primary[MAIL] ?? '', access, apiUrl, trusted,
    downloadUrl: new URL(access.serverUrl).origin + '/' + path.replace(/^\/+/, ''),
    pageSize: Math.max(1, Math.min(200, core?.maxObjectsInGet ?? 200)),
  };
}

/** Run fixed FileNode methods using the existing redirect- and rebinding-safe transport.
 * 기존 리다이렉트·DNS 보호 전송으로 고정된 FileNode 메서드를 호출합니다. */
async function call(identity: NativeIdentity, method: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await postJmap(identity.apiUrl, identity.access.authHeader, JSON.stringify({ using: ['urn:ietf:params:jmap:core', FILES], methodCalls: [[method, { accountId: identity.accountId, ...args }, '0']] }), { trusted: identity.trusted });
  if (!response.ok) throw new Error('Native file request failed');
  const result = await response.json() as { methodResponses?: [string, Record<string, unknown>, string][] };
  const entry = result.methodResponses?.[0];
  if (!entry || entry[0] !== method) throw new Error('Native file method failed');
  return entry[1];
}

/** Read a primary-account node under current native ACLs.
 * 현재 네이티브 ACL로 기본 계정의 노드를 읽습니다. */
async function node(identity: NativeIdentity, id: string): Promise<Node> {
  const result = await call(identity, 'FileNode/get', { ids: [id], properties });
  const value = (result.list as Node[] | undefined)?.[0];
  if (!value || value.id !== id || id.includes(':')) throw new Error('File is not accessible');
  return { ...value, name: decodeFileNodeName(value.name), modified: value.modified ?? '', size: value.size ?? 0 };
}

/** Exhaust each native directory page, including server-clamped page sizes.
 * 서버가 페이지 크기를 줄인 경우도 디렉터리의 모든 페이지를 읽습니다. */
async function children(identity: NativeIdentity, parentId: string | null): Promise<Node[]> {
  let filter: Record<string, unknown> = { parentId };
  if (parentId === null) filter = { isTopLevel: true };
  const result: Node[] = [];
  const seen = new Set<string>();
  let state: string | undefined;
  for (let position = 0; position < 100000;) {
    const page = await call(identity, 'FileNode/query', { filter, position, limit: identity.pageSize, calculateTotal: true, sort: [{ property: 'id', isAscending: true }] });
    const ids = page.ids as string[];
    if (!Array.isArray(ids) || typeof page.total !== 'number' || typeof page.queryState !== 'string') throw new Error('Invalid native page');
    state ??= page.queryState;
    if (state !== page.queryState || (ids.length === 0 && position < page.total)) throw new Error('Native files changed during paging');
    for (const id of ids) {
      if (seen.has(id)) throw new Error('Repeated native file page');
      seen.add(id);
    }
    if (ids.length) {
      const data = await call(identity, 'FileNode/get', { ids, properties });
      const list = data.list as Node[];
      if (!Array.isArray(list) || list.length !== ids.length) throw new Error('Incomplete native file page');
      for (const value of list) {
        if ((value.parentId ?? null) !== parentId) throw new Error('Native directory changed');
        result.push({ ...value, name: decodeFileNodeName(value.name), modified: value.modified ?? '', size: value.size ?? 0 });
      }
    }
    position += ids.length;
    if (position >= page.total) return result;
  }
  throw new Error('Native directory limit exceeded');
}

/** Resolve exact relative paths into immutable file/folder identities at consent time.
 * 승인 시점의 정확한 상대 경로를 불변 파일·폴더 ID로 해석합니다. */
export async function resolveRoots(identity: NativeIdentity, paths: string[]): Promise<GrantedRoot[]> {
  const roots: GrantedRoot[] = [];
  for (const path of paths) {
    const parts = path.split('/');
    if (!path || path.length > 500 || parts.some((part) => !part || part === '.' || part === '..' || part.includes('\\') || [...part].some((char) => char.charCodeAt(0) < 32))) throw new Error('Invalid relative resource path');
    let parentId: string | null = null;
    let selected: Node | undefined;
    for (const part of parts) {
      const matches: Node[] = (await children(identity, parentId)).filter((entry) => entry.name === part);
      if (matches.length !== 1) throw new Error('Resource path is missing or ambiguous');
      const found: Node = matches[0];
      selected = found;
      parentId = found.id;
    }
    if (!selected) throw new Error('Empty resource scope');
    roots.push({ id: selected.id, path, directory: !selected.blobId || selected.type === 'd' });
  }
  return roots;
}

function fileVersion(value: Node): string { return createHash('sha256').update(JSON.stringify([value.id, value.blobId])).digest('hex'); }
function resource(value: Node, path: string): ResourceFile { return { fileId: value.id, name: value.name, path, mime: value.type, size: value.size, modified: value.modified, version: fileVersion(value) }; }

/** List only explicitly granted files/folders; no account-wide catalogue leaves the host.
 * 명시적으로 승인한 파일·폴더만 열거하며 계정 전체 목록을 외부로 보내지 않습니다. */
export async function listResources(identity: NativeIdentity, roots: GrantedRoot[], cursor?: string) {
  const files = new Map<string, ResourceFile>();
  const directories = new Set<string>();
  const queue = [...roots];
  while (queue.length) {
    const root = queue.shift()!;
    const value = await node(identity, root.id);
    if (value.blobId && value.type !== 'd') { files.set(value.id, resource(value, root.path)); continue; }
    if (directories.has(root.id)) continue;
    if (!root.directory || directories.size >= 10000) throw new Error('Invalid or oversized directory scope');
    directories.add(root.id);
    for (const child of await children(identity, root.id)) queue.push({ id: child.id, path: `${root.path}/${child.name}`, directory: !child.blobId || child.type === 'd' });
    if (queue.length + files.size > 100000) throw new Error('Resource listing limit exceeded');
  }
  const ordered = [...files.values()].sort((a, b) => a.fileId.localeCompare(b.fileId));
  const state = createHash('sha256').update(JSON.stringify(ordered)).digest('hex');
  let position = 0;
  if (cursor) {
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString()) as { state: string; position: number };
    if (decoded.state !== state || !Number.isSafeInteger(decoded.position) || decoded.position < 0) throw new Error('Resource snapshot changed');
    position = decoded.position;
  }
  const page = ordered.slice(position, position + 200);
  let nextCursor: string | null = null;
  if (position + page.length < ordered.length) nextCursor = Buffer.from(JSON.stringify({ state, position: position + page.length })).toString('base64url');
  return { files: page, nextCursor };
}

/** Recheck parent membership, ACL and content version before streaming one granted file.
 * 스트리밍 전에 승인 범위·현재 ACL·콘텐츠 버전을 다시 확인합니다. */
export async function readResource(identity: NativeIdentity, roots: GrantedRoot[], fileId: string, version: string, signal?: AbortSignal) {
  const file = await node(identity, fileId);
  if (!file.blobId || file.type === 'd' || fileVersion(file) !== version) throw new Error('Resource version changed');
  const seen = new Set<string>();
  let current = file;
  let allowed = roots.some((root) => root.id === file.id);
  while (!allowed && current.parentId) {
    if (seen.has(current.parentId) || seen.size > 64) throw new Error('Invalid file hierarchy');
    seen.add(current.parentId);
    current = await node(identity, current.parentId);
    allowed = roots.some((root) => root.directory && root.id === current.id);
  }
  if (!allowed) throw new Error('File is outside the granted scope');
  const values: Record<string, string> = { accountId: identity.accountId, blobId: file.blobId, name: file.name, type: file.type };
  const url = identity.downloadUrl.replace(/\{(accountId|blobId|name|type)\}/g, (_match, key: string) => encodeURIComponent(values[key]));
  return fetchJmapServer(url, { headers: { Authorization: identity.access.authHeader }, redirect: 'manual', signal }, identity.trusted);
}
