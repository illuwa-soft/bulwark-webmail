# Narrow plugin mutations

The consuming Bulwark Agent task explicitly requests mail, contacts, calendars and
stored-file CRUD, including actual mail submission and moving mail to Trash.
Personal model connections are owned by each user's Agent account-room.

This fork has GitHub Issues disabled. This document records the SDK approach for
the fork PR; it does not claim an upstream design review or authorize production
data changes. Upstream proposals remain Discussions, not unsolicited PRs.

## SDK boundary

- Reuse existing contacts and calendar CRUD and draft creation.
- `email.move` must address the signed-in primary mail account even when the UI
  shows a different or unified view, and must move requested IDs not loaded in UI.
- Add `email.trash` and a narrow plain-text `email.send`, with distinct
  `email:write` / `email:send` permission gates. Sending runs the normal fail-closed
  send guard, send takeover and outgoing transform hooks. A takeover is reported
  as handled, never as a verified submission receipt. Submission acceptance is
  distinct from final recipient delivery; filing errors and rejected recipients
  remain explicit. There is no permanent-delete or raw SMTP/JMAP primitive.
- Add `files.createText`, `files.createDirectory`, `files.update` (name/parent),
  and `files.remove`, bounded to the primary FileNode account. Text creation is
  at most 64 KiB UTF-8. Non-empty directories cannot be removed by this surface.
- Validate every sandbox argument, recheck session/account/permission across
  asynchronous boundaries, and run existing lifecycle hooks. Do not switch the
  user's folder or touch another login's UI state.
- `mutations.scope()` captures a stable, plugin-specific account stamp. The closed
  `mutations.forScope(stamp)` facade checks it inside the host before IPC dispatch,
  including the race where the login changed after a browser-side check. It
  delegates only a fixed semantic catalog through normal resource permission
  gates. The stamp is not a credential or a selector for another login.
- Calendar SDK calls keep the original client across awaited plugin hooks and
  reject a different routed login. Vetoed updates/deletes reject rather than
  resolving a successful void result. Mail update/move batches require an
  `Email/set` acknowledgement for every requested id.

## Consumer execution

The Agent owns an immutable target snapshot and explicit execution review. Writes
use a durable claim before native invocation. A lost/in-flight result is unknown,
not permission to repeat a non-idempotent send/create. Bulk moves are bounded
batches with per-batch receipts; query membership is captured before mutation.
The read-only replay loop must not be reused as a write retry loop.
