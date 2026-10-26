# Host-owned Office editor

`office.openEditor({ fileId })` opens one approved document editor **inside the calling plugin's app page**. It resolves to a native-storage receipt after the final save/close, or `null` after an explicitly acknowledged unconfirmed close. It does not open another browser window.

## Authority and placement

The plugin needs `ui:office-editor`, `ui:app-page`, and `http:post`, including consent for user-installed plugins. Standard package approval rules still apply. The plugin remains `untrusted`; this API does not grant `crypto:full` or the privileged execution tier.

This server-backed feature is excluded from Lite at build time. Lite never mounts `OfficeWorkspace` and refuses the API even if a plugin declares the grants; its export verifier still rejects undocumented server endpoints.

`OfficeWorkspace` keeps the library slot mounted but hidden while `OfficeEditorView` mounts a sibling iframe outside the plugin sandbox. The editor must be on a different exact HTTPS origin listed in the plugin's validated `frameOrigins`. The host accepts only the gateway's `/api/v1/eurooffice/embed/<sessionId>#<one-time-ticket>` document, never a caller-supplied URL, header, or script. The document-server SDK executes on that separate origin, not in the mail window.

The operator routes `/api/v1/eurooffice-plugin` and its upload path to the document gateway. The host POST adapter attaches the current native account's credentials; the plugin and editor do not receive them. The API only works while that plugin's app page has a mounted host. A plugin cannot target another plugin's page.

The companion gateway is [illuwa-soft/bulwark-eurooffice-gateway](https://github.com/illuwa-soft/bulwark-eurooffice-gateway). Its control API, editor origin, Stalwart authorization, and callback protocol are deployment-owned configuration, not arbitrary plugin URLs.

## Lifecycle

- The host pins editor messages to `contentWindow`, exact origin, session, and a new instance channel.
- Ready and dirty messages never establish storage success. Only a matching authenticated gateway receipt establishes the requested Stalwart commit.
- The host disables document input during a force-save and waits for the signed final callback before completing a normal close.
- App links, browser history/unload, account switching, and voluntary logout guard pending edits. Forced authentication teardown disposes the frame immediately.
- Error recovery can read the save receipt without retrying a write. Unconfirmed close requires a separate acknowledgement and never reports a successful save or an undo.
- Account/generation fences discard late responses after a host is disposed. The library retains its folder and search state on return.

There is one editor per app page. The 0.1 integration refuses another editor for the same native user/file version until its previous session closes; cross-tab or cross-account collaborative editing is outside this release's acceptance criteria.

## Verification and rollout

The controller/API/composition tests exercise consent, origin/path injection, forged/stale messages, account changes, storage receipt correlation, close confirmation, and the library's retained DOM. The gateway runs real workerd/D1 protocol tests and a separate-origin browser fixture with the actual host component and live EuroOffice/Stalwart synthetic XLSX data.

This repository's Dockerfile targets Node 24. Use that runtime for the complete test suite; Node 26's Web Storage and URL changes produce unrelated failures in the existing suite. Do not patch unrelated application behavior or disable tests to conceal a runtime mismatch.

Activate only after the gateway origin/control route, D1 migrations/secrets, and ordinary plugin installation have been approved and verified. If the new API is unavailable the companion plugin shows an inline upgrade error; it does not fall back to a popup or privilege elevation. Rolling back the host/plugin disables new editor launches; preserve the gateway's outstanding signed callback window and audit rows until active sessions have finished.
