import type { CalendarEvent, ContactCard, Email, FileNode } from './types';

export interface ReadRecords {
  Email: Email;
  CalendarEvent: CalendarEvent;
  ContactCard: ContactCard;
  FileNode: FileNode;
}
export type ReadCollection = keyof ReadRecords;
export interface ReadPageRequest<C extends ReadCollection = ReadCollection> {
  collection: C;
  filter: Record<string, unknown>;
  position: number;
  limit: number;
  queryState?: string;
}
export interface ReadPageResult<C extends ReadCollection = ReadCollection> {
  items: ReadRecords[C][];
  total: number;
  position: number;
  queryState: string;
  accountId: string;
}

const PROPERTIES: Record<ReadCollection, string[]> = {
  Email: ['id', 'threadId', 'mailboxIds', 'from', 'to', 'subject', 'receivedAt', 'preview', 'keywords', 'hasAttachment', 'size'],
  CalendarEvent: ['id', 'uid', 'calendarIds', 'title', 'description', 'start', 'duration', 'timeZone', 'showWithoutTime', 'locations', 'status', 'participants', 'recurrenceRules', 'keywords'],
  ContactCard: ['id', 'uid', 'addressBookIds', 'kind', 'name', 'emails', 'phones', 'organizations', 'notes', 'anniversaries'],
  FileNode: ['id', 'parentId', 'name', 'type', 'blobId', 'size', 'created', 'modified'],
};

type MethodCall = [string, Record<string, unknown>, string];
type Request = (calls: MethodCall[]) => Promise<{ methodResponses?: unknown[][] }>;

function resultOf(response: { methodResponses?: unknown[][] }, method: string, id: string): Record<string, unknown> {
  const row = response.methodResponses?.find(entry => entry[2] === id);
  if (row?.[0] !== method || typeof row[1] !== 'object' || row[1] === null) {
    throw new Error(`${method}: query unavailable`);
  }
  return row[1] as Record<string, unknown>;
}

/** Reads one bounded server page and translates the public root selector at the wire boundary.
 * 공개 루트 선택자를 전송 경계에서 변환하고 전체 스캔 없이 서버 페이지 하나를 읽습니다. */
export async function queryReadPage<C extends ReadCollection>(
  query: ReadPageRequest<C>,
  accountId: string,
  maxObjects: number,
  request: Request,
  queryOptions: Record<string, unknown> = {},
): Promise<ReadPageResult<C>> {
  const limit = Math.min(query.limit, Math.max(1, maxObjects), 100);
  const method = `${query.collection}/query`;
  const filter = { ...query.filter };
  if (query.collection === 'FileNode' && filter.parentId === null) {
    delete filter.parentId;
    filter.isTopLevel = true;
  }
  const result = resultOf(await request([[method, {
    ...queryOptions, accountId, filter, position: query.position, limit, calculateTotal: true,
  }, 'read-query']]), method, 'read-query');
  if (!Number.isSafeInteger(result.total) || (result.total as number) < 0 ||
      typeof result.queryState !== 'string' || !result.queryState || result.queryState.length > 4096 ||
      result.position !== query.position || !Array.isArray(result.ids) ||
      result.ids.some(id => typeof id !== 'string' || !id) || result.ids.length > limit ||
      new Set(result.ids).size !== result.ids.length) {
    throw new Error(`${method}: exact total and stable queryState are required`);
  }
  if (query.queryState !== undefined && query.queryState !== result.queryState) {
    throw new Error('queryChanged: restart the query; do not combine these pages');
  }
  const ids = result.ids as string[];
  const total = result.total as number;
  if (query.position + ids.length > total || (limit > 0 && ids.length === 0 && query.position < total)) {
    throw new Error(`${method}: inconsistent page; no progress`);
  }
  const page: ReadPageResult<C> = { items: [], total, position: query.position, queryState: result.queryState, accountId };
  if (ids.length === 0) return page;

  const getMethod = `${query.collection}/get`;
  const got = resultOf(await request([[getMethod, { accountId, ids, properties: PROPERTIES[query.collection] }, 'read-get']]), getMethod, 'read-get');
  if (!Array.isArray(got.list) || (Array.isArray(got.notFound) && got.notFound.length > 0)) {
    throw new Error('queryChanged: records disappeared while reading the page');
  }
  const records = new Map((got.list as ReadRecords[C][]).map(item => [item.id, item]));
  if (records.size !== ids.length || ids.some(id => !records.has(id)) || got.list.length !== ids.length) {
    throw new Error('queryChanged: incomplete page; no records were committed');
  }
  page.items = ids.map(id => records.get(id)!);
  return page;
}
