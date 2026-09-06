# Wisp architecture

Wisp has one daemon and several clients. The daemon owns every operational
fact; clients choose how to present and transport those facts. The browser and
Wisp Desktop deliberately run the same React application so a task behaves the
same whichever interface is open.

## Runtime topology

```text
                         one shared React application
                       web/ui -> web/ui-dist/index.html
                         /                         \
        daemon-served browser                     Wisp Desktop (Tauri)
        same-origin transport                     native loopback proxy
                  |                               /        |        \
                  |                         Local daemon  Remote A  Remote B
                  |                               |          |        |
                  +-------------------------------+----------+--------+
                                                  |
                                          Wisp HTTP APIs
                                                  |
                          routes -> store + runner + worktrees -> harness
                                      |        |         |
                                    SQLite    logs      Git repos
```

The command-line client also uses the daemon's HTTP API. Closing a browser or
desktop window does not stop a daemon, task, or harness process.

## Ownership boundaries

| Layer | Owns | Does not own |
| --- | --- | --- |
| Daemon | projects, tasks, turns, messages, worktrees, harness execution, logs, terminals, lifecycle, update state | desktop tabs or client layout |
| Shared React app | presentation, connection-scoped query state, navigation, drafts, attachments, stream and terminal clients | daemon credentials or task truth |
| Browser runtime | one implicit same-origin daemon, browser session exchange and cookie | remote connection registry |
| Desktop native core | Local discovery, remote connection metadata, Keychain credentials, native folder picker, authenticated loopback proxy | projects, tasks, or a child daemon |
| CLI | command parsing and presentation over the API | alternate business logic |

SQLite is the durable task ledger. Persisted logs are the turn record, the
event stream is only a realtime invalidation signal, and the webhook outbox is
durable notification delivery. A client must refetch its baseline after an
event-stream reconnect.

## The shared client contract

`web/ui/src/lib/transport.ts` defines `DaemonTransport`. UI code receives a
transport from its runtime instead of constructing daemon URLs itself:

- the browser implementation uses same-origin HTTP, SSE, WebSockets, and
  authenticated asset URLs;
- the desktop implementation uses immutable, connection-qualified proxy URLs;
- every daemon-owned query key and daemon-dependent persisted UI preference is
  scoped by `connectionId`; pure shell geometry and theme may remain global;
- task IDs are unique only inside one daemon;
- delayed callbacks retain the connection that initiated them and may never
  retarget themselves to whichever tab is active later.

The committed `web/ui-dist/index.html` is both the daemon's browser UI and the
desktop app's packaged frontend. There is no separate desktop fork of the
React application.

## Browser request path

The daemon serves the committed UI bundle. The browser keeps the token in
origin-scoped `localStorage` for ordinary same-origin API requests and exchanges
it for an HttpOnly, SameSite=Strict cookie so browser-managed EventSource,
WebSocket, and media requests can authenticate. Tokens never belong in URLs.

This runtime intentionally represents one daemon. Remote browser access is a
networking concern handled with a private HTTPS proxy or SSH tunnel, not a
multi-daemon connection registry.

## Desktop request path

The Tauri webview bootstraps a native loopback proxy with a per-launch
capability. Each route contains an immutable connection ID and route revision;
native code resolves the upstream target and injects its credential. The
webview never receives a saved token.

The built-in `local` connection reads the standard Wisp profile and cannot be
removed, although its display label can be renamed. Remote metadata is stored
by the desktop app and remote tokens are stored in the macOS Keychain. Removing
a remote immediately revokes its route and removes it from the active registry,
then attempts to delete its Keychain credential. A failed deletion is reported
and retained as a tombstone for retry on reset or the next launch. Removal
never contacts or deletes data from that daemon.

A remote URL and token prove identity and authentication only after the daemon
is reachable. They do not create a VPN, tunnel, TLS certificate, firewall
rule, or public endpoint. The supported transport is trusted HTTPS, or plain
HTTP only on the exact loopback address of a user-managed tunnel.

The complete proxy, credential, and connection lifecycle invariants are in
[Desktop transport contract](DESKTOP-TRANSPORT.md). Native implementation
details are in [`desktop/README.md`](../desktop/README.md).

## Project and connection scope

A connection identifies one daemon. A daemon owns zero or more projects, and a
project owns zero or more tasks:

```text
Desktop
├── Local (fixed identity, mutable label)
│   ├── Project A
│   └── Project B
├── Remote A
│   └── Project C
└── Remote B
    ├── Project D
    └── Project E
```

The active desktop tab therefore selects the scope for projects, tasks,
terminals, updates, and all mutations. Local project add can return a native
folder-picker path because the picker and daemon share a machine. A remote
project path must be entered as it exists on the remote daemon's machine.

## Change-impact contract

Treat the browser and desktop shell as two shipped clients of one UI/API
contract. Before changing a shared surface, identify both consumers and record
any deliberate difference.

| Change | Required compatibility review |
| --- | --- |
| `web/ui/src/` shared component, hook, cache, storage, stream, asset, terminal, auth, or update behavior | Exercise the daemon-served browser path and the Tauri runtime; keep state and late callbacks connection-scoped |
| daemon route, public type, authentication, SSE, WebSocket, media, or update behavior | Check the CLI where applicable, browser same-origin transport, desktop native proxy, and capability/protocol compatibility |
| `desktop/src-tauri/` command, metadata, credential, proxy, or Local setup behavior | Update the TypeScript bridge/runtime contract and preserve browser behavior |
| generated UI bundle or packaging | Rebuild `web/ui-dist/index.html`; prove the daemon and desktop package consume the same bytes |
| intentionally browser-only or native-only behavior | Keep the boundary explicit and test that the other runtime is unaffected |

A browser-only verification is insufficient for a shared UI or daemon
contract, and a desktop-only verification is insufficient when the changed
code also ships in the daemon-served bundle. The exact contributor gates live
in [the Wisp development skill](../skills/wisp-dev/SKILL.md).

## Build and distribution

The source workspace is a Bun package with a React workspace and a Rust/Tauri
desktop crate. `bun run build:ui` creates the committed single-file UI bundle;
the daemon binary embeds it and the desktop build packages the same output.

The public macOS distribution keeps the service and interface composable:

- the `wisp` Homebrew Formula installs the CLI/daemon and launchd service;
- the `wisp-desktop` Homebrew Cask installs `Wisp.app` and depends on that
  Formula;
- the desktop app connects to the service but does not bundle, spawn, or stop
  it as an owned child.

See [Apple Silicon installation](INSTALL-MACOS.md) and the
[release playbook](../skills/wisp-dev/references/releasing.md) for current
platform, signing, packaging, and qualification details.
