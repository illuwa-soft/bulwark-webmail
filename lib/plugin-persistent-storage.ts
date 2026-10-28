/** JSON is the only portable value crossing the sandbox and persistent store.
 * 샌드박스와 영속 저장소 사이에는 JSON 값만 전달합니다. */
export type PluginJson = null | boolean | number | string | PluginJson[] | { [key: string]: PluginJson };
export type PersistentRecord = { value: PluginJson; revision: string | null };
export type PersistentWrite = { expectedRevision: string | null };
export type StorageOperation = 'get' | 'set' | 'remove' | 'keys';
export type StorageRequest = { operation: StorageOperation; key?: string; value?: PluginJson; expectedRevision?: string | null };
export const PERSISTENT_READ_PERMISSION = 'storage:persistent-read';
export const PERSISTENT_WRITE_PERMISSION = 'storage:persistent-write';
export const MAX_PERSISTENT_VALUE_BYTES = 256 * 1024;
export const MAX_PERSISTENT_NAMESPACE_BYTES = 1024 * 1024;
export const MAX_PERSISTENT_KEYS = 256;
export const MAX_PERSISTENT_REQUEST_BYTES = MAX_PERSISTENT_VALUE_BYTES + 4096;

export type StorageErrorCode = 'invalid' | 'conflict' | 'quota' | 'busy' | 'unavailable';

/** Carries safe storage errors without exposing filesystem paths or stored values.
 * 파일 경로나 저장 값을 노출하지 않고 저장 오류를 전달합니다. */
export class PersistentStorageError extends Error {
  /** Names the public failure contract used by the route and sandbox.
   * 라우트와 샌드박스가 사용하는 공개 실패 계약을 지정합니다. */
  constructor(public readonly code: StorageErrorCode) {
    super(`storage.persistent.${code}`);
  }
}

/** Validates opaque keys; they never become filesystem paths.
 * 불투명 키를 검증하며 키를 파일 시스템 경로로 사용하지 않습니다. */
export function persistentKey(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 256) throw new PersistentStorageError('invalid');
  if ([...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) throw new PersistentStorageError('invalid');
  return value;
}

/** Requires an explicit observed revision, including null for a missing record.
 * 없는 레코드의 null을 포함해 관찰한 revision을 명시하도록 합니다. */
export function persistentRevision(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value === 'string' && /^[0-9a-f-]{36}$/.test(value)) return value;
  throw new PersistentStorageError('invalid');
}

/** Rejects cycles, active objects, non-finite numbers and excessive nesting before serialization.
 * 직렬화 전에 순환·활성 객체·유한하지 않은 수·과도한 중첩을 거부합니다. */
export function persistentJson(value: unknown, depth = 0, seen = new Set<object>()): PluginJson {
  if (depth > 32) throw new PersistentStorageError('invalid');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (!value || typeof value !== 'object' || seen.has(value)) throw new PersistentStorageError('invalid');
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) throw new PersistentStorageError('invalid');
  if (Object.getOwnPropertySymbols(value).length || (Array.isArray(value) && Object.keys(value).length !== value.length)) throw new PersistentStorageError('invalid');
  seen.add(value);
  for (const item of Object.values(value)) persistentJson(item, depth + 1, seen);
  seen.delete(value);
  // SAFETY: every child and the container prototype were checked recursively above.
  return value as PluginJson;
}

/** Bounds UTF-8 bytes rather than JavaScript character counts.
 * JavaScript 문자 수 대신 UTF-8 바이트 수에 한도를 적용합니다. */
export function persistentValue(value: unknown): PluginJson {
  const parsed = persistentJson(value);
  if (new TextEncoder().encode(JSON.stringify(parsed)).byteLength > MAX_PERSISTENT_VALUE_BYTES) throw new PersistentStorageError('quota');
  return parsed;
}

/** Parses one closed operation before either client or server touches storage.
 * 클라이언트와 서버가 저장소에 접근하기 전에 제한된 작업 하나를 파싱합니다. */
export function persistentRequest(input: unknown): StorageRequest {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new PersistentStorageError('invalid');
  const data = input as Record<string, unknown>;
  const operation = data.operation;
  if (typeof operation !== 'string' || !['get', 'set', 'remove', 'keys'].includes(operation)) throw new PersistentStorageError('invalid');
  const allowed: Record<StorageOperation, string[]> = { get: ['operation', 'key'], keys: ['operation'], set: ['operation', 'key', 'value', 'expectedRevision'], remove: ['operation', 'key', 'expectedRevision'] };
  // SAFETY: operation was checked against the complete literal catalog above.
  const kind = operation as StorageOperation;
  if (Object.keys(data).some(key => !allowed[kind].includes(key))) throw new PersistentStorageError('invalid');
  if (kind === 'keys') return { operation: kind };
  const key = persistentKey(data.key);
  if (kind === 'get') return { operation: kind, key };
  const expectedRevision = persistentRevision(data.expectedRevision);
  if (kind === 'remove') return { operation: kind, key, expectedRevision };
  return { operation: kind, key, expectedRevision, value: persistentValue(data.value) };
}
