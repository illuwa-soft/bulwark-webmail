# Plugin-owned embedded views

`ui.embeddedView(command)` displays an approved external document inside the calling plugin's app page or native Files editor. The host owns frame authority and lifecycle. The plugin owns application controls, backend requests, message schemas, and the meaning of completion.

## Authority and placement

The caller needs consent for `ui:embedded-view` and its surface permission: `ui:app-page` for `app-page`, or `ui:files` for `file-editor`. It must own a mounted surface and the bridge-owned identity of that exact sandbox instance. Background instances, other slots, other plugins, and another instance of the same plugin cannot use its handle. Removing the caller, changing accounts, or revoking authentication disposes the view and pending event wait.

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

### Native Files integration

The [slot catalog](lib/plugin-slot-catalog.ts) exposes provider-neutral surfaces:

- `file-create-actions`: `ui.setActions` adds entries to the existing writable folder's context menu. With `files:read`, `onAction` receives the captured `parentId`, native `accountId`, and display `path`. The provider owns name collection and content generation.
- `file-open-actions`: `ui.setActions` declares a common editor with `fileExtensions`, an explicit list of 1–20 extensions without dots or wildcards. Native double-click and Edit use the first matching declaration in registry order; the file's context menu also offers each matching provider. Directories never match. Opening mounts the selected provider's frame rather than invoking a background action.
- `file-editor`: the selected provider receives a credential-free `file` projection with its bare native ID and its native `accountId`, gated by `files:read`. It occupies the listing pane to the right of the native explorer, without a fullscreen dialog. Approved embedded views are frameless in this pane; app-page views retain their host chrome.
- `file-editor-actions`: the exact live `file-editor` frame can declare bounded controls in the existing Files toolbar with `ui.setActions`. The click is delivered to that same frame's `onAction`, with permission-filtered `file` and `accountId`; it never goes to a background instance. Controls support boolean `disabled` and a bounded `description` tooltip. Workspace IDs and invocation authority are host-created, not accepted from action JSON. Teardown removes only the declaring instance's controls.

The left explorer includes folders and regular files from the same native listing; it does not fetch metadata or bodies per row. File leaves use native reveal/open, while folders retain navigation, resizing, favorites and existing context actions. Folder changes, file replacement, account attachment changes and sidebar mutations wait for the selected provider's leave decision. Denied or concurrent transitions cannot replace the active document, and late completions cannot dismiss a newer workspace. Cached tree entries are cleared on account detach and late listings are fenced by client and parent identity.

`files.refresh()` requires `files:read` and reloads the native listing without navigating. It is an explicit provider request: closing a workspace never triggers a metadata read by itself. `ui.closeFileEditor()` requires `ui:files`, a live `file-editor` caller, the same plugin, and the exact owning DOM subtree. It waits for that workspace's opaque leave decision, then dismisses the view. A background or foreign instance cannot close it. Providers must validate the expected native account against their authenticated backend; an account ID is context, not authority.

The host owns declaration validation, provider selection, credential-free file context, consent, frame authority, generic display controls, and leave-event delivery. The provider owns supported formats, name collection and templates, connection availability, document protocols, completion verification, reconciliation requests, and application-specific failures. A read-only Markdown or vector reader can close without any file mutation or listing reload; a CAD or document editor can explicitly refresh before releasing its view. The host neither inspects nor assumes a save receipt.

The host contains no Office document templates, provider credentials, or save-receipt interpretation. Existing native rename, move, upload, and delete remain the CRUD implementation. Without a matching editor provider, existing WOPI, preview, and download selection applies.

Tests: [inline layout, file tree and native gestures](components/files/__tests__/files-plugin-surfaces.test.tsx), [Markdown/CAD workspaces and denied transitions](components/files/__tests__/plugin-file-editor-generic.test.tsx), [instance-scoped controls](lib/__tests__/plugin-file-editor-actions.test.ts), [extension and close ownership](lib/__tests__/plugin-file-editors.test.ts), and [embedded instance guards](lib/__tests__/embedded-view-controller.test.ts).

- [controller.ts](lib/plugin-embedded/controller.ts): ownership, bounded events, leave acknowledgement, and account fences.
- [requests.ts](lib/plugin-embedded/requests.ts): mounted pages and authentication lifecycle integration.
- [embedded-workspace.tsx](components/plugins/embedded-workspace.tsx): retained plugin DOM and sibling placement.
- [embedded-view-controller.test.ts](lib/__tests__/embedded-view-controller.test.ts): multiple provider URLs, forged messages, ownership, detach, timeout, and payload limits.
- [embedded-view-api.test.ts](lib/__tests__/embedded-view-api.test.ts): consent, calling instance, and manifest validation.

The companion [EuroOffice plugin](https://github.com/illuwa-soft/bulwark-eurooffice-gateway) owns document generation, its session, save/close protocol, storage confirmation, and recovery UI. Its native-browser probe imports the host's actual Files component and stylesheet; gateway protocol and remote-renderer verification are separate checks. Installing or deploying the complete webmail application requires the operating profile.
