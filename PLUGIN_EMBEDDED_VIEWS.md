# Plugin-owned embedded views

`ui.embeddedView(command)` displays an approved external document inside the calling plugin's app page. The host owns frame authority and lifecycle. The plugin owns application controls, backend requests, message schemas, and the meaning of completion.

## Authority and placement

The caller needs consent for `ui:embedded-view` and `ui:app-page`, its own mounted app page, and the bridge-owned identity of that exact sandbox instance. Background instances, other slots, other plugins, and another instance of the same plugin cannot use its handle. Removing the caller, changing accounts, or revoking authentication disposes the view and pending event wait.

The manifest declares `frameOrigins` and `framePaths`. Origins must match an exact, separate HTTPS origin; wildcard origins do not authorize host-owned views. Paths are exact entries or trailing-slash prefixes, with at most 32 entries. URL credentials, escaped paths, undeclared paths, and same-origin documents are rejected. Commands cannot supply headers, scripts, or sandbox flags.

`EmbeddedWorkspace` keeps the plugin sandbox mounted while `EmbeddedView` displays a sibling iframe with `allow-scripts allow-same-origin allow-forms`. The external origin never inherits the mail origin. The plugin sandbox retains its isolation. Lite hides this surface and rejects calls; the implementation contains no provider backend endpoint.

## Commands

The input union is defined in [contracts.ts](lib/plugin-embedded/contracts.ts). Every command rejects extra fields.

| Action | Input besides `action` | Result |
| --- | --- | --- |
| `open` | `url`, `title` | `{ id }`; one active view per page |
| `next` | `id` | One `loaded`, `message`, `leave`, or `idle` event; `null` after disposal |
| `post` | `id`, `data` | Forward bounded JSON to the external frame |
| `update` | `id`, optional `detached`, optional `preventUnload` | Update presentation or the unload warning |
| `reply` | `id`, `requestId`, `allow` | Accept or deny the matching leave request |
| `close` | `id` | Dispose the view and acknowledge pending leave; idempotent for its owner |

`next` permits one outstanding wait per view and returns `idle` after 20 seconds. The queue holds at most 16 events. JSON messages are limited to 65,536 UTF-16 code units after serialization.

## Frame messages

Each frame load receives `{ source: 'bulwark-embedded-host', type: 'init', id, channel }` at its exact origin. The channel rotates on each load. The external document verifies its parent window and expected parent origin, then sends `{ source: 'bulwark-embedded-view', id, channel, payload }` back to that origin. The host verifies the actual frame window, origin, handle, and channel before delivering the payload through `next`.

`post` delivers `{ source: 'bulwark-embedded-host', type: 'message', id, channel, payload }`. The host does not interpret provider status, file identifiers, or save receipts. Plugins use existing permission-gated HTTP APIs for authenticated backend requests; this view API adds no HTTP authority.

## Leaving

App links, browser history, account switching, voluntary logout, and the host Close button request a `leave` event with a request ID and reason. The plugin finishes or cancels its own workflow, then closes the view or replies to that request. `update` with `detached: true` removes the external frame while keeping the plugin visible and its leave protection active, for applications that need cleanup after frame removal.

The host waits at most 180 seconds. A denial or timeout keeps the view open and exposes an explicitly confirmed host-owned close without waiting. This exit does not assert that application work was saved. Forced authentication teardown never waits for plugin approval. Browser unload can only warn through `preventUnload`, which defaults to true; it cannot await asynchronous saving.

## Implementation and verification

- [controller.ts](lib/plugin-embedded/controller.ts): ownership, bounded events, leave acknowledgement, and account fences.
- [requests.ts](lib/plugin-embedded/requests.ts): mounted pages and authentication lifecycle integration.
- [embedded-workspace.tsx](components/plugins/embedded-workspace.tsx): retained plugin DOM and sibling placement.
- [embedded-view-controller.test.ts](lib/__tests__/embedded-view-controller.test.ts): multiple provider URLs, forged messages, ownership, detach, timeout, and payload limits.
- [embedded-view-api.test.ts](lib/__tests__/embedded-view-api.test.ts): consent, calling instance, and manifest validation.

The companion [EuroOffice plugin](https://github.com/illuwa-soft/bulwark-eurooffice-gateway) owns its document session, save/close protocol, storage confirmation, and recovery UI. Its real-service fixture imports this host component and controller. That fixture is separate from installing or deploying the complete webmail application.
