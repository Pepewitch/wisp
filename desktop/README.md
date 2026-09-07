# desktop

The Wisp desktop shell for Apple Silicon macOS: a Tauri 2 application whose
webview runs the **same** React bundle the daemon serves in a browser
(`web/ui-dist/index.html`), plus a native core that lets that one bundle talk to
several independent Wisp daemons at once.

Start with the repository-wide [architecture](../docs/ARCHITECTURE.md), then
use [the desktop transport contract](../docs/DESKTOP-TRANSPORT.md) for the
security boundary implemented here.

The alpha requires macOS 12.3 or newer on Apple Silicon. Local and ordinary CI
builds are ad-hoc signed. Starting with alpha.9, the tag release pipeline
requires Developer ID signing, notarization, stapling, and updater signing
before publication. The published alpha.8 predates that pipeline and remains
ad-hoc signed.

Status: working alpha. The shared React application selects the desktop runtime
when launched by Tauri, shows connection tabs, and binds every daemon-owned
operation and client record to an immutable connection ID.

Desktop support is a second runtime behind the `DaemonTransport` interface,
not a change to how the browser build authenticates. Shared React changes must
still be checked in both runtimes because the exact same generated bundle ships
in each product.

Application zoom is the webview's one direct native UI capability. The desktop
provider applies the persisted 50–200% level through Tauri's narrowly scoped
`set_webview_zoom` permission and owns the standard Command + `+`, `-`, and `0`
shortcuts. The browser runtime mounts no zoom provider and keeps the browser's
own zoom behavior.

Desktop updates are a native capability, not a daemon route. The Update Center
shows one global application row and one selected-daemon row with explicit
labels. Native code owns the channel endpoint, updater key, candidate, download,
installation path, and relaunch. The webview can only request a check and
confirm the exact version it was shown. See
[`docs/DESKTOP-UPDATES.md`](../docs/DESKTOP-UPDATES.md).

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
| `src-tauri/src/external.rs` | The two actions that leave the app: opening a web link, revealing a file |
| `src-tauri/src/urls.rs` | Which addresses are allowed, and how a client path joins one |
| `src-tauri/src/probe.rs` | The authenticated `/api/capabilities` handshake |
| `src-tauri/src/setup.rs` | Local diagnosis plus confirmed `wisp init` / Homebrew service repair |
| `src-tauri/src/notifications.rs` | macOS task notifications and the click that reopens the task |
| `src-tauri/src/updater.rs` | Fixed-channel discovery, signed app installation, status events, relaunch |
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

## The webview content policy

`tauri.conf.json` carries the CSP, and the packaged app is the only client that
has one — the daemon serves the identical bundle to a browser with no policy at
all. So this file is where a shared-UI capability quietly becomes
desktop-specific, and the terminal is the surface that proves it.

`style-src` allows `'unsafe-inline'` because xterm.js has no other delivery
mechanism: its DOM renderer sets the terminal's font family and size,
`white-space: pre`, the cell metrics, and every ANSI colour class through
`<style>` elements it creates *after* load, and the terminal pane injects
xterm's own stylesheet the same way.

That declaration is not self-enforcing. Tauri rewrites the packaged HTML at
compile time, stamping a nonce onto every `<style>` element and appending it to
`style-src` — and a source list carrying a nonce makes CSP **ignore**
`'unsafe-inline'`. The declared policy then allows inline stylesheets while the
effective one refuses them, so `dangerousDisableAssetCspModification` opts
`style-src` out of that rewrite. `script-src` keeps its Tauri-managed nonces
and hashes; only the style directive is ours to state.

The failure mode is why `src-tauri/tests/webview.rs` asserts the document and
CSP hashes Tauri actually produces, rather than the config we wrote: a refused
stylesheet does not throw or blank the pane. It renders a live, working shell
in the proportional body font with no colours and the accessibility helper
textarea showing through — wrong in a way only a packaged-app build reveals.

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
| `open_external_url` | `url` | `void` |
| `notify_task_transition` | `notification: { connectionId, taskId, title, body }` | `void` |
| `desktop_update_status` | — | `DesktopUpdateStatus` |
| `check_desktop_update` | — | `DesktopUpdateStatus` |
| `install_desktop_update` | `confirmedVersion` | `DesktopUpdateStatus` |
| `relaunch_desktop` | — | `void` |
| `reveal_worktree_file` | `connectionId`, `worktreePath`, `path` | `void` |

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

`open_external_url` is the only command that takes no connection: a link in a
task's prose belongs to the internet, not to the daemon that reported it. It
exists because the webview has no new-window handler, so `target="_blank"` is
inert in the packaged app and every PR link did nothing. `src/external.rs`
opens `http` and `https` only, and hands the launcher the reparsed URL rather
than the string the webview sent.

`reveal_worktree_file` is the other half of that module, and the difference is
the point: it *reveals* rather than opens, so Finder selects a file and nothing
runs it. "Open with the default application" stays absent — the path came from
a link an agent wrote, and that is not a thing to hand to LaunchServices. Local
only, gated like the folder picker, because a remote daemon's worktree is on
another machine; the join happens in Rust so `..` is declined rather than
resolved. Reading a file is not here at all: the daemon that owns the worktree
serves it, which is what gives the browser the same viewer.

**Task notifications** run the other way around from every other command. The
shared React app already holds every connection's task list (the active tab
through its query cache, the inactive tabs through their attention monitors),
so it decides when a running turn has ended in `done`, `needs-input`, `failed`,
or `stuck` and calls `notify_task_transition` with the words to show. Native
code validates the IDs, posts through Apple's `UNUserNotificationCenter`, and
stays the center's delegate for the life of the process. A click on the banner
emits the `desktop://focus-task` event with `{ connectionId, taskId }` and
brings the main window forward; the React shell persists that selection,
switches tabs if needed, and selects the task. The one suppressed case is the
task already on screen in a focused window. `tauri dev` runs an unbundled
binary with no bundle identifier, so notifications are off there and the
command answers with an error the UI ignores; only `Wisp.app` can post. The
first banner triggers the standard macOS permission prompt.

Keychain read failures leave only that connection `ready: false` with a
secret-free `problem`. Deferred deletion failures appear in `cleanupIssues`;
the route is already revoked, and **Reset desktop data** or the next launch
retries the persisted tombstone.

Errors are relayed with the daemon's own status and body, so the existing
`ApiError` handling works unchanged. Responses the *proxy* generated carry an
`x-wisp-proxy-error` header naming the reason.

## Build and test

Changes to the native command or proxy contract must update its TypeScript
bridge and tests in `web/ui` in the same change. Changes to shared UI, daemon
routes, auth, streams, terminals, media, or update behavior must verify both
the daemon-served browser path and this desktop path; native-only verification
does not cover code embedded in both clients.

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
and bundles for `aarch64-apple-darwin`. A local build receives an ad-hoc
signature and is **not** a distributable release. The tag workflow replaces
that posture with a timestamped Developer ID signature, hardened runtime,
notarization, and a stapled ticket. Nothing in this tree disables Gatekeeper;
an ad-hoc development build may require the normal Finder Open confirmation.

## Install and release

The public desktop package is a Homebrew Cask:

```sh
brew install --cask Pepewitch/tap/wisp-desktop
```

The Cask installs `Wisp.app` and declares the separate Wisp Formula as a
required dependency, so a machine without the CLI/daemon receives it in the
same Homebrew transaction. The app never bundles or owns a daemon child; Local
uses the standard Formula service and asks before initializing or starting it.

`scripts/release-desktop.ts` builds from a clean source identity, checks that
the Cargo, Tauri, plist, and compiled user-agent versions agree, verifies the
arm64-only Mach-O deployment minimum and complete signature, rejects an
unexpected bundle member or builder path, and produces a deterministic
`Wisp.app` archive plus manifest and checksums. The tag workflow first rebuilds
the ad-hoc payload with a second isolated Cargo target and requires byte-identical
output. It then creates one timestamped, Developer ID signed and notarized
archive, updater-signs those exact bytes, independently verifies both trust
chains, and publishes the update channel only after anonymous verification.
The full contract is in [Desktop updates](../docs/DESKTOP-UPDATES.md).

Uninstalling the Cask quits and removes the app but does not delete native
metadata or Keychain entries. Remove remote connections or use **Reset desktop
data** first when credentials should be removed. This is deliberate: the Cask
does not guess that uninstall means destructive credential cleanup.

## Dependency notes

* `reqwest` and `tokio-tungstenite` are both pinned to `rustls-tls-native-roots`
  so REST/SSE and the terminal upgrade share one TLS stack that trusts the macOS
  system roots.
* `objc2-user-notifications` (with `objc2`, `objc2-foundation`, and `block2`,
  which Tauri already builds) binds `UNUserNotificationCenter` directly. The
  official `tauri-plugin-notification` posts through `notify-rust` on desktop
  and cannot report a click, and a task banner that cannot open its task is
  not worth showing.
* `security-framework` is used directly instead of the cross-platform `keyring`
  crate: `keyring` 4.x moved its platform stores behind a separate
  `keyring-core` registration step, and this crate only targets macOS.
* `getrandom` rather than `rand` for the capability and connection IDs — the OS
  CSPRNG with an API that does not churn between majors.
