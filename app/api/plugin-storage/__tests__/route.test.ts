// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { POST } from '../route';
import { setStalwartAuthContextInStore } from '@/lib/stalwart/auth-context';
import { PERSISTENT_READ_PERMISSION, PERSISTENT_WRITE_PERMISSION } from '@/lib/plugin-persistent-storage';
import type { StorageRequest } from '@/lib/plugin-persistent-storage';

const state = vi.hoisted(() => ({ enabled: true, uploads: true, known: true, installed: true, approved: false, permissions: ['storage:persistent-read', 'storage:persistent-write'], jar: new Map<string, string>() }));
const fingerprint = 'a'.repeat(64);
vi.mock('@/lib/auth/session-secret', () => ({ getSessionSecret: () => 's'.repeat(64) }));
vi.mock('@/lib/admin/config-manager', () => ({ configManager: { ensureLoaded: async () => {}, get: (_key: string, fallback: unknown) => fallback, getPolicy: () => ({ features: { pluginsEnabled: state.enabled, pluginsUploadEnabled: state.uploads } }) } }));
vi.mock('@/lib/admin/plugin-registry', () => ({ getPlugin: async () => {
  if (!state.known) return null;
  return { id: 'notes', enabled: state.installed, bundleHash: 'a'.repeat(64), permissions: state.permissions };
} }));
vi.mock('@/lib/admin/plugin-approvals', () => ({ listApprovals: async () => [{ pluginId: 'notes', bundleHash: 'a'.repeat(64), status: state.approved ? 'approved' : 'denied', manifest: { permissions: state.permissions } }] }));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: (name: string) => {
  const value = state.jar.get(name);
  if (value) return { value };
  return undefined;
} }) }));
let directory: string;

/** Creates real encrypted context cookies for one synthetic native login.
 * 합성 네이티브 로그인 하나의 실제 암호화 문맥 쿠키를 만듭니다. */
function signIn(accountName = 'alice@example.test', slot = 2, username = 'alice') {
  const jar = { set: (name: string, value: string) => state.jar.set(name, value) };
  setStalwartAuthContextInStore(jar as never, slot, { username, accountName, serverUrl: 'https://mail.example.test', authHeader: 'Bearer synthetic' });
}

/** Sends only host-owned selectors; the operation body cannot claim an account.
 * 호스트 소유 선택자만 보내며 작업 본문으로 계정을 주장하지 않습니다. */
function request(body: StorageRequest | Record<string, unknown>, headers: Record<string, string> = {}) {
  return POST(new NextRequest('https://webmail.example/api/plugin-storage', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', 'X-JMAP-Cookie-Slot': '2', 'X-JMAP-Username': 'alice', 'X-JMAP-Server': 'https://mail.example.test', 'X-Bulwark-Plugin-Id': 'notes', 'X-Bulwark-Plugin-Fingerprint': fingerprint, ...headers },
    body: JSON.stringify(body),
  }));
}

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'bulwark-storage-route-'));
  vi.stubEnv('SETTINGS_DATA_DIR', directory);
  state.enabled = true; state.uploads = true; state.known = true; state.installed = true; state.approved = false;
  state.permissions = [PERSISTENT_READ_PERMISSION, PERSISTENT_WRITE_PERMISSION];
  state.jar.clear(); signIn();
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); });

describe('authenticated durable storage route', () => {
  it('keeps state through sign-out and re-login while isolating canonical accounts in the same slot', async () => {
    const saved = await request({ operation: 'set', key: 'tag', value: 'kept', expectedRevision: null });
    expect(saved.status).toBe(200);
    expect(saved.headers.get('cache-control')).toBe('no-store');
    state.jar.clear();
    expect((await request({ operation: 'get', key: 'tag' })).status).toBe(401);
    signIn('bob@example.test');
    expect(await (await request({ operation: 'get', key: 'tag' })).json()).toEqual({ result: { value: null, revision: null } });
    state.jar.clear(); signIn();
    expect(await (await request({ operation: 'get', key: 'tag' })).json()).toMatchObject({ result: { value: 'kept' } });
  });

  it('rejects missing/mismatched slots, bare token claims and forged account bodies', async () => {
    expect((await request({ operation: 'keys' }, { 'X-JMAP-Cookie-Slot': '0' })).status).toBe(401);
    expect((await request({ operation: 'keys' }, { 'X-JMAP-Cookie-Slot': '2junk' })).status).toBe(401);
    expect((await request({ operation: 'keys' }, { 'X-JMAP-Username': 'bob' })).status).toBe(401);
    expect((await request({ operation: 'keys' }, { 'X-JMAP-Server': 'https://other.example' })).status).toBe(401);
    expect((await request({ operation: 'keys', accountName: 'bob@example.test' })).status).toBe(400);
    state.jar.clear(); signIn('', 2);
    expect((await request({ operation: 'keys' })).status).toBe(401);
  });

  it('rechecks package identity, server revocation and separately granted read/write permissions', async () => {
    expect((await request({ operation: 'keys' }, { 'X-Bulwark-Plugin-Fingerprint': 'b'.repeat(64) })).status).toBe(403);
    state.installed = false;
    expect((await request({ operation: 'keys' })).status).toBe(403);
    state.installed = true; state.permissions = [PERSISTENT_READ_PERMISSION];
    expect((await request({ operation: 'keys' })).status).toBe(200);
    expect((await request({ operation: 'set', key: 'k', value: 'x', expectedRevision: null })).status).toBe(403);
    state.permissions = [PERSISTENT_WRITE_PERMISSION];
    expect((await request({ operation: 'keys' })).status).toBe(403);
  });

  it('admits exact approved user packages and rejects unregistered or denied packages', async () => {
    state.known = false;
    expect((await request({ operation: 'keys' })).status).toBe(403);
    state.approved = true;
    expect((await request({ operation: 'keys' })).status).toBe(200);
    state.uploads = false;
    expect((await request({ operation: 'keys' })).status).toBe(403);
  });

  it('rejects cross-origin requests, disabled plugins, malformed JSON and oversized bodies', async () => {
    expect((await request({ operation: 'keys' }, { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    state.enabled = false;
    expect((await request({ operation: 'keys' })).status).toBe(403);
    state.enabled = true;
    expect((await request({ operation: 'keys' }, { 'content-type': 'text/plain' })).status).toBe(400);
    expect((await request({ operation: 'set', key: 'k', value: 'x'.repeat(300000), expectedRevision: null })).status).toBe(413);
  });

  it('returns a stable conflict receipt instead of overwriting a new revision', async () => {
    await request({ operation: 'set', key: 'k', value: 'first', expectedRevision: null });
    const response = await request({ operation: 'set', key: 'k', value: 'stale', expectedRevision: null });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: { code: 'conflict' } });
  });
});
