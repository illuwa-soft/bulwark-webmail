# Plugin embedded views

API proposal for a Full-edition plugin app page. Upstream acceptance is pending.

`api.ui.embeddedView(command)` displays a separate-origin page alongside the
plugin's retained, opaque sandbox. The host owns frame authority and page/account
lifecycle. The plugin owns its payload protocol, application operations, and
decision about whether it can leave.

```js
const { ui } = require('@plugin-host');
// Called from the mounted app-page slot, after the permissions are granted.
const view = await ui.embeddedView({
  action: 'open',
  url: 'https://canvas.example/workspace/',
  title: 'Example view',
});
const event = await ui.embeddedView({ action: 'next', id: view.id });
```

## Permissions and launch policy

The plugin needs both `ui:app-page` and the high-risk `ui:embedded-view` grant.
The background instance and other slots cannot open or control an embedded view.
The host binds each handle to the exact calling sandbox instance, its mounted
page container, and the active account. A different instance of the same plugin
cannot use the handle.

Declare the origins and launch paths in the manifest:

```json
{
  "permissions": ["ui:app-page", "ui:embedded-view"],
  "frameOrigins": ["https://canvas.example", "https://forms.example"],
  "framePaths": ["/workspace/", "/canvas.html"]
}
```

- The launch URL must use HTTPS and an exact declared origin different from
  Bulwark's origin. Wildcard origins, URL credentials, and undeclared paths fail.
- A path ending in `/` is a prefix; another path is an exact match. Up to 32
  distinct paths of 512 characters each are retained. URL/traversal syntax and
  encoded slash, backslash, or dot escapes are refused.
- `framePaths` checks the launch URL. It does not inspect the external server's
  redirects or nested frames. Use a dedicated origin with an appropriate trust
  boundary; paths do not isolate applications sharing that origin.
- The existing administrator-enabled plugin registry supplies Full's document
  CSP. This API cannot change CSP. After changing approvals or origins, load a
  new document with the updated policy.
- No HTTP permission, request headers, injected script, or caller-selected
  sandbox/clipboard/popup capability is part of this API.

## Commands

The Promise rejects for invalid fields, missing grants, a stale account/caller,
an undeclared launch URL, or an unavailable page host. Unknown fields are refused.
The command types are defined in
[`lib/plugin-embedded/contracts.ts`](lib/plugin-embedded/contracts.ts).

| Command | Fields after `action` | Result and behavior |
| --- | --- | --- |
| `open` | `url`, `title` | Returns `{ id }`. One view per mounted host. The title is nonempty and at most 256 characters; the URL is at most 8,192 characters. |
| `next` | `id` | Returns an event, or null after the view closes. Only one wait may be pending. An empty wait returns `idle` after 20 seconds. |
| `post` | `id`, `data` | Sends bounded JSON to the bound external frame. Rejects before the frame is ready or after it is detached/closed. Returns `{ type: 'ok' }`. |
| `update` | `id`, optional `preventUnload`, optional `detached: true` | Changes the unload warning or removes the external iframe while retaining the plugin and leave protection. Detachment is one-way. Returns `{ type: 'ok' }`. |
| `reply` | `id`, `requestId`, `allow` | Answers exactly the pending leave request. A positive reply disposes the view; a negative reply leaves it open. Returns `{ type: 'ok' }`. |
| `close` | `id` | Disposes the view at the plugin's request. Returns `{ type: 'ok' }`; a repeated close is idempotent while that caller and handle remain valid. |

`data` must be JSON. The normalized representation is limited to 65,536 UTF-16
code units. Undefined values, functions, symbols, bigints, and nonfinite numbers
are refused. The host does not interpret application fields.

## Events and leave decisions

| Event | Meaning |
| --- | --- |
| `{ type: 'loaded' }` | The external frame received its first channel initialization. |
| `{ type: 'message', data }` | Validated JSON from the exact frame, origin, handle, and channel. |
| `{ type: 'overflow', dropped }` | At least that many queued data messages were discarded. The plugin must reconcile through its own protocol. |
| `{ type: 'leave', requestId, reason }` | The host requests permission to leave. Reasons: `close`, `navigation`, `account-switch`, `logout`. |
| `{ type: 'idle' }` | No event arrived during the 20-second wait. |

At most 16 data messages are queued. Overflow drops the oldest data; control
events are retained separately and delivered first. Control events can overtake
queued data. The plugin must establish its own current application state before
approving leave, including reconciliation after overflow.

A host leave request waits at most 180 seconds. A negative reply or timeout keeps
the view open and exposes a separate, user-confirmed **Close without waiting**
action. Retrying normal **Close** asks the plugin again. Neither a positive reply
nor a forced close is a host assertion about application completion.

Browser unload can only warn; it cannot await asynchronous work. The warning is
on by default and follows `preventUnload`. Captured link/history navigation and
voluntary account switch, logout, and logout-all use the leave exchange.
Uncaptured programmatic navigation, page/sandbox teardown, or forced session
expiration disposes the view. Plugins must not rely on unload for durable work.

## External-frame channel

The external iframe has `allow-scripts allow-same-origin allow-forms` and
`referrerPolicy="no-referrer"`. It is a sibling of the retained plugin sandbox.
The plugin sandbox's opaque origin and existing permissions remain in force.

After the first frame load, the host posts the following to the exact launch
origin:

```js
{ source: 'bulwark-embedded-host', type: 'init', id, channel }
```

The external page must check `event.source === parent` and its configured host
origin before accepting initialization or subsequent messages. It sends JSON to
that host origin with:

```js
parent.postMessage({ source: 'bulwark-embedded-view', id, channel, payload }, hostOrigin);
```

The host's `post` command uses
`{ source: 'bulwark-embedded-host', type: 'message', id, channel, payload }`.
The channel is bound once. A reload or navigation that loads a second document
disposes the view instead of transferring authority to the reused `WindowProxy`.
Open a new view for a new document.

## Lite and verification

Lite has no plugin sandbox host. Its existing policy forces plugins off even
when `policy.json` requests them, and forged grants cannot enable this API.
Static-host `frame-src 'self' blob:` and the Stalwart entry policy remain in
force. Neither target enables external plugin frames or eval for this proposal.

The platform kernel and UI have a dependency-boundary test against backend
imports and direct network calls. The browser examples use two unrelated test
origins; their application decisions stay inside the example plugin.
See the [browser verification guide](scripts/embedded-views/README.md) for the
Full/Lite, mobile, theme, and RTL checks.
