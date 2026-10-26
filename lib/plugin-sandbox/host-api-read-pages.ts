import type { InstalledPlugin, Permission } from '../plugin-types';
import type { IJMAPClient } from '../jmap/client-interface';
import type { CalendarEvent, ContactCard, Email, FileNode } from '../jmap/types';
import type { ReadCollection } from '../jmap/read-page';
import type { FileQueryItem, FileText, PluginReadPage } from '../plugin-read-types';
import { contactToView, emailSummary, eventToView } from '../plugin-projection';
import { useAuthStore } from '@/stores/auth-store';
import { getEffectiveTimeZone } from '../timezone';
import { pluginHasPermission } from './permissions';
import { readBoolean, readId, readInteger, readObject, readString, sessionClient } from './host-api-input';

const SPECS = {
  'email.query': { collection: 'Email', permission: 'email:read', fields: ['text', 'from', 'to', 'subject', 'after', 'before', 'hasAttachment', 'mailboxId'] },
  'contact.query': { collection: 'ContactCard', permission: 'contacts:read', fields: ['text', 'addressBookId'] },
  'calendar.queryEvents': { collection: 'CalendarEvent', permission: 'calendar:read', fields: ['from', 'to', 'calendarId', 'text'] },
  'files.query': { collection: 'FileNode', permission: 'files:read', fields: ['name', 'parentId', 'type'] },
} as const;
export type ReadPageMethod = keyof typeof SPECS;
export const MAX_PLUGIN_READ_PAGE_BYTES = 256 * 1024;

function accountFor(client: IJMAPClient, collection: ReadCollection): string {
  if (collection === 'CalendarEvent') return client.getCalendarsAccountId();
  if (collection === 'ContactCard') return client.getContactsAccountId();
  if (collection === 'FileNode') return client.getFilesAccountId();
  return client.getAccountId();
}

function identity(client: IJMAPClient, collection: ReadCollection): string {
  return JSON.stringify([client.getServerUrl(), client.getUsername(), accountFor(client, collection), collection === 'CalendarEvent' ? getEffectiveTimeZone() : null]);
}

function stillAllowed(client: IJMAPClient, owner: string, collection: ReadCollection, plugin: InstalledPlugin, permission: Permission): void {
  if (useAuthStore.getState().client !== client || identity(client, collection) !== owner) throw new Error('read: session changed');
  if (!pluginHasPermission(plugin, permission)) throw new Error(`read: permission "${permission}" was revoked`);
}

async function hash(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

interface Cursor { key: string; state: string; position: number; total: number }

function decodeCursor(value: unknown, key: string): Cursor {
  try {
    const text = readString(value, 'read', 'cursor', 16384, { min: 1 });
    const cursor = readObject(JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(text), c => c.charCodeAt(0)))), 'read', 'cursor', ['key', 'state', 'position', 'total']);
    if (cursor.key !== key || typeof cursor.state !== 'string' || !cursor.state || cursor.state.length > 4096) throw new Error();
    return { key, state: cursor.state,
      position: readInteger(cursor.position, 'read', 'cursor.position', 1, Number.MAX_SAFE_INTEGER),
      total: readInteger(cursor.total, 'read', 'cursor.total', 1, Number.MAX_SAFE_INTEGER) };
  } catch {
    throw new Error('read: invalid cursor or different plugin, account, resource or query');
  }
}

function queryFilter(method: ReadPageMethod, opts: Record<string, unknown>): Record<string, unknown> {
  const filter: Record<string, unknown> = {};
  const mapping: Record<string, string> = { mailboxId: 'inMailbox', addressBookId: 'inAddressBook', calendarId: 'inCalendars' };
  for (const field of SPECS[method].fields) {
    const raw = opts[field];
    if (raw === undefined) continue;
    if (field === 'hasAttachment') { filter.hasAttachment = readBoolean(raw, method, field); continue; }
    if (field === 'parentId' && raw === null) { filter.parentId = null; continue; }
    const isBound = ['after', 'before'].includes(field) || (method === 'calendar.queryEvents' && ['from', 'to'].includes(field));
    const value = readString(raw, method, field, isBound ? 40 : 500, { trim: true, min: 1 });
    if (isBound) {
      if (!/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/.test(value) || Number.isNaN(Date.parse(value))) throw new Error(`${method}: ${field} must be an ISO date`);
      const [year, month, day] = value.slice(0, 10).split('-').map(Number);
      const calendarDate = new Date(Date.UTC(year, month - 1, day));
      if (calendarDate.getUTCFullYear() !== year || calendarDate.getUTCMonth() !== month - 1 || calendarDate.getUTCDate() !== day) throw new Error(`${method}: ${field} must be a real date`);
      const name = field === 'from' ? 'after' : field === 'to' ? 'before' : field;
      filter[name] = method === 'email.query' ? new Date(value).toISOString() : value;
    } else {
      filter[mapping[field] ?? field] = field === 'calendarId' ? [readId(value, method, field)] : value;
    }
  }
  if (typeof filter.after === 'string' && typeof filter.before === 'string' && Date.parse(filter.after) >= Date.parse(filter.before)) throw new Error(`${method}: end must be after start`);
  return filter;
}

function fileItem(node: FileNode): FileQueryItem {
  return { id: node.id, parentId: node.parentId, name: node.name, type: node.type, size: node.size,
    modified: node.modified, isDirectory: node.type === 'd' || node.blobId === null };
}

/** Narrow read-only catalogue; a cursor carries no authority and cannot select a login. */
export async function doReadPage(plugin: InstalledPlugin, method: ReadPageMethod, options: unknown) {
  const spec = SPECS[method];
  const opts = readObject(options, method, 'query', [...spec.fields, 'limit', 'cursor'], true);
  const limit = opts.limit === undefined ? 25 : readInteger(opts.limit, method, 'limit', 0, 100);
  const filter = queryFilter(method, opts);
  const client = sessionClient(method);
  const owner = identity(client, spec.collection);
  const key = await hash(JSON.stringify([1, plugin.id, method, owner, filter]));
  const cursor = opts.cursor === undefined ? null : decodeCursor(opts.cursor, key);
  if (limit === 0 && cursor) throw new Error(`${method}: count starts without a cursor`);
  stillAllowed(client, owner, spec.collection, plugin, spec.permission);
  const page = await client.queryReadPage({ collection: spec.collection, filter, limit,
    position: cursor?.position ?? 0, queryState: cursor?.state });
  stillAllowed(client, owner, spec.collection, plugin, spec.permission);
  if (cursor && (page.queryState !== cursor.state || page.total !== cursor.total)) throw new Error('queryChanged: restart the query');
  let items: object[] = [];
  if (spec.collection === 'Email') items = (page.items as Email[]).map(emailSummary);
  if (spec.collection === 'ContactCard') items = (page.items as ContactCard[]).map(contactToView);
  if (spec.collection === 'CalendarEvent') items = (page.items as CalendarEvent[]).map(eventToView);
  if (spec.collection === 'FileNode') items = (page.items as FileNode[]).map(fileItem);
  const next = page.position + page.items.length;
  if (limit > 0 && next < page.total && page.items.length === 0) throw new Error(`${method}: incomplete page; no progress`);
  const nextCursor = limit > 0 && next < page.total
    ? btoa(Array.from(new TextEncoder().encode(JSON.stringify({ key, state: page.queryState, position: next, total: page.total })), b => String.fromCharCode(b)).join('')) : null;
  const result: PluginReadPage<object> = { ...page, items, nextCursor };
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > MAX_PLUGIN_READ_PAGE_BYTES) throw new Error(`${method}: page too large; reduce limit`);
  return result;
}

/** A FileNode chooses the blob, not the plugin. Only a bounded UTF-8 text prefix crosses the sandbox. */
export async function doFilesReadText(plugin: InstalledPlugin, idArg: unknown, options: unknown): Promise<FileText> {
  const method = 'files.readText';
  const id = readId(idArg, method);
  const opts = readObject(options, method, 'options', ['maxBytes'], true);
  const maxBytes = opts.maxBytes === undefined ? 24000 : readInteger(opts.maxBytes, method, 'maxBytes', 1, 65536);
  const client = sessionClient(method);
  const owner = identity(client, 'FileNode');
  const [node] = await client.getFileNodes([id]);
  stillAllowed(client, owner, 'FileNode', plugin, 'files:read');
  if (!node || node.id !== id || !node.blobId || !/^(text\/|application\/(json|xml|[^;]+\+json|[^;]+\+xml)(;|$))/i.test(node.type)) throw new Error(`${method}: select a readable text file`);
  const data = await client.fetchBlobArrayBuffer(node.blobId, node.name, node.type, client.getFilesAccountId(), maxBytes + 1);
  stillAllowed(client, owner, 'FileNode', plugin, 'files:read');
  const bytes = new Uint8Array(data);
  return { id, name: node.name, type: node.type, text: new TextDecoder().decode(bytes.subarray(0, maxBytes)), truncated: bytes.byteLength > maxBytes || node.size > maxBytes };
}
