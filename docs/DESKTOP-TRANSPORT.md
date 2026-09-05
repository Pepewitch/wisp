# Desktop transport contract

Status: implementation boundary for the Wisp desktop alpha. This is not an
end-user installation guide and does not claim that the desktop app ships yet.

The desktop application manages several independent Wisp daemons from one UI.
Each daemon remains the source of truth for its projects, tasks, worktrees,
harnesses, terminals, and update state. The desktop process owns only saved
connection metadata, credentials, and connection-scoped UI state.

## Why a transport boundary is required

The browser UI currently assumes that exactly one daemon owns the page. That
assumption is safe for the daemon-served web build, but these process-wide and
same-origin shortcuts cannot be reused by a multi-daemon desktop shell:

| Surface | Current browser behavior | Required desktop behavior |
| --- | --- | --- |
| JSON requests | `fetch("/api/…")`; bearer token from `localStorage` | immutable connection transport; bearer token injected by native code |
| Browser stream auth | `POST /api/session` mints an HttpOnly cookie | desktop does not call `/api/session`; the native hop authenticates upstream |
| Daemon events | one `EventSource("/api/events")` | one lightweight baseline plus event monitor per saved connection |
| Task transcript | one selected-task log `EventSource` | only the active connection/task owns a log stream |
| Terminal | `WebSocket` URL derived from `window.location` | URL is derived from the initiating connection, never the active tab at callback time |
| Attachments | relative `<img src="/api/…">` using the session cookie | connection-qualified proxy URL with no daemon credential in the URL |
| Query cache | one global client and daemon-global keys | every daemon-owned key begins with `connectionId` |
| Connectivity | one global value combining event and log streams | reachability, auth, and selected-log health are separate per connection |
| Daemon update | one global query and a full-page reload on success | update and recovery remain bound to the initiating connection |
| UI bundle | one inlined HTML document served by `wispd` | Tauri loads the same built React application from packaged assets |

The web runtime remains intentionally single-daemon. It keeps same-origin
requests, browser session cookies, and its current token migration behavior.
Desktop support is added behind a runtime interface rather than by making the
web build understand remote credentials.

## Protocol inventory

All daemon API routes except the health probe and session exchange require the
normal daemon token. `GET /api/capabilities` is the compatibility and identity
handshake and must run before a remote connection is saved.

### HTTP request/response

The UI reads or mutates these route families:

- daemon identity and lifecycle: `/api/health`, `/api/capabilities`,
  `/api/update`;
- tasks and actions: `/api/tasks`, `/api/tasks/:id`, task action subroutes,
  `/api/status`, `/api/pull-requests`, and `/api/outbox` (the current
  same-origin session probe);
- daemon-owned configuration: `/api/repos`, `/api/projects`,
  `/api/projects/copy-preview`, `/api/harnesses`, and `/api/suffix-prompts`;
- task content: diffs, skills, probes, queued messages, and attachment bytes.

JSON errors are part of the user-facing contract. A transport must preserve the
upstream status, response body, and relevant content headers. It must not turn a
daemon refusal into a generic proxy failure.

### Server-sent events

`GET /api/events` has transient task, turn, message, and project notifications.
It is an invalidation stream, not a durable snapshot. Every initial connection
and every reconnect therefore performs a baseline refetch before treating the
cache as current.

`GET /api/tasks/:id/log/stream` is a selected-task transcript stream. It emits
named `backlog`, `append`, `turn-end`, and `state` frames and includes heartbeat
comments. The proxy must stream bytes without buffering the response to
completion. Switching connections closes this stream; it never changes the
target of an existing stream.

### WebSocket terminal

`GET /api/tasks/:id/terminal?shell=N` upgrades to the terminal WebSocket. The
socket is bidirectional and shells live on the daemon, keyed by task and shell
number. A proxy must forward upgrade rejection status, text/binary frames,
close, and backpressure without inspecting terminal content.

### Authenticated media

Turn and queued-message attachments are loaded by URL so ordinary `<img>`
elements can display them. The desktop URL names only the immutable connection
and daemon path. Native code injects the credential upstream; neither a query
parameter nor a generated media URL may contain the daemon token.

The daemon-served web bundle is one inlined HTML file. There are no additional
web assets to proxy in the current build, but `assetUrl()` remains part of the
runtime boundary because attachments and future daemon-owned content need the
same connection binding.

## Connection identity and routing

Each transport instance has an immutable desktop `connectionId` and target.
The built-in local connection uses the reserved ID `local`. Remote IDs are
opaque generated identifiers restricted to the ASCII path-segment pattern
`[A-Za-z0-9_-]+`. Display labels are mutable and are never used in routes,
cache keys, or credential lookup.

The desktop loopback route is connection-qualified:

```text
/connections/:connectionId/api/...
```

The native process resolves `connectionId` through saved metadata. A frontend
request cannot supply or override an upstream URL. Editing a saved URL creates
a replacement transport after a successful capability check; it never mutates
the target underneath in-flight work.

Every completion path retains the initiating `connectionId`. Changing the
selected tab cannot retarget a REST mutation, reconnect timer, update poll,
folder picker, attachment, event stream, log stream, or terminal socket.

## Credential and proxy rules

The desktop webview never persists a daemon token. Remote tokens live in the OS
credential service. The local token is read from the standard Wisp profile into
native process memory and is not copied into the credential service.

The native transport must enforce all of these rules before it is production
ready:

1. Bind only to loopback and require a per-launch capability known to the
   packaged webview. A random port alone is not authorization.
2. Accept only packaged-app origins. Origin checking supplements the per-launch
   capability; local clients can forge an `Origin` header.
3. Resolve targets exclusively from native connection state. Reject unknown,
   removed, or cleanup-pending connection IDs before opening an upstream
   request.
4. Allow HTTPS remote URLs. Plain HTTP is accepted only when the URL host is
   the literal IPv4 `127.0.0.1` or IPv6 `::1` loopback address used by a
   user-managed tunnel. `localhost` and other hostnames do not qualify.
5. Disable upstream redirects. No redirect receives an Authorization header or
   selects a new target.
6. Strip upstream `Set-Cookie` and client `Cookie` headers. The desktop does not
   use the daemon's browser-session exchange.
7. Replace, rather than append, upstream `Authorization` with the credential
   selected by native connection state. Never log it.
8. Apply the same authentication and routing rules to JSON, SSE, media, and
   WebSocket upgrades.
9. Preserve TLS verification. Certificate failures are connection-scoped and
   are never bypassed silently.
10. Revoke a connection's route before deleting its saved token and metadata.
    Crash recovery resumes removal from a non-secret tombstone.

## Client state that must be scoped

The connection runtime refactor must classify every current global:

| State | Scope |
| --- | --- |
| tasks, task detail, status, repos, harnesses, suffix prompts | connection |
| pull-request and daemon-update caches | connection |
| selected task and archived visibility | connection |
| transcript generation and selected log health | connection |
| terminal sockets and remembered shell tabs | `(connectionId, taskId)` |
| drafts and pending attachments | `(connectionId, taskId)` or create-dialog connection |
| preferred model and effort | connection |
| auth gate | web runtime: one daemon; desktop runtime: connection |
| theme and purely visual layout preferences | global |

Task IDs are only unique inside one daemon. No cache, storage record, route, or
late callback may use a task ID as a globally unique key.

## Two-daemon proof

The integration spike starts two real `wispd` child processes with independent
homes, credentials, and instance identities. Both are seeded with the same
synthetic task ID. It verifies:

- authenticated capability and task reads remain bound to the intended daemon;
- a token from one daemon is rejected by the other;
- mutating one task produces an event only on that daemon's event stream;
- task-log SSE yields the correct daemon's prompt and output;
- authenticated attachment bytes come from the correct daemon;
- bearer-authenticated terminal WebSockets upgrade and carry bidirectional
  traffic against the correct task worktree.

The proof establishes that the daemon protocols support an immutable
connection transport without browser cookies and catches accidental
cross-daemon assumptions at the server boundary. It deliberately does not
claim that a test client is the shipping native proxy. Loopback-origin binding,
redirect refusal, cookie stripping, credential-service storage, TLS behavior,
and removal revocation remain acceptance gates for the actual Tauri
implementation.

## Runtime interface for the next slice

The shared React application consumes one stable transport per connection:

```ts
interface DaemonTransport {
  readonly connectionId: string
  request<T>(path: string, options?: RequestOptions): Promise<T>
  openEventStream(path: string): EventStream
  openWebSocket(path: string): Socket
  assetUrl(path: string): string
  ensureReady(): Promise<void>
}
```

The first refactor supplies one implicit same-origin transport to the existing
web build and scopes every daemon-owned query key by its reserved connection
ID. No visible connection tabs are required for that refactor. The Tauri
runtime can then provide additional transports without forking the UI or
changing hooks back to global URLs.
