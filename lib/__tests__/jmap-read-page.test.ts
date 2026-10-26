import { afterEach, describe, expect, it, vi } from 'vitest';
import { JMAPClient } from '../jmap/client';
import { DemoJMAPClient } from '../demo/demo-client';
import type { ReadCollection } from '../jmap/read-page';

type Call = [string, Record<string, unknown>, string];
function server(collection: ReadCollection, options: { state?: string; omitTotal?: boolean; missing?: boolean; empty?: boolean } = {}) {
  const calls: Call[] = [];
  const data = Array.from({ length: 1203 }, (_, i) => ({ id: String(i), subject: `Mail ${i}`, name: `File ${i}`, type: 'text/plain', blobId: 'b' }));
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
    const batch = (JSON.parse(init!.body as string) as { methodCalls: Call[] }).methodCalls;
    calls.push(...batch);
    const methodResponses = batch.map(([method, args, id]) => {
      if (method === `${collection}/query`) {
        const position = args.position as number;
        return [method, { queryState: options.state ?? 'q1', position,
          ...(options.omitTotal ? {} : { total: data.length }),
          ids: options.empty ? [] : data.slice(position, position + Math.min(args.limit as number, 3)).map(item => item.id) }, id];
      }
      return [method, { list: data.filter(item => (args.ids as string[]).includes(item.id) && !(options.missing && item.id === '0')), notFound: [] }, id];
    });
    return { ok: true, status: 200, text: async () => JSON.stringify({ methodResponses }) } as Response;
  });
  const client = new JMAPClient('https://mail.test', 'alice', 'test-only');
  Object.assign(client, { apiUrl: 'https://mail.test/jmap', accountId: 'a',
    accounts: { a: { accountCapabilities: { 'urn:ietf:params:jmap:contacts': {}, 'urn:ietf:params:jmap:calendars': {}, 'urn:ietf:params:jmap:filenode': {} } } },
    capabilities: { 'urn:ietf:params:jmap:core': { maxObjectsInGet: 5 }, 'urn:ietf:params:jmap:contacts': {}, 'urn:ietf:params:jmap:calendars': {}, 'urn:ietf:params:jmap:filenode': {} },
  });
  return { client, calls };
}
afterEach(() => vi.restoreAllMocks());

describe('real JMAP bounded query protocol', () => {
  it.each(['Email', 'ContactCard', 'CalendarEvent', 'FileNode'] as const)('keeps %s counts exact and advances by the server-clamped page, not the requested limit', async collection => {
    const { client, calls } = server(collection);
    const first = await client.queryReadPage({ collection, filter: {}, position: 0, limit: 100 });
    expect(first).toMatchObject({ total: 1203, position: 0, queryState: 'q1' });
    expect(first.items.map(item => item.id)).toEqual(['0', '1', '2']);
    const next = await client.queryReadPage({ collection, filter: {}, position: first.items.length, limit: 100, queryState: first.queryState });
    expect(next.items.map(item => item.id)).toEqual(['3', '4', '5']);
    expect(calls.every(([method]) => method === `${collection}/query` || method === `${collection}/get`)).toBe(true);
    expect(calls[0][1]).toMatchObject({ calculateTotal: true, limit: 5 });
    expect(calls[1][1].ids).toEqual(['0', '1', '2']);
  });

  it('does count-only in one query, without bodies or a /get', async () => {
    const { client, calls } = server('Email');
    expect(await client.queryReadPage({ collection: 'Email', filter: {}, position: 0, limit: 0 })).toMatchObject({ total: 1203, items: [] });
    expect(calls).toHaveLength(1);
  });

  it('walks all 1203 records over 401 server-clamped pages, without duplicates or a 12-call ceiling', async () => {
    const { client } = server('Email');
    const ids: string[] = [];
    let queryState: string | undefined;
    let total = 1;
    while (ids.length < total) {
      const page = await client.queryReadPage({ collection: 'Email', filter: {}, position: ids.length, limit: 100, queryState });
      queryState = page.queryState;
      total = page.total;
      ids.push(...page.items.map(item => item.id));
    }
    expect(ids).toHaveLength(1203);
    expect(new Set(ids).size).toBe(1203);
    expect(ids.at(-1)).toBe('1202');
  });

  it.each([{ omitTotal: true }, { missing: true }, { empty: true }])('refuses an unprovable or incomplete page: %j', async options => {
    const { client } = server('Email', options);
    await expect(client.queryReadPage({ collection: 'Email', filter: {}, position: 0, limit: 5 })).rejects.toThrow(/required|queryChanged|no progress/);
  });

  it('detects query-state invalidation before fetching records', async () => {
    const { client, calls } = server('Email', { state: 'changed' });
    await expect(client.queryReadPage({ collection: 'Email', filter: {}, position: 3, limit: 5, queryState: 'q1' })).rejects.toThrow(/queryChanged/);
    expect(calls).toHaveLength(1);
  });

  it('offers the same continuation contract in the browser-only demo', async () => {
    const client = new DemoJMAPClient();
    const first = await client.queryReadPage({ collection: 'Email', filter: {}, position: 0, limit: 2 });
    const next = await client.queryReadPage({ collection: 'Email', filter: {}, position: 2, limit: 2, queryState: first.queryState });
    expect(first.total).toBeGreaterThan(4);
    expect(new Set([...first.items, ...next.items].map(item => item.id)).size).toBe(4);
    await client.deleteEmail(first.items[0].id);
    await expect(client.queryReadPage({ collection: 'Email', filter: {}, position: 2, limit: 2, queryState: first.queryState })).rejects.toThrow(/queryChanged/);
  });
});
