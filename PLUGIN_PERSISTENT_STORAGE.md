# Account-scoped persistent plugin storage

This fork adds `api.storage.persistent` for small JSON state owned by one
plugin and one authenticated native account. It is independent of the fork's
file-query/CRUD extensions. Existing `api.storage.get/set/remove/keys` keep
their browser-local behavior.

## Public API

The manifest declares `storage:persistent-read` for `get`/`keys` and
`storage:persistent-write` for `set`/`remove`. Both appear in the permission
dialog. English and Korean descriptions are provided; the other locale files
currently carry English descriptions for these new permissions.

```js
const state = await api.storage.persistent.get('preferences');
// Missing: { value: null, revision: null }. A stored null has a non-null revision.
const saved = await api.storage.persistent.set(
  'preferences',
  { showPreview: true },
  { expectedRevision: state.revision },
);
await api.storage.persistent.keys();
await api.storage.persistent.remove('preferences', {
  expectedRevision: saved.revision,
});
```

`set` and `remove` require the observed revision. `null` means the key must be
absent. A stale revision rejects with `storage.persistent.conflict`; it never
overwrites a newer record. Other keys are preserved. Revisions are opaque and
carry no authentication authority. The SDK never automatically retries a write.
After a timeout or connection loss, read back the key before deciding what to do.

Errors use stable `storage.persistent.<code>` messages because the existing
sandbox error channel transports messages: `invalid`, `conflict`, `quota`,
`busy`, `unavailable`, `forbidden`, `unauthenticated`, and `accountChanged`.

## Scope and authorization

- The host supplies the plugin/package fingerprint and the active native cookie
  slot. Plugin code cannot select another account or plugin through this API.
- The POST-only `/api/plugin-storage` endpoint checks same-origin requests and
  resolves the canonical account from the encrypted native context cookie.
  A bare token-login claim without a canonical account is refused.
- The server rechecks the exact enabled registry bundle or approved user-upload
  package and its declared read/write permission on every request. An unknown,
  disabled, denied, or different package cannot open a namespace.
- The generic `api.http.post` facade denies this route, including encoded aliases.
  The sandbox rechecks the captured client/account after asynchronous work.
- A sandbox frame is pinned to its authenticated native client. Switching or
  reconnecting an account invalidates that frame's storage calls; reopening the
  frame binds the new session. This also stops an automatic local-data migration
  from writing the old account's values into a newly active account.
- This is a Full-server capability. Installing a package on the server or having
  its exact package approved is required; an unregistered development/user bundle
  is not automatically assigned a server namespace.

## Storage and limits

The implementation uses the existing settings volume:

```text
${SETTINGS_DATA_DIR || <cwd>/data/settings}/plugin-storage/
  <SHA-256 of canonical account + normalized native server URL>/
    <SHA-256 of plugin ID>.enc
```

Each file is AES-256-GCM encrypted with the existing session-secret mechanism
and a distinct `plugin-storage` authenticated purpose. The envelope binds the
account and plugin, so copying authentic encrypted bytes into another namespace
does not grant access. Names and keys do not become filesystem path fragments.

- Keys: 1–256 characters, without control characters.
- Values: JSON only, at most **256 KiB UTF-8**, at most **32** nested containers.
- Namespace: at most **256 keys** and **1 MiB serialized records**, including
  record metadata. Not a file/blob store or a credential vault.
- Responses are `no-store`. There is no server process cache of user values.
- Mutation locking uses exclusive filesystem directories shared across workers,
  then a private `0600` temporary file, fsync, and same-directory atomic rename.
  Deployment assumes workers share the same local persistent volume; it does not
  claim multi-host/NFS consistency.
- A contended lock waits at most about one second, then returns `busy`. A worker
  crash can leave a `.lock` directory. Locks are deliberately never stolen using
  a timer: an operator must confirm no writer is alive before removing a stale
  lock. Previously committed values remain readable.
- Corrupt, wrong-purpose or wrong-owner data fails closed and is retained for
  recovery. An unavailable store does not silently fall back to browser storage.

## Lifecycle and operations

Sign-out, browser cache cleanup, disabling and uninstalling a plugin do not
erase server records. Reinstalling an authorized package under the same plugin
ID can read its account namespace again. Explicit `remove` deletes keys.
Retention/purge UI and account archive integration are follow-up work, not
claims of this API. Back up the settings volume together with its existing
encryption key. Key rotation/recovery and filesystem durability retain the
host's existing operational requirements.

No session expiry, cookie policy, login method, secret value, source-file data,
or existing `/api/settings` payload format is changed by this feature. Deployment
and production installation are separate operations.

## Consumer

Puppy Inbox 0.2.0 uses this API for its seven source paths and file-label
metadata. Browser-local 0.1.0 data is imported only when a server key is absent,
using an absent-key precondition; an existing server record wins. Settings drafts
retain their original revision, and tag changes read the latest snapshot before
one conditional write. No source-file mutation is introduced.

The public contract and generic implementation are suitable for a separate
upstream discussion; naming, limits and lifecycle choices remain reviewable.
