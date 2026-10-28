# Read-only plugin query pages (fork extension)

## File preview bytes

`api.files.readContent(fileId)` requires `files:read` and returns
`{ id, name, type, size, data: ArrayBuffer }` for one regular primary-account
FileNode. The host chooses its blob and owning files account; plugins never
receive credentials, download URLs or blob IDs. Cross-account selectors and
directories are refused. Metadata and actual content both obey the existing
25 MiB IPC response cap; larger files fail explicitly. A session switch or
permission revocation during the read discards the result. `files.readText`
retains its separate 64 KiB UTF-8 prefix contract.

This fork adds bounded queries for large mail, contact, calendar and file collections.
They use the current login's existing JMAP client in Full and Lite. No access token,
arbitrary JMAP request, write method, server credential or new dependency is exposed.

| Sandbox API | Permission | Result items / total unit |
| --- | --- | --- |
| `api.email.query(options?)` | `email:read` | `EmailSummary` / messages |
| `api.contacts.query(options?)` | `contacts:read` | `ContactView` / contact cards |
| `api.calendar.queryEvents(options?)` | `calendar:read` | `CalendarEventView` / stored event records |
| `api.files.query(options?)` | `files:read` | `FileQueryItem` / server-query FileNodes |
| `api.files.readText(id, { maxBytes? }?)` | `files:read` | bounded UTF-8 text prefix of that FileNode |

Types live in `lib/plugin-read-types.ts`. The transport method is `contact.query`,
but the sandbox module's public namespace is **`contacts`**, as for existing APIs.
Existing `search`, `list` and expanded `calendar.getEvents` contracts are unchanged.

## Exact counts and continuation

```ts
const count = await api.email.query({ limit: 0 }); // one /query, no /get
let cursor: string | undefined;
do {
  const page = await api.email.query({ from: 'billing@example.test', limit: 50, cursor });
  await savePageAndCheckpoint(page.items, page.nextCursor); // application-owned
  cursor = page.nextCursor ?? undefined;
} while (cursor);
```

Each page contains `items`, `total`, `position`, `queryState`, `nextCursor` and
`accountId`. `limit` is 0-100 (default 25); zero returns only the exact count and
no continuation. Responses are capped at 256 KiB; reduce the page size if a
record-heavy page exceeds it. There is no full-collection materialization.
The client respects `maxObjectsInGet` and advances by the actual returned ID
count: a server-clamped short page is not mistaken for the end.

An exact `total` and `queryState` are required from the server. Unsupported or
failed queries throw; a missing count is never reported as zero. An incomplete
`/get`, lost record, empty non-terminal page or changed query-state throws
`queryChanged`/an explicit error rather than silently declaring completion.
On `queryChanged`, discard the old aggregate and start a new query. A query-state
protects membership/order, not an immutable snapshot of record body bytes.

Cursors bind the plugin, server/login, primary resource account, method, normalized
filter and calendar time zone. They survive an iframe reload but are untrusted
continuations, not credentials. Permissions and the active login are checked again
after asynchronous reads. Changing login or revoking permission discards the result.
Do not alter or log cursors. Preserve the filters on every continuation request.

## Scope and filters

Every query covers **one primary account for that resource**, not all connected or
delegated accounts. `accountId` identifies the counted scope. Mail covers the whole
primary mail account unless `mailboxId` is given. It is not a unified-inbox count.

- Mail: `text`, `from`, `to`, `subject`, `after`, `before`, `hasAttachment`, `mailboxId`.
- Contacts: `text`, `addressBookId`.
- Calendar: `text`, `from`, `to`, `calendarId`. Bounds are optional ISO dates/times.
  Recurrences are **not expanded**; one series counts as one stored record, not
  its occurrences. Existing range-view expansion is a different API.
- Files: `name`, `type`, `parentId` (null = root; omitted = all queryable nodes).
  On old Stalwart versions FileNode/query omits directories; this total describes
  that server query and must not be presented as an exhaustive directory-tree count.

`files.readText` first resolves the FileNode and reads only its own blob in the
files account. It refuses directories/binary MIME types. `maxBytes` is 1-65536
(default 24000); `truncated` explicitly marks a prefix. It is not a PDF/Office
parser or a promise to return a whole large file. Metadata queries expose no blob IDs.

## Durable consumers

Keep aggregate/checkpoint ownership in the consumer, persist one page atomically,
and never put an unbounded array into an LLM prompt. Flue consumers can checkpoint
each page/aggregate delta with a stable `step.do` key. They must also own cancellation,
reconnect, consent, quotas and retry policy; pagination alone supplies none of them.

This is an implementation example for an upstream API Discussion, not an upstream PR.
