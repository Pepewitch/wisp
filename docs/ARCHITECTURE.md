# Wisp architecture

Each Wisp home defines an independent daemon and owns its own operational
facts. Most clients address one daemon; Wisp Desktop can manage several. The
browser and Wisp Desktop deliberately run the same React application so a task
behaves the same whichever interface is open.

## Runtime topology

```text
                         one shared React application
                         web -> web/ui-dist/index.html
                         /                         \
        daemon-served browser                     Wisp Desktop (Tauri)
        same-origin transport                     native loopback proxy
                  |                               /        |        \
             one daemon                    Local daemon  Remote A  Remote B

             CLI ──HTTP──> one daemon selected by its active profile

Each daemon independently owns:

    HTTP API -> routes -> store + runner + worktrees -> harness process
                            |       |          |
                          SQLite   logs      Git repos
```

The command-line client's task and project operations use the daemon's HTTP
API; setup and diagnostics also inspect the local profile and installation.
Closing a browser or desktop window does not stop a daemon, task, or harness
process.

## Ownership boundaries

| Layer | Owns | Does not own |
| --- | --- | --- |
| Daemon | projects, tasks, turns, messages, worktrees, harness execution, logs, terminals, lifecycle, update state | desktop tabs or client layout |
| Shared React app | presentation, connection-scoped query state, navigation, drafts, attachments, stream and terminal clients | daemon credentials or task truth |
| Browser runtime | one implicit same-origin daemon, bearer credential for every hop | remote connection registry |
| Desktop native core | Local discovery, remote connection metadata, Keychain credentials, native folder picker, authenticated loopback proxy, macOS task notifications, signed application updates | projects, tasks, or a child daemon |
| CLI | task/project API client plus local profile, install, and diagnostic commands | alternate daemon business logic |

For each daemon, SQLite is the durable task ledger. Persisted logs are that
daemon's turn record, the event stream is only a realtime invalidation signal,
and the webhook outbox is durable notification delivery. A client must refetch
its connection's baseline after an event-stream reconnect.

## The shared client contract

`web/src/lib/transport.ts` defines `DaemonTransport`. UI code receives a
transport from its runtime instead of constructing daemon URLs itself:

- the browser implementation uses same-origin HTTP, SSE, WebSockets, and
  authenticated asset URLs;
- the desktop implementation uses immutable, connection-qualified proxy URLs;
- every daemon-owned query key and daemon-dependent persisted UI preference is
  scoped by `connectionId`; pure shell geometry and theme may remain global;
- task IDs are unique only inside one daemon;
- delayed callbacks retain the connection that initiated them and may never
  retarget themselves to whichever tab is active later.

The generated `web/ui-dist/index.html` is both the daemon's browser UI and the
desktop app's packaged frontend. It is ignored by Git: PRs review and validate
the source, while release CI builds one canonical copy for both products. There
is no separate desktop fork of the React application.

## Browser request path

The daemon serves the generated UI bundle. The browser keeps the token in
origin-scoped `localStorage` and presents it explicitly on every hop, because
nothing is authenticated ambiently: ordinary API requests carry the bearer
header, event streams run over `fetch` (`EventSource` cannot set headers), the
terminal socket authenticates in its first frame (a WebSocket handshake cannot
set headers either), and media is fetched and rendered from a blob URL.
Tokens never belong in URLs, and no cookie is a credential.

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

The active desktop tab selects the scope for projects, tasks, terminals, and
ordinary daemon mutations. Updates are the deliberate exception: the global
Desktop surface owns the application plus the built-in **Local daemon**, even
while a remote tab is selected. It never installs an update on a saved remote;
those daemons are updated on their own host or through their own browser UI.
Local project add can return a native folder-picker path because the picker and
daemon share a machine. A remote project path must be entered as it exists on
the remote daemon's machine.

## Where a task's worktree starts

A `worktree` task forks from the project's base branch, not from whatever the
project directory happens to have checked out. The daemon fetches `origin`
(best effort — offline or remote-less repos simply skip it) and resolves, in
order:

1. an explicit per-task base (`wisp new --base <ref>`, or the composer's base
   picker) — an unresolvable one fails the create rather than substituting a
   different commit;
2. the project's configured `baseBranch`, for a repo that integrates on
   `develop` or a release line;
3. `origin/HEAD`, then `origin/main` / `origin/master`;
4. the checkout's `HEAD` — a repo with no remote, and the behaviour of
   every release up to and including 0.5.2.

Step 2 degrades to step 3 rather than failing, because a branch renamed
upstream must not make a project unstartable — and it says so in the task's
state detail, since a silently substituted base is the defect this ordering
exists to remove. The task records the ref it actually forked from in
`base_ref`, alongside the `base_commit` it forked at.

The new branch is created with `--no-track`. With a remote-tracking
start-point git would otherwise set its upstream to `origin/main`, and an
agent running a bare `git push` under `push.default=upstream` would push the
task branch's commits directly onto main.

A `local` task has no base: it adopts the branch the checkout is already on,
which is the point of the mode. Passing a base to one is a 400.

## Change-impact contract

Treat the browser and desktop shell as two shipped clients of one UI/API
contract. Before changing a shared surface, identify both consumers and record
any deliberate difference.

| Change | Required compatibility review |
| --- | --- |
| `web/src/` shared component, hook, cache, storage, stream, asset, terminal, auth, or update behavior | Run the root/UI gate and review both runtime semantics; build the app when Tauri, connection scope, transport, native integration, or release qualification is affected |
| daemon route, public type, authentication, SSE, WebSocket, media, or update behavior | Run focused and root tests; check the CLI where applicable plus browser/Desktop consumers, and run transport/native gates only when those boundaries are affected |
| `desktop/src-tauri/` command, metadata, credential, proxy, or Local setup behavior | Update the TypeScript bridge/runtime contract, run root and native gates, and preserve browser behavior |
| generated UI bundle or packaging | Build `web/ui-dist/index.html` without committing it; prove the daemon and desktop package consume the same release bytes |
| intentionally browser-only or native-only behavior | Keep the boundary explicit and test that the other runtime is unaffected |

An impact review that ignores either shipped client is insufficient for a
shared UI or daemon contract. The executions then follow the affected boundary:
a runtime-neutral style change does not need Cargo, while native transport work
does. Styling is runtime-neutral only when it ships inside the bundle — the
packaged app applies a content policy the daemon-served page does not, so a
stylesheet created after load is a desktop concern (see
[the desktop transport contract](DESKTOP-TRANSPORT.md)). The exact contributor
gates live in
[the Wisp development skill](../skills/wisp-dev/SKILL.md).

## Build and distribution

The source workspace is a Bun monorepo with `wispd/` for the daemon and CLI,
`web/` for the shared React app, and `desktop/` for the Rust/Tauri crate.
`bun run build:ui` creates the ignored single-file UI bundle;
the daemon binary embeds it and the desktop build packages the same output.
Pull-request CI generates and exercises this artifact but never compares it to
Git. Tag CI reproduces it once, transfers it by checksum between runners, and
uses those exact bytes for every release artifact.

The public macOS distribution keeps the service and interface composable:

- the `wisp` Homebrew Formula installs the CLI/daemon and launchd service;
- the `wisp-desktop` Homebrew Cask installs `Wisp.app` and depends on that
  Formula;
- the desktop app connects to the service but does not bundle, spawn, or stop
  it as an owned child.

Desktop application releases are Developer ID signed, notarized, and updater
signed before the tag workflow can publish immutable assets. A separate
serialized, resumable promotion job re-verifies those public bytes before it
atomically advances the Homebrew Formula, Cask, fixed Desktop channel, and
daemon channel. A
promotion-only retry never rebuilds or mutates the release. Homebrew bootstraps
and repairs the app; the native Tauri updater owns normal in-app upgrades. The
built-in Local daemon keeps its independent Homebrew-backed update lifecycle,
while saved remotes stay outside Desktop's package-manager control. See
[Desktop updates](DESKTOP-UPDATES.md) for the trust boundary, channel, rollout,
and two-version qualification contract. A native app replacement does not
rewrite Homebrew's Caskroom receipt, so receipt reconciliation is a separate
package-manager operation; neither operation changes daemon-owned task state.

See [Apple Silicon installation](INSTALL-MACOS.md) and the
[release playbook](../skills/wisp-dev/references/releasing.md) for current
platform, signing, packaging, and qualification details.
