# Server architecture and development

Read this reference for daemon, CLI, API, persistence, task lifecycle,
worktree, adapter, SSE, terminal, and validation changes. Exact route lists,
schemas, strategy names, and timeouts belong in source and tests, not here.

## Runtime map

- `wispd/src/index.ts` selects daemon mode for `wisp serve`; every other command
  enters `wispd/src/cli.ts`.
- `wispd/src/cli.ts` is primarily a bearer-authenticated HTTP client. Business logic
  belongs behind the API, not in a CLI-only path.
- `wispd/src/daemon.ts` loads config and adapters, performs recovery, starts
  background loops, serves the generated web bundle, owns browser auth and
  terminal WebSocket upgrades, then delegates ordinary API requests.
- `wispd/src/routes/index.ts` dispatches route families. Its order is behavior:
  specific stream and attachment paths must precede generic task paths.
- `wispd/src/store.ts` owns SQLite rows and task transitions. `wispd/src/runner.ts` owns
  one-shot harness processes, persisted logs, finalization, interruption,
  restart recovery, and stuck detection.
- `wispd/src/worktree.ts` owns worktree creation, setup and cleanup hooks, health,
  git status/diff, and archive teardown. Every git call goes through
  `wispd/src/subprocess.ts`, which enforces a byte budget WHILE reading and a
  deadline: read probes get a short one, mutating calls (worktree add/remove,
  the archive commit, push) get the write budget. `/api/status` fans out behind
  a semaphore and a coalescer, because each task's entry is several git
  processes.
- `wispd/src/adapters/` is the only home for harness argv, machine-output parsing,
  capabilities, and named wire strategies.
- `wispd/src/events.ts` feeds realtime clients. `wispd/src/outbox.ts` delivers durable
  notifications. Do not confuse either one's role with the other.

## Stable contracts

### State and process lifecycle

- Each turn is one short-lived headless harness process, spawned as its own
  process-GROUP leader. Output is written directly to persisted log files so
  daemon restart recovery can re-adopt or finalize the turn.
- Stopping a turn signals that group, not just the leader: a harness is a
  supervisor, and killing only it left builds, servers, and sub-agents running
  (ENG-03). A descendant that calls `setsid` itself leaves the group by design
  and is out of scope; nothing walks the process tree, because that races pid
  reuse. Repository hooks own a group for the same reason — their real work is
  in children.
- The group is also the last gate before destructive cleanup: force-archive
  refuses when processes the turn started are still in it, rather than deleting
  a worktree out from under them.
- Task state changes go through `store.transition()`. It advances the sequence
  and writes notify-worthy outbox rows atomically, then emits realtime news
  only after commit.
- A successful JSON turn needs a positively parsed result unless the adapter
  explicitly opts out. Process exit alone must not silently claim success.
- `stuck` means a live process has stopped producing output; it is reversible.
  `done` and `failed` come from finalization.
- Worktree mode creates and later removes an isolated checkout. Local mode
  adopts the caller's checkout, skips worktree hooks, and never removes it.
- Archive separates synchronous safety/refusal checks from background
  teardown. Preserve branches and user work.
- That teardown is a DURABLE JOB (`archive_cleanups`), written in the same
  transaction as the archived flip and resumed at startup and on a slow timer.
  It fails closed: a stage that could not stop a process ends the attempt, so
  nothing destructive runs behind a failed stop, and the reason lands in
  `state_detail`. Stages are idempotent because a resumed job may repeat the
  one it was interrupted in, and the job carries the archive hook that was
  configured when the user asked — a project can be removed in between.

### API and realtime

- The daemon owns behavior shared by the CLI, browser runtime, and desktop
  runtime. When a contract changes, update route validation/serialization,
  every client that consumes it, capability/protocol declarations, tests, and
  user-facing references together. Include the desktop native proxy when the
  change touches auth, headers, SSE, WebSockets, media, redirects, identity, or
  daemon update/restart behavior.
- Expected refusals are named HTTP errors, not guessed client-side state.
- SQLite is authoritative. `/api/events` drives query invalidation; the
  per-task log stream carries append-oriented transcript/activity data.
- Nothing authenticates ambiently. Browser SSE carries the bearer header over
  a `fetch` stream, the terminal socket authenticates in its first frame, and
  media is fetched rather than referenced — the daemon-minted `wisp_token`
  cookie was a full-control credential handed to every other service on the
  host (SEC-01). Bearer tokens do not belong in URLs either.
- A terminal upgrade is command execution: it is refused outright from a
  foreign `Origin`, and an unauthenticated socket attaches to nothing and
  reveals nothing about which tasks exist.
- A shell outlives its socket and holds exactly ONE attachment, so the latest
  client to connect owns it and the previous one is told it was displaced. Two
  clients on one task — a browser and the desktop app — is therefore normal
  and visible, never a terminal that silently ignores what you type.
- A shell is BORN at the size of the pane that asked for it, which is why the
  geometry rides on the WebSocket upgrade rather than arriving in a later
  frame: the first prompt is drawn before any client message could reach the
  daemon, and a prompt drawn for the wrong width survives on screen.
- What a reattaching client receives is a snapshot of the screen, not the bytes
  that produced it. Raw output encodes cursor motion that is only correct at
  the width it was written at, so replaying it into a differently sized pane
  corrupts the display. `wispd/src/terminal-screen.ts` keeps the daemon's model in
  the same engine the browser renders with, and it is resized with the pty.
- Worktree file reads belong to the daemon, not to a client's own filesystem
  access: it owns the tree, so a remote connection and the browser get the
  same viewer. The path arrives from a link an agent wrote, so containment is
  the boundary, and "outside the worktree" answers exactly like "not there" —
  a distinguishable refusal is an oracle for the daemon's whole disk.

### Adapters

- Builtins are declarative definitions plus named strategies. User adapters
  merge over them field by field and pass the same validation boundary.
- Probe the installed harness and capture its real machine output before
  pinning argv, models, fields, markers, or capabilities.
- Optional capabilities must degrade honestly when absent. Never infer one
  harness's wire shape from another.
- Follow `docs/ADDING-A-HARNESS.md` for the full probe, fixture, test, and live
  verification workflow.

## Run locally

Install the locked root workspace once; it includes `web` and `wispd`:

```sh
bun install --frozen-lockfile
```

Run the watched daemon and Vite together:

```sh
bun run dev:install-cli
bun run dev
```

Open the URL Vite prints, normally `http://localhost:5173`. Use
`bun run dev:server` or `bun run dev:ui` for one half. Vite proxies API, SSE,
and WebSocket traffic to the daemon port from the same Wisp config. The
one-time install adds `wisp-dev` under `~/.local/bin`; use that command for CLI
operations against the development daemon while bare `wisp` continues to
address the installed production daemon.

The package scripts and `wisp-dev` launcher set process-local
`WISP_HOME=~/.wisp-dev` before loading Wisp because config paths are bound at
module import. They ignore a globally exported `WISP_HOME`; the explicit
development variables are `WISP_DEV_HOME` and `WISP_DEV_PORT`. Never run source
entrypoints against the installed service's `~/.wisp`: doing so shares its
token, database, tasks, worktrees, logs, and port. If `18710` is occupied
before initialization, run `wisp-dev init --port <port>` once. For a throwaway
experiment rather than persistent dev state:

```sh
WISP_DEV_HOME="$(mktemp -d "${TMPDIR:-/tmp}/wisp-dev.XXXXXX")" \
WISP_DEV_PORT=18711 \
bun run dev
```

Daemon tests isolate `WISP_HOME` through `wispd/tests/setup.ts`; server and smoke tests
use dynamically allocated ports so they can run while the installed daemon
remains active.

### The test suite may not launch a real harness

`wispd/tests/setup.ts` also fails the suite closed on process execution, because
`WISP_HOME` isolation is not process isolation. It sets
`GIT_CEILING_DIRECTORIES` so a bare temporary fixture directory can never be
discovered as part of a real checkout, and `WISP_LAUNCH_POLICY` so
`wispd/src/launch-policy.ts` refuses any harness executable outside the
temporary fixture tree along with the generic stand-ins the fixtures name
(`bash -c "…"`, `true`), and refuses repository hooks whose working directory
is outside it.

A test that needs harness behavior injects it (`probeSpawnOnce`, `openRpc`,
`modelProbeSpawn`) or writes a fake executable into its own fixture directory.
Real-provider qualification is a separate, deliberate act on a disposable host
with disposable credentials:

```sh
WISP_LAUNCH_POLICY=allow bun run test:wispd   # spends real provider quota
```

`wispd/tests/launch-policy.test.ts` holds the escape attempts — a PATH-resolved
provider CLI, a `..` climb, a symlink wearing a stand-in's name — and each one
must stay refused.

### The browser boundary is checked in a browser

`bun run check:browser-security` drives headless Chrome against a throwaway
daemon and asserts the things only a browser can answer: no cookie is stored
for the daemon origin, another local port receives no credential, a
cross-origin write creates nothing, a cross-origin terminal upgrade never
opens, the page loads with no CSP violation, and framing is refused. CI runs it
as its own job. Run it after any change to authentication, the served page's
headers, the transport, or the terminal socket protocol — a green daemon suite
cannot tell you a browser stopped attaching a credential.

## Find the owning surface

| Concern | Primary source |
| --- | --- |
| Config, paths, defaults | `wispd/src/config.ts` |
| CLI parsing and presentation | `wispd/src/cli.ts` |
| Authentication and HTTP responses | `wispd/src/routes/auth.ts`, `wispd/src/routes/http.ts` |
| Task/API behavior | `wispd/src/routes/` |
| Persistence and state transitions | `wispd/src/store.ts` |
| Harness process lifecycle | `wispd/src/runner.ts` |
| Worktrees, git, setup/archive hooks | `wispd/src/worktree.ts` |
| Harness definitions and wire formats | `wispd/src/adapters/` |
| Realtime streams | `wispd/src/events.ts`, `wispd/src/routes/stream.ts` |
| Webhook delivery | `wispd/src/outbox.ts` |
| Terminal sessions | `wispd/src/terminal.ts`, `wispd/src/daemon.ts` |
| Pty allocation, sizing, and the `__pty-exec` child | `wispd/src/pty.ts` |
| The daemon's model of each shell's screen | `wispd/src/terminal-screen.ts` |
| Shared public shapes | `wispd/src/types.ts`, route serializers, `web/src/lib/types.ts`, desktop bridge/proxy contracts where applicable |

## Validation

`package.json` is authoritative. `bun run check` is the aggregate gate for
generating the ignored UI bundle plus backend and UI lint, typecheck, and unit
tests. Generated `web/ui-dist` bytes are never staged in a PR.

For server changes, run the nearest tests while iterating, then run:

```sh
bun run check
```

When a route or public type consumed by Desktop changes, include its focused
client/contract tests and run
`bun run --cwd wispd test -- tests/desktop-transport.test.ts` if the
change affects the two-daemon transport semantics. Run `bun run desktop:check`
only when native code or a rule enforced by the native proxy is affected:
capability or identity negotiation, authentication and headers, redirects,
HTTP/SSE/WebSocket/media proxying, connection metadata, credentials, or Local
setup. A generic JSON shape does not gain coverage from Cargo.

Also run `bun run smoke` for lifecycle, worktree, process, recovery, webhook,
or broad API changes. Run `bun run build` when the compiled binary or embedded
UI boundary matters.

Frontend changes have additional cross-client build and bundle gates in the
[frontend conventions](frontend.md). Native desktop contract changes run both
`bun run check` and `bun run desktop:check`. When work changes Tauri branching,
connection/runtime/native integration, or qualifies a material shared flow for
release, build with `bash scripts/desktop/build-macos.sh --app-only` and
exercise the same scenario in the browser and app. Brand changes use
`bun run brand:check`.
