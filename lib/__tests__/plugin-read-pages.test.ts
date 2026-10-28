import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IJMAPClient } from '../jmap/client-interface';
import type { InstalledPlugin, Permission } from '../plugin-types';
import { useAuthStore } from '@/stores/auth-store';
import { dispatchApiCall } from '../plugin-sandbox/host-api';
import { JMAPClient } from '../jmap/client';

vi.mock('@/stores/toast-store', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));

const reader = (permissions: Permission[]): InstalledPlugin => ({
  id: 'reader', name: 'Reader', version: '1.0.0', author: 'test', description: '',
  type: 'hook', permissions, grantedPermissions: [...permissions], entrypoint: 'index.js',
  enabled: true, status: 'running', settings: {},
});
const plugin = reader(['email:read', 'calendar:read', 'contacts:read', 'files:read']);
const email = (id: string) => ({ id, threadId: id, subject: id, receivedAt: '2026-10-01T00:00:00Z', mailboxIds: {}, keywords: {} });
let state: string;
let client: Record<string, ReturnType<typeof vi.fn>>;
const call = (method: string, options?: object, p = plugin) => dispatchApiCall(p, method, [options]);

beforeEach(() => {
  state = 'q1';
  client = {
    getServerUrl: vi.fn(() => 'https://mail.example.test'),
    getUsername: vi.fn(() => 'alice'),
    getAccountId: vi.fn(() => 'a'),
    getCalendarsAccountId: vi.fn(() => 'a'),
    getContactsAccountId: vi.fn(() => 'a'),
    getFilesAccountId: vi.fn(() => 'a'),
    queryReadPage: vi.fn(async (query) => {
      if (query.queryState && query.queryState !== state) throw new Error('queryChanged: restart the query');
      const all = [email('one'), email('two'), email('three')];
      return { items: all.slice(query.position, query.position + query.limit), total: 3,
        position: query.position, queryState: state, accountId: 'a' };
    }),
    getFileNodes: vi.fn(async () => [{ id: 'f', name: 'hello.txt', parentId: null, type: 'text/plain', size: 5, blobId: 'b', modified: '' }]),
    fetchBlobArrayBuffer: vi.fn(async () => new TextEncoder().encode('hello').buffer),
  };
  useAuthStore.setState({ client: client as unknown as IJMAPClient });
});

afterEach(() => useAuthStore.setState({ client: null }));

type Page = { items: { id: string }[]; total: number; position: number; nextCursor: string | null; queryState: string };

describe('bounded, resumable plugin queries', () => {
  it('pages real top-level FileNodes without serializing a null native parent id, while preserving child filters', async () => {
    const nodes = [
      { id: 'dir-a', parentId: null, name: 'source-a', type: 'd', blobId: null, size: 0, modified: '' },
      { id: 'dir-b', parentId: null, name: 'source-b', type: 'd', blobId: null, size: 0, modified: '' },
      { id: 'file-a', parentId: 'dir-a', name: 'note.xml', type: 'application/xml', blobId: 'blob-a', size: 5, modified: '' },
    ];
    const native = new JMAPClient('https://mail.example.test', 'alice', 'test-only');
    Object.assign(native, { apiUrl: 'https://mail.example.test/jmap/', accountId: 'a',
      capabilities: { 'urn:ietf:params:jmap:core': { maxObjectsInGet: 100 }, 'urn:ietf:params:jmap:filenode': {} } });
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const body: { methodCalls: [string, Record<string, unknown>, string][] } = JSON.parse(String(init?.body));
      const [method, args, id] = body.methodCalls[0];
      if (method === 'FileNode/query') {
        const filter = args.filter as { parentId?: string | null; isTopLevel?: boolean };
        // Stalwart's ParentId is an Id, not a nullable Id; its root filter is isTopLevel.
        if (Object.hasOwn(filter, 'parentId') && filter.parentId === null) return new Response('{}', { status: 400 });
        const selected = nodes.filter(node => {
          if (filter.isTopLevel === true) return node.parentId === null;
          return node.parentId === filter.parentId;
        });
        const position = Number(args.position);
        return new Response(JSON.stringify({ methodResponses: [[method, { accountId: 'a', queryState: 'file-q1', position,
          total: selected.length, ids: selected.slice(position, position + Number(args.limit)).map(node => node.id) }, id]] }));
      }
      if (!Array.isArray(args.ids)) throw new Error('Fixture requires bounded FileNode/get ids');
      const ids = args.ids;
      return new Response(JSON.stringify({ methodResponses: [[method, { list: nodes.filter(node => ids.includes(node.id)), notFound: [] }, id]] }));
    });
    useAuthStore.setState({ client: native });
    try {
      const first = await call('files.query', { parentId: null, limit: 1 }) as Page;
      expect(first).toMatchObject({ total: 2, position: 0, items: [{ id: 'dir-a', isDirectory: true }] });
      const last = await call('files.query', { parentId: null, limit: 1, cursor: first.nextCursor }) as Page;
      expect(last).toMatchObject({ total: 2, position: 1, items: [{ id: 'dir-b', isDirectory: true }], nextCursor: null });
      const children = await call('files.query', { parentId: 'dir-a', limit: 1 }) as Page;
      expect(children).toMatchObject({ total: 1, items: [{ id: 'file-a', isDirectory: false }], nextCursor: null });
    } finally {
      fetcher.mockRestore();
    }
  });

  it('returns an exact total and continues beyond the first page without duplicates', async () => {
    const first = await call('email.query', { limit: 2 }) as Page;
    expect(first.total).toBe(3);
    expect(first.items.map(item => item.id)).toEqual(['one', 'two']);
    expect(first.nextCursor).toBeTypeOf('string');
    const last = await call('email.query', { limit: 2, cursor: first.nextCursor }) as Page;
    expect(last.items.map(item => item.id)).toEqual(['three']);
    expect(last.position).toBe(2);
    expect(last.nextCursor).toBeNull();
    expect(client.queryReadPage).toHaveBeenLastCalledWith(expect.objectContaining({ position: 2, queryState: 'q1' }));
  });

  it('counts without fetching records when limit is zero', async () => {
    const page = await call('email.query', { limit: 0 }) as Page;
    expect(page).toMatchObject({ items: [], total: 3, position: 0, nextCursor: null });
    expect(client.queryReadPage).toHaveBeenCalledWith(expect.objectContaining({ limit: 0 }));
  });

  it('refuses a changed result set rather than silently mixing pages', async () => {
    const first = await call('email.query', { limit: 1 }) as Page;
    state = 'q2';
    await expect(call('email.query', { limit: 1, cursor: first.nextCursor })).rejects.toThrow(/queryChanged/);
  });

  it('binds cursors to the plugin, query, resource and signed-in account', async () => {
    const first = await call('email.query', { text: 'invoice', limit: 1 }) as Page;
    await expect(call('email.query', { text: 'other', cursor: first.nextCursor })).rejects.toThrow(/cursor/);
    await expect(call('contact.query', { text: 'invoice', cursor: first.nextCursor })).rejects.toThrow(/cursor/);
    await expect(call('email.query', { text: 'invoice', cursor: first.nextCursor }, { ...plugin, id: 'other' })).rejects.toThrow(/cursor/);
    client.getUsername.mockReturnValue('bob');
    await expect(call('email.query', { text: 'invoice', cursor: first.nextCursor })).rejects.toThrow(/cursor/);
  });

  it.each([
    ['email.query', 'email:read', 'Email'], ['calendar.queryEvents', 'calendar:read', 'CalendarEvent'],
    ['contact.query', 'contacts:read', 'ContactCard'], ['files.query', 'files:read', 'FileNode'],
  ] as const)('gates %s and reads only its fixed collection', async (method, permission, collection) => {
    await expect(call(method, {}, reader([]))).rejects.toThrow(`lacks permission "${permission}"`);
    await call(method, { limit: 0 });
    expect(client.queryReadPage).toHaveBeenCalledWith(expect.objectContaining({ collection, limit: 0 }));
  });

  it('rejects arbitrary filters, oversized pages, malformed cursors and a changed login during a read', async () => {
    await expect(call('email.query', { method: 'Email/set' })).rejects.toThrow(/unknown property/);
    await expect(call('email.query', { limit: 101 })).rejects.toThrow(/limit/);
    await expect(call('email.query', { cursor: 'broken' })).rejects.toThrow(/cursor/);
    expect(client.queryReadPage).not.toHaveBeenCalled();
    client.queryReadPage.mockImplementationOnce(async () => {
      useAuthStore.setState({ client: null });
      return { items: [], total: 0, position: 0, queryState: 'q1', accountId: 'a' };
    });
    await expect(call('email.query', {})).rejects.toThrow(/session changed/);
  });

  it('reads text only by a real FileNode, with a byte cap and the owning files account', async () => {
    const result = await dispatchApiCall(plugin, 'files.readText', ['f', { maxBytes: 10 }]);
    expect(result).toMatchObject({ id: 'f', text: 'hello', truncated: false });
    expect(client.fetchBlobArrayBuffer).toHaveBeenCalledWith('b', 'hello.txt', 'text/plain', 'a', 11);
    await expect(dispatchApiCall(reader([]), 'files.readText', ['f'])).rejects.toThrow(/lacks permission/);
    client.getFileNodes.mockResolvedValueOnce([{ id: 'f', blobId: 'arbitrary', type: 'application/pdf', size: 5 }]);
    await expect(dispatchApiCall(plugin, 'files.readText', ['f'])).rejects.toThrow(/text/);
    expect(client.fetchBlobArrayBuffer).toHaveBeenCalledTimes(1);
  });

  it('drops a page after permission revocation and rejects rolled-over dates', async () => {
    await expect(call('email.query', { after: '2026-02-30' })).rejects.toThrow(/real date/);
    const p = reader(['email:read']);
    client.queryReadPage.mockImplementationOnce(async () => {
      p.grantedPermissions = [];
      return { items: [], total: 0, position: 0, queryState: 'q1', accountId: 'a' };
    });
    await expect(call('email.query', {}, p)).rejects.toThrow(/revoked/);
  });
});
