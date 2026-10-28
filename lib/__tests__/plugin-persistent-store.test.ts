// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, writeFile, mkdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pluginDataOperation, pluginDataPath } from '@/lib/plugin-data/store';
import { MAX_PERSISTENT_VALUE_BYTES } from '@/lib/plugin-persistent-storage';
import type { PersistentRecord, StorageRequest } from '@/lib/plugin-persistent-storage';
vi.mock('@/lib/auth/session-secret', () => ({ getSessionSecret: () => 's'.repeat(64) }));
const alice = { accountName: 'alice@example.test', serverUrl: 'https://mail.example.test' };
let directory: string;
beforeEach(async () => { directory = await mkdtemp(path.join(tmpdir(), 'bulwark-plugin-state-')); vi.stubEnv('SETTINGS_DATA_DIR', directory); });
afterEach(async () => { vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); });
const operate = (request: StorageRequest) => pluginDataOperation(alice, 'notes', request) as Promise<PersistentRecord>;

describe('persistent plugin namespaces', () => {
  it('survives fresh reads and stores encrypted private bytes in the existing settings root', async () => {
    const saved = await operate({ operation: 'set', key: 'note', value: { text: 'private-tag' }, expectedRevision: null });
    expect(saved.revision).toBeTypeOf('string');
    expect(await operate({ operation: 'get', key: 'note' })).toEqual(saved);
    const file = pluginDataPath(alice, 'notes');
    expect(file.startsWith(path.join(directory, 'plugin-storage'))).toBe(true);
    expect(await readFile(file, 'utf8')).not.toContain('private-tag');
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it('isolates accounts, servers and plugins, including copied encrypted files', async () => {
    await operate({ operation: 'set', key: 'note', value: 'private', expectedRevision: null });
    const bob = { ...alice, accountName: 'bob@example.test' };
    const other = { ...alice, serverUrl: 'https://other.example.test' };
    expect(await pluginDataOperation(bob, 'notes', { operation: 'get', key: 'note' })).toEqual({ value: null, revision: null });
    expect(await pluginDataOperation(other, 'notes', { operation: 'get', key: 'note' })).toEqual({ value: null, revision: null });
    expect(await pluginDataOperation(alice, 'other', { operation: 'get', key: 'note' })).toEqual({ value: null, revision: null });
    await writeFile(pluginDataPath(alice, 'other'), await readFile(pluginDataPath(alice, 'notes')));
    await expect(pluginDataOperation(alice, 'other', { operation: 'get', key: 'note' })).rejects.toThrow('unavailable');
  });

  it('admits one concurrent create and rejects stale updates and deletes', async () => {
    const results = await Promise.allSettled([operate({ operation: 'set', key: 'note', value: 'a', expectedRevision: null }), operate({ operation: 'set', key: 'note', value: 'b', expectedRevision: null })]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    await expect(operate({ operation: 'set', key: 'note', value: 'stale', expectedRevision: null })).rejects.toThrow('conflict');
    await expect(operate({ operation: 'remove', key: 'note', expectedRevision: null })).rejects.toThrow('conflict');
    const snapshot = await operate({ operation: 'get', key: 'note' });
    await operate({ operation: 'remove', key: 'note', expectedRevision: snapshot.revision });
    expect(await operate({ operation: 'get', key: 'note' })).toEqual({ value: null, revision: null });
  });

  it('keeps separate-key writes and null values while enforcing value/namespace quotas', async () => {
    await Promise.all(Array.from({ length: 8 }, (_, index) => operate({ operation: 'set', key: String(index), value: null, expectedRevision: null })));
    expect(await pluginDataOperation(alice, 'notes', { operation: 'keys' })).toHaveLength(8);
    expect((await operate({ operation: 'get', key: '0' })).revision).not.toBeNull();
    await expect(operate({ operation: 'set', key: 'big', value: 'x'.repeat(MAX_PERSISTENT_VALUE_BYTES), expectedRevision: null })).rejects.toThrow('quota');
    for (let index = 0; index < 4; index += 1) await operate({ operation: 'set', key: `large-${index}`, value: 'x'.repeat(255 * 1024), expectedRevision: null });
    await expect(operate({ operation: 'set', key: 'large-4', value: 'x'.repeat(255 * 1024), expectedRevision: null })).rejects.toThrow('quota');
  });

  it('preserves corrupt bytes and refuses abandoned locks without stealing them', async () => {
    await operate({ operation: 'set', key: 'note', value: 'kept', expectedRevision: null });
    const file = pluginDataPath(alice, 'notes');
    await mkdir(`${file}.lock`);
    await expect(operate({ operation: 'set', key: 'other', value: 'new', expectedRevision: null })).rejects.toThrow('busy');
    expect((await operate({ operation: 'get', key: 'note' })).value).toBe('kept');
    await writeFile(file, 'corrupt');
    await expect(operate({ operation: 'get', key: 'note' })).rejects.toThrow('unavailable');
    expect(await readFile(file, 'utf8')).toBe('corrupt');
  });
});
