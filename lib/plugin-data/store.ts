import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { decryptPayload, encryptPayload } from '@/lib/auth/crypto';
import { MAX_PERSISTENT_KEYS, MAX_PERSISTENT_NAMESPACE_BYTES, PersistentStorageError, persistentKey, persistentRequest, persistentRevision, persistentValue } from '@/lib/plugin-persistent-storage';
import type { PersistentRecord, PluginJson, StorageRequest } from '@/lib/plugin-persistent-storage';

export type PluginDataOwner = { accountName: string; serverUrl: string };
type Entry = { key: string; value: PluginJson; revision: string };
type Namespace = { version: 1; owner: string; pluginId: string; entries: Entry[] };

/** Binds storage to a server-authenticated canonical account and normalized server URL.
 * 서버가 인증한 정본 계정과 정규화한 서버 URL에 저장소를 연결합니다. */
export function pluginDataOwnerKey(owner: PluginDataOwner): string {
  return digest(JSON.stringify([owner.accountName, owner.serverUrl.replace(/\/+$/, '')]));
}

/** Hashes identities so neither plugin IDs nor user names become path fragments.
 * 플러그인 ID·사용자 이름을 경로 조각으로 사용하지 않도록 해시합니다. */
function digest(value: string): string { return createHash('sha256').update(value).digest('hex'); }

/** Uses a dedicated namespace under the existing persistent settings volume.
 * 기존 영속 설정 볼륨 아래의 전용 네임스페이스를 사용합니다. */
export function pluginDataPath(owner: PluginDataOwner, pluginId: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,126}[a-z0-9]$/.test(pluginId)) throw new PersistentStorageError('invalid');
  const root = process.env.SETTINGS_DATA_DIR || path.join(process.cwd(), 'data', 'settings');
  return path.join(root, 'plugin-storage', pluginDataOwnerKey(owner), `${digest(pluginId)}.enc`);
}

/** Reads an atomic encrypted snapshot and fails closed on corruption or namespace substitution.
 * 원자적으로 저장된 암호화 스냅샷을 읽고 손상·네임스페이스 바꿔치기를 거부합니다. */
async function load(file: string, owner: PluginDataOwner, pluginId: string): Promise<Namespace> {
  let text: string;
  try { text = await readFile(file, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, owner: pluginDataOwnerKey(owner), pluginId, entries: [] };
    throw new PersistentStorageError('unavailable');
  }
  const payload = decryptPayload(text, 'plugin-storage');
  if (!payload || payload.version !== 1 || payload.owner !== pluginDataOwnerKey(owner) || payload.pluginId !== pluginId || !Array.isArray(payload.entries)) throw new PersistentStorageError('unavailable');
  try {
    const entries = payload.entries.map(parseEntry);
    if (new Set(entries.map(entry => entry.key)).size !== entries.length) throw new Error('duplicate');
    checkQuota(entries);
    return { version: 1, owner: pluginDataOwnerKey(owner), pluginId, entries };
  } catch { throw new PersistentStorageError('unavailable'); }
}

/** Checks stored data as well as incoming requests, retaining invalid data for recovery.
 * 입력 요청뿐 아니라 저장 데이터도 검증하며 잘못된 파일은 복구를 위해 보존합니다. */
function parseEntry(input: unknown): Entry {
  if (!input || typeof input !== 'object') throw new PersistentStorageError('unavailable');
  const entry = input as Record<string, unknown>;
  const revision = persistentRevision(entry.revision);
  if (!revision) throw new PersistentStorageError('unavailable');
  return { key: persistentKey(entry.key), value: persistentValue(entry.value), revision };
}

/** Caps the complete namespace independently of the per-value request limit.
 * 값 하나의 요청 한도와 별개로 전체 네임스페이스 크기를 제한합니다. */
function checkQuota(entries: Entry[]): void {
  if (entries.length > MAX_PERSISTENT_KEYS || Buffer.byteLength(JSON.stringify(entries), 'utf8') > MAX_PERSISTENT_NAMESPACE_BYTES) throw new PersistentStorageError('quota');
}

/** Writes private, fsynced temporary bytes before an atomic same-directory rename.
 * 비공개 임시 파일을 fsync한 뒤 같은 디렉터리에서 원자적으로 이름을 바꿉니다. */
async function save(file: string, namespace: Namespace): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(encryptPayload({ ...namespace }, 'plugin-storage'), 'utf8');
      await handle.sync();
    } finally { await handle.close(); }
    await rename(temporary, file);
  }
  finally { await unlink(temporary).catch(() => {}); }
}

/** Acquires an exclusive filesystem lock shared across workers; abandoned locks are not stolen.
 * 워커 간 공유되는 파일 시스템 배타 잠금을 얻으며 남겨진 잠금을 임의로 빼앗지 않습니다. */
async function acquire(file: string): Promise<string> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const lock = `${file}.lock`;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try { await mkdir(lock, { mode: 0o700 }); return lock; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new PersistentStorageError('unavailable');
      await delay(25);
    }
  }
  throw new PersistentStorageError('busy');
}

/** Applies a conditional edit to one key without erasing unrelated records.
 * 다른 레코드를 지우지 않고 키 하나에 조건부 변경을 적용합니다. */
function change(namespace: Namespace, request: StorageRequest): PersistentRecord {
  const current = namespace.entries.find(entry => entry.key === request.key);
  if ((current?.revision ?? null) !== request.expectedRevision) throw new PersistentStorageError('conflict');
  const entries = namespace.entries.filter(entry => entry.key !== request.key);
  if (request.operation === 'remove') { namespace.entries = entries; return { value: null, revision: null }; }
  const key = persistentKey(request.key);
  const value = persistentValue(request.value);
  const revision = randomUUID();
  entries.push({ key, value, revision });
  checkQuota(entries);
  namespace.entries = entries;
  return { value, revision };
}

/** Reads without a cache; conditional writes serialize across processes and never retry a commit.
 * 캐시 없이 읽고 조건부 쓰기는 프로세스 간 직렬화하며 커밋을 재시도하지 않습니다. */
export async function pluginDataOperation(owner: PluginDataOwner, pluginId: string, input: StorageRequest): Promise<PersistentRecord | string[]> {
  const request = persistentRequest(input);
  const file = pluginDataPath(owner, pluginId);
  if (request.operation === 'get' || request.operation === 'keys') {
    const namespace = await load(file, owner, pluginId);
    if (request.operation === 'keys') return namespace.entries.map(entry => entry.key).sort();
    const entry = namespace.entries.find(item => item.key === request.key);
    return { value: entry?.value ?? null, revision: entry?.revision ?? null };
  }
  const lock = await acquire(file);
  try {
    const namespace = await load(file, owner, pluginId);
    const result = change(namespace, request);
    await save(file, namespace);
    return result;
  } finally { await rmdir(lock); }
}
