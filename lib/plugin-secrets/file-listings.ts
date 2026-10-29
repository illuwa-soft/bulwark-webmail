import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, stat, readdir, rm, unlink } from 'node:fs/promises';
import path from 'node:path';
import { decryptPayload, encryptPayload } from '@/lib/auth/crypto';
import { fileGrantDirectory, type StoredGrant } from './file-grants';
import { nativeFileState, scanResources, verifyResourcePage, type NativeIdentity, type ResourceFile } from './native-files';
import { FileResourceError } from './file-errors';

export const FILE_LISTING_TTL_MS = 5 * 60 * 1000;
const PAGE_SIZE = 200;
const MAX_BUILDERS = 4;
const HEX = /^[a-f0-9]{64}$/;
type Snapshot = { binding: string; id: string; state: string; count: number; expiresAt: number };
const pending = new Map<string, Promise<Snapshot>>();
const sweeps = new Map<string, number>();

function hash(value: string) { return createHash('sha256').update(value).digest('hex'); }
function root() { return path.join(fileGrantDirectory(), 'listings'); }
function tokenDirectory(binding: string) { return path.join(root(), binding); }
function snapshotDirectory(binding: string, id: string) { return path.join(tokenDirectory(binding), id); }

async function load(file: string): Promise<Record<string, unknown> | null> {
  try {
    if ((await stat(file)).size > 3 * 1024 * 1024) throw new FileResourceError('invalid_snapshot', 409);
    return decryptPayload(await readFile(file, 'utf8'), 'plugin-file-listing');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function save(file: string, value: Record<string, unknown>) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, encryptPayload(value, 'plugin-file-listing'), { mode: 0o600 });
    await rename(tmp, file);
  } finally {
    await unlink(tmp).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
  }
}

async function metadata(binding: string, id: string): Promise<Snapshot | null> {
  const value = await load(path.join(snapshotDirectory(binding, id), 'meta.enc'));
  if (!value || value.binding !== binding || value.id !== id || typeof value.state !== 'string' || typeof value.expiresAt !== 'number' || value.expiresAt <= Date.now() || !Number.isSafeInteger(value.count) || Number(value.count) < 0 || Number(value.count) > 100000) return null;
  return value as Snapshot;
}

/** Expired metadata is encrypted at rest and swept lazily, at most once per minute. */
async function sweep() {
  const base = root();
  const now = Date.now();
  if (now - (sweeps.get(base) ?? 0) < 60000) return;
  sweeps.set(base, now);
  await mkdir(base, { recursive: true, mode: 0o700 });
  for (const entry of await readdir(base, { withFileTypes: true })) {
    if (!entry.isDirectory() || !HEX.test(entry.name)) continue;
    const dir = tokenDirectory(entry.name);
    const info = await stat(dir).catch(() => null);
    if (info && info.mtimeMs + FILE_LISTING_TTL_MS < now) await rm(dir, { recursive: true, force: true });
  }
}

async function build(identity: NativeIdentity, grant: StoredGrant, binding: string, id: string, state: string): Promise<Snapshot> {
  await sweep();
  const files = await scanResources(identity, grant.roots, state);
  const snapshot: Snapshot = { binding, id, state, count: files.length, expiresAt: Math.min(grant.expiresAt ?? Infinity, Date.now() + FILE_LISTING_TTL_MS) };
  const dir = snapshotDirectory(binding, id);
  for (let position = 0; position < files.length; position += PAGE_SIZE) {
    identity.signal?.throwIfAborted();
    await save(path.join(dir, `${position}.enc`), { binding, id, position, files: files.slice(position, position + PAGE_SIZE) });
  }
  // Publishing metadata last prevents an incomplete scan/write from looking complete.
  await save(path.join(dir, 'meta.enc'), snapshot);
  await save(path.join(tokenDirectory(binding), 'index.enc'), { binding, id });
  const previous = (await readdir(tokenDirectory(binding), { withFileTypes: true })).filter((entry) => entry.isDirectory() && HEX.test(entry.name) && entry.name !== id);
  for (const entry of previous) await rm(snapshotDirectory(binding, entry.name), { recursive: true, force: true });
  return snapshot;
}

function encodeCursor(snapshot: Snapshot, position: number) {
  return Buffer.from(encryptPayload({ binding: snapshot.binding, id: snapshot.id, position, expiresAt: snapshot.expiresAt }, 'plugin-file-page'), 'base64').toString('base64url');
}

function decodeCursor(raw: string, binding: string) {
  if (raw.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw new FileResourceError('invalid_cursor', 400);
  const value = decryptPayload(Buffer.from(raw, 'base64url').toString('base64'), 'plugin-file-page');
  if (!value || value.binding !== binding || typeof value.id !== 'string' || !HEX.test(value.id) || !Number.isSafeInteger(value.position) || Number(value.position) < PAGE_SIZE || Number(value.position) % PAGE_SIZE !== 0 || typeof value.expiresAt !== 'number') throw new FileResourceError('invalid_cursor', 400);
  if (value.expiresAt <= Date.now()) throw new FileResourceError('cursor_expired', 409);
  return { id: value.id, position: Number(value.position) };
}

/** Reuse encrypted pages, but check current native state before returning any page. */
export async function listResources(identity: NativeIdentity, grant: StoredGrant, cursor?: string) {
  const binding = hash(grant.token);
  const continuation = cursor ? decodeCursor(cursor, binding) : null;
  let snapshot: Snapshot | null;
  let position = 0;
  if (continuation) {
    snapshot = await metadata(binding, continuation.id);
    if (!snapshot) throw new FileResourceError('cursor_expired', 409);
    position = continuation.position;
    if (position >= snapshot.count) throw new FileResourceError('invalid_cursor', 400);
  } else {
    const state = await nativeFileState(identity);
    const id = hash(JSON.stringify([state, grant.accountId, grant.roots]));
    const index = await load(path.join(tokenDirectory(binding), 'index.enc'));
    snapshot = index?.binding === binding && index.id === id ? await metadata(binding, id) : null;
    if (!snapshot) {
      const key = `${binding}:${id}`;
      let job = pending.get(key);
      if (!job) {
        if (pending.size >= MAX_BUILDERS) throw new FileResourceError('listing_busy', 503);
        job = build(identity, grant, binding, id, state).finally(() => { pending.delete(key); });
        pending.set(key, job);
      }
      snapshot = await job;
    }
  }
  identity.signal?.throwIfAborted();
  let files: ResourceFile[] = [];
  if (snapshot.count) {
    const value = await load(path.join(snapshotDirectory(binding, snapshot.id), `${position}.enc`));
    if (!value || value.binding !== binding || value.id !== snapshot.id || value.position !== position || !Array.isArray(value.files) || value.files.length !== Math.min(PAGE_SIZE, snapshot.count - position)) throw new FileResourceError('cursor_expired', 409);
    files = value.files as ResourceFile[];
  }
  try {
    await verifyResourcePage(identity, grant.roots, files, snapshot.state);
  } catch (error) {
    if (error instanceof FileResourceError && error.code === 'snapshot_changed') await rm(snapshotDirectory(binding, snapshot.id), { recursive: true, force: true });
    throw error;
  }
  const nextCursor = position + files.length < snapshot.count ? encodeCursor(snapshot, position + files.length) : null;
  return { files, nextCursor };
}
