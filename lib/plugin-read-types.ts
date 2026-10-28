import type { CalendarEventView, ContactView, EmailSummary } from './plugin-types';

/** A page of one primary resource account, not every connected login. */
export interface PluginReadPage<T> {
  items: T[];
  total: number;
  position: number;
  queryState: string;
  nextCursor: string | null;
  accountId: string;
}
export interface PageOptions {
  /** 0 counts without retrieving records; otherwise 1-100, default 25. */
  limit?: number;
  /** Opaque continuation; preserve the query. Not an authentication token. */
  cursor?: string;
}
export interface EmailQueryOptions extends PageOptions {
  text?: string;
  from?: string;
  to?: string;
  subject?: string;
  after?: string;
  before?: string;
  hasAttachment?: boolean;
  mailboxId?: string;
}
export interface ContactQueryOptions extends PageOptions { text?: string; addressBookId?: string }
export interface CalendarQueryOptions extends PageOptions { from?: string; to?: string; calendarId?: string; text?: string }
export interface FileQueryOptions extends PageOptions { name?: string; parentId?: string | null; type?: string }
export interface FileQueryItem {
  id: string;
  parentId: string | null;
  name: string;
  type: string;
  size: number;
  modified: string;
  isDirectory: boolean;
}
export interface FileText {
  id: string;
  name: string;
  type: string;
  text: string;
  truncated: boolean;
}
/** Bounded bytes selected by a FileNode, never by an arbitrary blob id. */
export interface FileContent {
  id: string;
  name: string;
  type: string;
  size: number;
  data: ArrayBuffer;
}
export type EmailQueryPage = PluginReadPage<EmailSummary>;
export type ContactQueryPage = PluginReadPage<ContactView>;
/** Stored series/standalone records, NOT expanded recurrence occurrences. */
export type CalendarQueryPage = PluginReadPage<CalendarEventView>;
export type FileQueryPage = PluginReadPage<FileQueryItem>;
