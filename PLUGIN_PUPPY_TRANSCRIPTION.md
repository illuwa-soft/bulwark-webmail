# Puppy Inbox transcription relay

`POST /api/plugin-puppy-inbox` connects the private `puppy-inbox` plugin to its
Cloudflare transcription Worker. The plugin needs `files:read`, `http:post`, and
the exact `/api/plugin-puppy-inbox` `apiPostPaths` entry. The host checks these
grants and an enabled plugin before forwarding a command.

Set the plugin's admin `origin` to the Worker HTTPS origin and secret `TOKEN`
to its `HOST_SHARED_SECRET`. `LLM_API_KEY` belongs only in the Worker. Deployment,
secret installation and D1 migration application are separate operator steps.

The relay accepts only `sources`, `status`, `transcribe`, and `transcript` POST
commands. It revalidates the current native account, follows same-origin JMAP
discovery redirects, and derives the actor from the verified native origin and
username and immutable native FileNode account ID. Recreating an account with the
same username does not reuse its previous result namespace. It never trusts a
browser-supplied actor.

For browser-independent discovery, the relay seals the native Authorization
with AES-256-GCM using SHA-256 of `TOKEN` as the key and a new 12-byte nonce. The
wire value is base64url(nonce + ciphertext + GCM tag). An HMAC-SHA256 signature
covers newline-joined timestamp, actor, sealed access, method, path and exact
JSON body. The Worker retains only sealed access in D1 and opens it for native
file reads. Neither plaintext access nor the sealed delegation is returned to
the browser. The Worker must be trusted with this account-level delegation.

Source configuration is updated from the inbox and standalone plugin settings.
Native credential expiry/revocation stops background reads until reconnection.
Shared-key rotation requires reconnecting configured accounts. Saving zero
sources stops future discovery; it does not cancel accepted jobs or delete
stored transcripts. Result retention/deletion is owned by the Puppy Worker.

Verification:

```sh
npm exec -- vitest run lib/__tests__/plugin-puppy-inbox-route.test.ts lib/__tests__/plugin-assistant-route.test.ts
npm run typecheck
npm exec -- eslint app/api/plugin-puppy-inbox/route.ts lib/__tests__/plugin-puppy-inbox-route.test.ts
```

The tests use synthetic native identity and Worker responses, and check the
actual HMAC and AES-GCM bytes, route/permission rejection and native redirects.
