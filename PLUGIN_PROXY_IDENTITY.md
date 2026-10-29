# Account-attested plugin backends

The existing `api.proxy.fetch` can authenticate a companion backend and attest
the current native account. This is a generic Full-edition API: document OCR,
photo indexing and other consumers use the same contract. Processing, databases,
job orchestration and model selection belong to the consuming plugin/backend.

## Manifest and requests

```json
{
  "permissions": ["http:proxy", "files:read"],
  "credentials": {
    "processor": {
      "label": "Processing service",
      "scope": "admin",
      "inject": { "type": "bearer" },
      "originKey": "processorOrigin",
      "secretKey": "processorKey",
      "attestUser": true
    }
  }
}
```

The administrator configures the origin and shared key through existing plugin
configuration. `attestUser` is optional and admin-only; existing credentials keep
their behavior. Attestation requires a nonempty shared key even with `inject:
{ type: 'none' }`. The plugin never receives it.

```ts
const result = await api.proxy.fetch('processor', '/api/jobs', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ fileIds }),
  responseType: 'json',
});
```

Absolute and origin-relative URLs must remain on the configured origin, including
redirects. Existing streaming, cancellation, size limits and proxy rate limits
apply. The host selects the active native cookie slot; plugins cannot override it.

## Backend identity

The host overwrites `X-Bulwark-Identity` with an HS256 JWT signed by the selected
credential's shared key. Its claims are:

- `iss`: public Bulwark origin; `aud`: configured backend origin.
- `sub`: pairwise subject derived from the native server/primary account identity,
  plugin ID and backend origin. Different services/plugins have different subjects.
- `plugin`, `credential`: the selected manifest identifiers.
- `iat`, `exp`: Unix seconds, lifetime 60 seconds.
- Optional `files`: `{ url, token, expiresAt }` for a current file-read grant.

The backend must verify the signature, algorithm, expiry, issuer/audience and its
expected plugin/credential before authorizing requests. It must use `(iss, sub)`
for ownership, never an identity supplied in the request body. `files.url` is on
the issuer origin and includes the installation base path. Native Authorization,
passwords, server URL and Blob IDs are not delegated.

## Explicit background file consent

```ts
await api.proxy.fileGrant('processor'); // PluginFileGrant metadata only
await api.proxy.grantFiles('processor', {
  paths: ['documents/reports'], expiresIn: 3600,
});
await api.proxy.revokeFiles('processor');
```

`grantFiles` also requires `files:read`. The host dialog names the plugin, native
account, backend origin, read-only paths, expiry and continued access after the
window closes. Cancellation creates no grant. Account changes during consent
abort it. Grant metadata is `{ granted, paths, expiresAt }` (UTC milliseconds);
no token is returned to the sandbox. Settings reads do not grant or renew access.
There are 1–100 relative file/folder paths, each at most 500 characters. Expiry is
60 seconds–7 days, default 7 days. Paths resolve to native IDs at approval time.

The host stores native access in its own `SESSION_SECRET`-encrypted files under
`PLUGIN_SECRETS_DIR/file-grants`. Only an opaque, read-scoped capability reaches
the backend through a later proxy JWT. Treat it as a secret; do not log it.

## Scoped resources (backend only)

POST to `files.url` with `Authorization: Bearer <files.token>`:

- `{ "operation": "list", "cursor": "<optional nextCursor>" }` returns
  `{ paths, files, nextCursor }`. Each file has `fileId`, `name`, `path`, `mime`,
  `size`, `modified`, `version`. Pages contain at most 200 files; follow every
  cursor. A changed snapshot is an error, never an apparently complete partial list.
- `{ "operation": "read", "fileId": "...", "version": "..." }` streams one
  file after current ACL, scope and content-version checks. The version is opaque.

The callback supports no arbitrary JMAP commands or writes. Current plugin
permissions, backend/key binding, native account and grant are checked on every
request. Replacing, revoking or expiring a grant invalidates future reads, including
capabilities already stored by a backend. Account recreation, native authentication
failure and backend/key changes also require renewed approval. Already delivered
bytes and existing backend results are not retracted by revocation.

Lite has no grant routes and rejects these SDK methods. Full retains the existing
same-origin mutation gate, outgoing URL guards and administrator-controlled
private-server trust policy.
