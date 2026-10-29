import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { encryptPayload, decryptPayload } from '@/lib/auth/crypto';
import type { NativeAccess, GrantedRoot } from './native-files';

export const MAX_FILE_GRANT_TTL_SECONDS = 7 * 24 * 60 * 60;
export type FileGrant = { subject: string; nativeSubject: string; pluginId: string; credentialId: string; backend: string; fingerprint: string; access: NativeAccess; accountId: string; roots: GrantedRoot[]; expiresAt: number };
type StoredGrant = FileGrant & { token: string; key: string };
export type FileGrantSummary = { granted: boolean; paths: string[]; expiresAt: number | null };
export const NO_FILE_GRANT: FileGrantSummary = { granted: false, paths: [], expiresAt: null };

function hash(value: string) { return createHash('sha256').update(value).digest('hex'); }
function ownerKey(subject: string, pluginId: string, credentialId: string) { return hash(JSON.stringify([subject, pluginId, credentialId])); }
function directory() { return path.join(process.env.PLUGIN_SECRETS_DIR || path.join(process.env.SETTINGS_DATA_DIR || path.join(process.cwd(), 'data', 'settings'), '..', 'plugin-secrets'), 'file-grants'); }
function location(kind: 'owners' | 'tokens', key: string) { return path.join(directory(), kind, `${key}.enc`); }

async function load(kind: 'owners' | 'tokens', key: string) {
  try { return decryptPayload(await readFile(location(kind, key), 'utf8'), 'plugin-file-grants'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
async function save(kind: 'owners' | 'tokens', key: string, value: Record<string, unknown>) {
  const file = location(kind, key);
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomUUID()}.tmp`;
  await writeFile(tmp, encryptPayload(value, 'plugin-file-grants'), { mode: 0o600 });
  await rename(tmp, file);
}
async function remove(kind: 'owners' | 'tokens', key: string) {
  try { await unlink(location(kind, key)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}

/** Bind a delegation to the current configured backend and key without storing that key.
 * 백엔드 키를 저장하지 않고 현재 백엔드·키에 위임을 결합합니다. */
export function backendFingerprint(origin: string, secret: string) { return hash(JSON.stringify([origin, secret])); }

/** Issue a small opaque capability; native access is stored only in host-encrypted files.
 * 작은 불투명 권한을 발급하며 네이티브 접근 정보는 호스트 암호화 파일에만 저장합니다. */
export async function putFileGrant(grant: FileGrant): Promise<FileGrantSummary> {
  const key = ownerKey(grant.subject, grant.pluginId, grant.credentialId);
  const previous = await load('owners', key);
  const token = randomBytes(32).toString('base64url');
  await save('tokens', hash(token), { t: 'grant', ...grant, key });
  await save('owners', key, { t: 'owner', token });
  if (typeof previous?.token === 'string') await remove('tokens', hash(previous.token));
  return { granted: true, paths: grant.roots.map((root) => root.path), expiresAt: grant.expiresAt };
}

/** Resolve a live capability and its current owner pointer, never from backend-supplied scope.
 * 백엔드가 보낸 범위 대신 유효한 권한과 현재 소유자 포인터를 확인합니다. */
export async function readFileGrant(token: string): Promise<StoredGrant | null> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const value = await load('tokens', hash(token));
  if (!value || value.t !== 'grant' || typeof value.key !== 'string' || !/^[a-f0-9]{64}$/.test(value.key) || typeof value.expiresAt !== 'number' || value.expiresAt <= Date.now()) return null;
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
export async function revokeFileGrant(subject: string, pluginId: string, credentialId: string) {
  const key = ownerKey(subject, pluginId, credentialId);
  const owner = await load('owners', key);
  await remove('owners', key);
  if (typeof owner?.token === 'string') await remove('tokens', hash(owner.token));
}
