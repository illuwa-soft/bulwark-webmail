import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, unlink, rm } from 'node:fs/promises';
import path from 'node:path';
import { encryptPayload, decryptPayload } from '@/lib/auth/crypto';
import type { NativeAccess, GrantedRoot } from './native-files';
import { userKey, type VaultUser } from './vault';

export type FileGrant = { subject: string; nativeSubject: string; pluginId: string; credentialId: string; backend: string; fingerprint: string; access: NativeAccess; accountId: string; roots: GrantedRoot[]; expiresAt: number | null };
export type StoredGrant = FileGrant & { token: string; key: string; loginKey: string };
export type FileGrantSummary = { granted: boolean; paths: string[]; expiresAt: number | null };
export const NO_FILE_GRANT: FileGrantSummary = { granted: false, paths: [], expiresAt: null };

function hash(value: string) { return createHash('sha256').update(value).digest('hex'); }
function ownerKey(subject: string, pluginId: string, credentialId: string) { return hash(JSON.stringify([subject, pluginId, credentialId])); }
export function fileGrantDirectory() { return path.join(process.env.PLUGIN_SECRETS_DIR || path.join(process.env.SETTINGS_DATA_DIR || path.join(process.cwd(), 'data', 'settings'), '..', 'plugin-secrets'), 'file-grants'); }
function loginKey(user: VaultUser, pluginId: string, credentialId: string) { return hash(JSON.stringify([userKey(user), pluginId, credentialId])); }
function location(kind: 'owners' | 'tokens' | 'logins', key: string) { return path.join(fileGrantDirectory(), kind, `${key}.enc`); }

async function load(kind: 'owners' | 'tokens' | 'logins', key: string) {
  try { return decryptPayload(await readFile(location(kind, key), 'utf8'), 'plugin-file-grants'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
async function save(kind: 'owners' | 'tokens' | 'logins', key: string, value: Record<string, unknown>) {
  const file = location(kind, key);
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomUUID()}.tmp`;
  await writeFile(tmp, encryptPayload(value, 'plugin-file-grants'), { mode: 0o600 });
  await rename(tmp, file);
}
async function remove(kind: 'owners' | 'tokens' | 'logins', key: string) {
  try { await unlink(location(kind, key)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}

const writes = new Map<string, Promise<unknown>>();
function serialize<T>(key: string, task: () => Promise<T>): Promise<T> {
  const run = (writes.get(key) ?? Promise.resolve()).then(task, task);
  const tail = run.catch(() => {});
  writes.set(key, tail);
  void tail.then(() => { if (writes.get(key) === tail) writes.delete(key); });
  return run;
}

async function discard(token: string) {
  await remove('tokens', hash(token));
  await rm(path.join(fileGrantDirectory(), 'listings', hash(token)), { recursive: true, force: true });
}

/** Bind a delegation to the current configured backend and key without storing that key.
 * 백엔드 키를 저장하지 않고 현재 백엔드·키에 위임을 결합합니다. */
export function backendFingerprint(origin: string, secret: string) { return hash(JSON.stringify([origin, secret])); }

/** Issue a small opaque capability; native access is stored only in host-encrypted files.
 * 작은 불투명 권한을 발급하며 네이티브 접근 정보는 호스트 암호화 파일에만 저장합니다. */
export async function putFileGrant(grant: FileGrant): Promise<FileGrantSummary> {
  const login = loginKey(grant.access, grant.pluginId, grant.credentialId);
  return serialize(login, async () => {
    const key = ownerKey(grant.subject, grant.pluginId, grant.credentialId);
    const previous = await load('logins', login);
    const oldOwner = await load('owners', key);
    const token = randomBytes(32).toString('base64url');
    await save('tokens', hash(token), { t: 'grant', ...grant, key, loginKey: login });
    await save('owners', key, { t: 'owner', token });
    await save('logins', login, { t: 'login', key, token });
    for (const old of new Set([previous?.token, oldOwner?.token])) if (typeof old === 'string' && old !== token) await discard(old);
    return { granted: true, paths: grant.roots.map((root) => root.path), expiresAt: grant.expiresAt };
  });
}

/** Resolve a live capability and its current owner pointer, never from backend-supplied scope.
 * 백엔드가 보낸 범위 대신 유효한 권한과 현재 소유자 포인터를 확인합니다. */
export async function readFileGrant(token: string): Promise<StoredGrant | null> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const value = await load('tokens', hash(token));
  if (!value || value.t !== 'grant' || typeof value.key !== 'string' || !/^[a-f0-9]{64}$/.test(value.key) || typeof value.loginKey !== 'string' || !/^[a-f0-9]{64}$/.test(value.loginKey)) return null;
  if (value.expiresAt !== null && (typeof value.expiresAt !== 'number' || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= Date.now())) return null;
  const login = await load('logins', value.loginKey);
  if (login?.token !== token || login.key !== value.key) return null;
  const owner = await load('owners', value.key);
  if (typeof owner?.token !== 'string' || owner.token.length !== token.length || !timingSafeEqual(Buffer.from(owner.token), Buffer.from(token))) return null;
  return { ...value, token } as StoredGrant;
}

/** Find the current account/plugin/credential grant for server-side proxy injection.
 * 서버 프록시에 넣을 현재 계정·플러그인·자격증명의 권한을 찾습니다. */
export async function currentFileGrant(subject: string, pluginId: string, credentialId: string) {
  const owner = await load('owners', ownerKey(subject, pluginId, credentialId));
  if (typeof owner?.token !== 'string') return null;
  return readFileGrant(owner.token);
}

/** Revoke the owner pointer before removing the obsolete capability record.
 * 소유자 포인터를 먼저 철회하고 오래된 권한 레코드를 제거합니다. */
export async function revokeFileGrant(user: VaultUser, pluginId: string, credentialId: string) {
  const key = loginKey(user, pluginId, credentialId);
  return serialize(key, async () => {
    const login = await load('logins', key);
    await remove('logins', key);
    if (typeof login?.key === 'string' && /^[a-f0-9]{64}$/.test(login.key)) {
      const owner = await load('owners', login.key);
      if (owner?.token === login.token) await remove('owners', login.key);
    }
    if (typeof login?.token === 'string') await discard(login.token);
  });
}
