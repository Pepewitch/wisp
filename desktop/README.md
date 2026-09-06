# desktop

The Wisp desktop shell for Apple Silicon macOS: a Tauri 2 application whose
webview runs the **same** React bundle the daemon serves in a browser
(`web/ui-dist/index.html`), plus a native core that lets that one bundle talk to
several independent Wisp daemons at once.

The alpha requires macOS 12.3 or newer on Apple Silicon. Release builds are
ad-hoc signed and are not notarized yet; the installation guide must keep that
limitation visible until Developer ID signing is part of the release pipeline.

Status: working alpha. The shared React application selects the desktop runtime
when launched by Tauri, shows connection tabs, and binds every daemon-owned
operation and client record to an immutable connection ID.

The web build is unchanged by any of this. Desktop support is a second runtime
behind the `DaemonTransport` interface, not a change to how the browser build
authenticates.

## Why there is a native core at all

`docs/DESKTOP-TRANSPORT.md` is the contract. The short version: a browser page
gets one origin, one cookie jar, and one `localStorage`, and the current UI uses
all three as if exactly one daemon owned the page. A desktop shell that manages
five daemons cannot borrow any of that, and it must never put a daemon token
somewhere JavaScript can read it. So the credential, the target, and the
transport all live in Rust.

## Layout

| Path | What it owns |
| --- | --- |
| `src-tauri/src/proxy.rs` | The loopback proxy: REST, SSE, WebSocket terminals, attachment bytes |
| `src-tauri/src/registry.rs` | Immutable connection IDs, non-secret metadata on disk, crash-safe removal |
| `src-tauri/src/secrets.rs` | Remote tokens in the macOS Keychain |
| `src-tauri/src/local.rs` | The built-in Local connection, read from the standard Wisp profile |
| `src-tauri/src/urls.rs` | Which addresses are allowed, and how a client path joins one |
| `src-tauri/src/probe.rs` | The authenticated `/api/capabilities` handshake |
| `src-tauri/src/setup.rs` | Local diagnosis plus confirmed `wisp init` / Homebrew service repair |
| `src-tauri/src/core.rs` | The command surface, free of `tauri` types so it is testable |
| `src-tauri/src/commands.rs` | One-line Tauri adapters over `core.rs` |

## The proxy route

```text
http://127.0.0.1:<ephemeral>/<capability>/connections/<id>/<revision>/api/...
```

* The port is ephemeral and bound to the **literal** IPv4 loopback address.
* The capability is 32 CSPRNG bytes minted at launch, compared in constant time,
  and required on every REST, SSE, media, and WebSocket route. It is in the path
  because `EventSource`, `WebSocket`, and `<img src>` cannot set a header. It
  authorizes talking to the proxy — it is never a daemon credential — and it
  dies with the process.
* `Origin` is also checked against the packaged-app origins, but only as a
  supplement: any local process can forge that header.
* The connection ID and route revision are the entire addressing scheme. A
  frontend request names one saved connection generation; there is no code
  path from a frontend string to a host, and stale Local work is refused.
* Everything after `/api` is relayed verbatim, still percent-encoded.

Rules the proxy enforces, each with a test in `src-tauri/tests/proxy.rs`:

1. HTTPS only, except plain HTTP to the literal `127.0.0.1` and `[::1]`
   addresses a user-managed tunnel terminates on. `localhost` does not qualify.
2. Redirects are never followed and never receive a credential; the upstream
   status is relayed with `Location` removed.
3. Client `Cookie` and upstream `Set-Cookie` are dropped.
4. `Authorization` is overwritten, never appended, with the native credential.
5. Frontend-supplied targets are rejected — connection IDs resolve through
   native state only.
6. A removed connection loses its route before its credential is deleted.
7. Before every write and terminal handshake, the daemon's `instanceId` is
   freshly re-proved against `/api/capabilities`; a mismatch is a 409, not a
   silent redirection of a mutation onto a different machine.
8. TLS verification is never relaxed. There is no `danger_accept_invalid_certs`
   in this crate.
9. Packaged-app CORS preflights are answered locally; other origins are
   refused, and proxy error headers are exposed to the webview.
10. Response-header and WebSocket-handshake waits have finite budgets, while
    established SSE, download, log, and terminal streams remain unbounded.
11. Local's non-secret target identity and monotonic revision survive app
    launches. Old revisions receive a native 409, and an open terminal is
    revoked as soon as its revision stops being current.

## Credentials

Remote tokens live in the macOS Keychain (service `dev.wisp.desktop.connection`,
account = the immutable connection ID) and are read into process memory once at
launch so the proxy hot path never blocks on Security.framework. The Local
connection's token is read from the machine's standard `~/.wisp/config.json`
into native memory and is deliberately *not* copied into the Keychain — the
daemon already owns that file, and a second copy is a second thing to revoke.

No command returns a token, `LocalProfile` and `Capability` have redacting
`Debug` impls, and `StoredConnection` has no field a credential could live in.

## Frontend contract

`desktop_bootstrap` returns everything the shell needs to build transports:

```ts
interface Bootstrap {
  proxyBaseUrl: string       // http://127.0.0.1:<port>/<capability>
  activeConnectionId: string
  connections: ConnectionInfo[]
  local: LocalStatus
  cleanupIssues: { connectionId: string; message: string }[]
}

interface ConnectionInfo {
  id: string                 // immutable, [A-Za-z0-9_-]+
  routeRevision: number      // changes if the target behind Local changes
  name: string               // mutable; never used in a route or cache key
  kind: "local" | "remote"
  url: string                // display only
  instanceId: string
  ready: boolean             // false when the credential or profile is gone
  problem: string | null     // scoped, secret-free recovery detail
}
```

A desktop `DaemonTransport` for connection `id` is then:

```ts
const prefix = `${bootstrap.proxyBaseUrl}/connections/${id}/${routeRevision}`
request(path)        -> fetch(prefix + path)          // path starts with /api
openEventStream(p)   -> new EventSource(prefix + p)
openWebSocket(p)     -> new WebSocket((prefix + p).replace(/^http/, "ws"))
assetUrl(p)          -> prefix + p
ensureReady()        -> request("/api/health")
```

The other commands:

| Command | Arguments | Returns |
| --- | --- | --- |
| `select_desktop_connection` | `connectionId` | `void` |
| `probe_remote_connection` | `url`, `token` | authenticated daemon identity |
| `add_remote_connection` | `name`, `url`, `token`, `expectedInstanceId` | `ConnectionInfo` |
| `rename_connection` | `connectionId`, `name` | `ConnectionInfo` |
| `probe_saved_connection` | `connectionId`, `url?`, `token?` | authenticated daemon identity |
| `reconnect_connection` | `connectionId`, `url?`, `token?`, `expectedInstanceId?` | `ConnectionInfo` |
| `remove_connection` | `connectionId` | `void` |
| `reset_desktop_data` | — | `void` |
| `pick_local_project` | `connectionId: "local"` | `string \| null` |
| `setup_local_wisp` | — | `LocalSetupReport` |
| `apply_local_wisp_setup` | `expectedStep` | `LocalSetupReport` |

Two adjustments the React shell has to absorb:

* **`reconnect_connection` may return a different `id`.** Changing a saved URL
  or trusting a new daemon identity at the same URL mints a replacement and
  revokes the old connection, because reusing the ID would carry local state
  across daemon scope.
  Treat a changed `id` as a connection swap, not a field update.
* **A 409 with `x-wisp-proxy-error: identity-changed` is a connection-level
  state**, not a task-level refusal. It means a different daemon now answers a
  saved address; the fix is `reconnect_connection`, and the UI should say so.
* **Native project picking uses a selection generation lease.** The webview
  mirrors tab selection with `select_desktop_connection`; if selection changes
  before the folder dialog resolves, native code refuses the path.

Keychain read failures leave only that connection `ready: false` with a
secret-free `problem`. Deferred deletion failures appear in `cleanupIssues`;
the route is already revoked, and Reset Desktop Data or the next launch retries
the persisted tombstone.

Errors are relayed with the daemon's own status and body, so the existing
`ApiError` handling works unchanged. Responses the *proxy* generated carry an
`x-wisp-proxy-error` header naming the reason.

## Build and test

```sh
cd desktop/src-tauri
cargo test                                # native unit + integration tests
cargo clippy --all-targets -- -D warnings
cargo fmt --all --check
```

```sh
bash scripts/desktop/build-macos.sh             # .app + .dmg
bash scripts/desktop/build-macos.sh --app-only  # .app only
```

The build refreshes `web/ui-dist`, derives `icons/icon.icns` from the committed
`icons/icon.png` (a generated brand asset — run `bun run brand` to change it),
and bundles for `aarch64-apple-darwin`. The complete `.app` receives an ad-hoc
signature, but it is **not Developer ID signed or Apple-notarized**. Nothing in
this tree disables Gatekeeper; the experimental build may require the normal
Finder Open confirmation until release credentials are available.

## Dependency notes

* `reqwest` and `tokio-tungstenite` are both pinned to `rustls-tls-native-roots`
  so REST/SSE and the terminal upgrade share one TLS stack that trusts the macOS
  system roots.
* `security-framework` is used directly instead of the cross-platform `keyring`
  crate: `keyring` 4.x moved its platform stores behind a separate
  `keyring-core` registration step, and this crate only targets macOS.
* `getrandom` rather than `rand` for the capability and connection IDs — the OS
  CSPRNG with an API that does not churn between majors.
