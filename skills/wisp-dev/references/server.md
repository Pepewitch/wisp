# Server architecture and development

Read this reference for daemon, CLI, API, persistence, task lifecycle,
worktree, adapter, SSE, terminal, and validation changes. Exact route lists,
schemas, strategy names, and timeouts belong in source and tests, not here.

## Runtime map

- `wispd/src/index.ts` selects daemon mode for `wisp serve`; every other command
  enters `wispd/src/cli.ts`. Before either, it answers help, usage and unknown
  commands from `wispd/src/cli-help.ts`, which imports nothing that touches the
  home: `<command> --help` must never run the command. The dispatcher table in
  `cli.ts` is typed against that file's command list, so a command cannot ship
  without its usage.
- CLI output goes through `wispd/src/cli-print.ts` (lint enforces it for
  `cli*.ts`), which strips terminal control sequences from text an agent,
  harness or repository wrote.
- `wispd/src/cli.ts` is primarily a bearer-authenticated HTTP client. Business logic
  belongs behind the API, not in a CLI-only path.
- `wispd/src/daemon.ts` takes exclusive ownership of the Wisp home, loads config
  and adapters, performs recovery, starts background loops, serves the generated
  web bundle, owns browser auth and terminal WebSocket upgrades, then delegates
  ordinary API requests. What one daemon owns is its `DaemonContext`
  (`wispd/src/daemon-context.ts`): the caches the routes read, and every loop
  and runtime it started, stopped in registration order on the way out. A new
  cache or loop is added there, never in module scope.
- Ownership comes FIRST, before the port preflight and before any recovery: an
  address being free says nothing about who owns a home, and two owners
  reconcile each other's live state (ENG-02). It is an exclusive SQLite lock on
  a file in the home, so the OS is the arbiter — a killed daemon leaves no
  stale lock and there is no pid to trust. A losing daemon exits having changed
  nothing. Port-conflict diagnostics stay a separate, later check.
- `wispd/src/routes/index.ts` dispatches route families. Its order is behavior:
  specific stream and attachment paths must precede generic task paths.
- `wispd/src/migrations.ts` owns the schema: numbered migrations applied once
  inside a transaction and recorded in `schema_migrations`, with a profile from
  a newer Wisp refused rather than read with unknown columns (ENG-06). Add a
  migration by appending a new id; never renumber a released one. Foreign-key
  enforcement is turned on only after `PRAGMA foreign_key_check` says this
  profile can survive it (`wispd/src/foreign-keys.ts`); a clean answer is
  remembered until a migration runs or a week passes.
- `wispd/src/store-database.ts` initializes the database explicitly under home
  ownership; importing store/query helpers never opens or migrates it. Offline
  mutating tools must take the same lock; `doctor --database` opens read-only.
  In-process shutdown holds ownership until requests and detached stateful work
  settle. Register such work with `trackHomeWork`; ordinary process exit releases
  the OS lock and restart recovery handles interrupted work.
- `wispd/src/store.ts` owns SQLite rows and task transitions. `wispd/src/runner.ts` owns
  one-shot harness processes, persisted logs, finalization, interruption,
  restart recovery, and stuck detection.
- `wispd/src/worktree.ts` owns worktree creation, setup and cleanup hooks, health,
  git status/diff, and archive teardown. Every git call goes through
  `wispd/src/subprocess.ts`, which enforces a byte budget WHILE reading and a
  deadline: read probes get a short one, mutating calls (worktree add/remove,
  the archive commit, push) get the write budget. `/api/status` fans out behind
  a semaphore and serves each task's entry from a per-task cache, because each
  entry is several git processes and clients ask again on every event of any
  task: only the task an event names is probed again, plus the one a client
  names as `fresh` (the task on screen). Every other entry is served for at
  most 30 s (`STATUS_CACHE_MAX_AGE_MS`), which bounds changes made outside
  Wisp; a failed probe is never cached, and a git change Wisp makes without a
  task event (an API push) calls `invalidateStatus`.
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
- Everything Wisp writes into a harness input goes in one `<wisp>` section
  per input (`wispSection` / `withWispSection` in `turn-input.ts`). That
  covers the first turn's task preamble, standing notes (auto-merge, task
  briefs), the attached-files note, auto-fix rounds, heartbeat wakes and a
  plugin workflow's control lines. A single line goes inline
  (`<wisp>…</wisp>`), several go in a block, and a literal `</wisp>` inside
  (any letter case) is escaped so relayed text cannot close it. One blank line
  separates it from the person's words.
  - Framing happens at delivery, never at composition: a queued message's
    stored text is what was written, and `framedMessage` decides its part of
    the section from `task_messages.origin`, which is fixed when the message
    is created (`workflow` for Wisp's own words, `scheduled` for a
    schedule-steer, `plugin` for a workflow plugin's wake).
  - Text that is neither Wisp's nor the person's (a plugin's report) follows
    the section, which says whose it is.
  - A schedule-steer's words are the person's, so they go out under one
    `<wisp>scheduled steer</wisp>` line.
  - A queued `/command` gets no framing of its own, and after the first turn
    no standing notes either: a harness reads it as a command only when the
    input starts with `/`.
  - A plugin's report is relayed data, so `<wisp` and `</wisp` in it are
    escaped too: it cannot open or close a section of its own.
  - `Turn.prompt` keeps the message as stored, with no framing.
  - A new injected instruction uses the same helper, never untagged text.
- A successful JSON turn needs a positively parsed result unless the adapter
  explicitly opts out. Process exit alone must not silently claim success.
- `stuck` means a live process has stopped producing output; it is reversible.
  `done` and `failed` come from finalization.
- Worktree mode creates and later removes an isolated checkout. Local mode
  adopts the caller's checkout, skips worktree hooks, and never removes it.
- Archive separates synchronous safety/refusal checks from background
  teardown. Preserve branches and user work.
- Teardown is a durable job (`archive_cleanups` plus `archive_cleanup_progress`),
  written with the archive flip. A two-worker queue starts after the listener;
  safe stages retry with backoff and eventually require intervention. Scripts
  have separate checkpoints and an uncertain result pauses deletion. Never
  infer exactly-once external effects from a SQLite checkpoint. Hook processes
  wait behind a launch gate until their group is recorded, and recovery actions
  refuse while that group may still be present. Older combined hook stages
  require explicit operator verification. See `archive-worker.ts`,
  `archive-hooks.ts`, and [Archive cleanup](../../../docs/ARCHIVE-CLEANUP.md).

### API and realtime

- The daemon owns behavior shared by the CLI, browser runtime, and desktop
  runtime. When a contract changes, update route validation/serialization,
  every client that consumes it, capability/protocol declarations, tests, and
  user-facing references together. Include the desktop native proxy when the
  change touches auth, headers, SSE, WebSockets, media, redirects, identity, or
  daemon update/restart behavior.
- Expected refusals are named HTTP errors, not guessed client-side state.
- Every mutating route reads its body through `jsonObjectBody()`. `null`, `[]`,
  `7`, and `"text"` are all valid JSON, so a `req.json().catch(() => ({}))`
  cast dereferences a non-object (ENG-09); an empty body still means "no
  options", because a caller with nothing to send is making a request. Query
  integers go through `integerQueryParam()`.
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
- The daemon keeps each task's shell TABS, not the clients
  (`wispd/src/terminal-tabs.ts`). Closing a tab is what kills its shell
  (SIGHUP to the shell and its foreground job, as a dropped SSH session does),
  so a shell never outlives every tab that could show it. A close or restart
  while a program is in the foreground is a 409 naming it until the client
  retries with `force`. Tab numbers only count up; socket ids are reused.
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

The `wisp-dev` launcher itself (installed by `bun run dev:install-cli`) has
three more environment overrides, mostly for the installer and its own tests:
`WISP_DEV_ROOT` pins the source checkout it execs into instead of
autodetecting one; `WISP_DEV_BIN_DIR` moves where the launcher script is
installed (default `~/.local/bin`); `WISP_PRODUCTION_HOME` overrides what it
treats as the production home it refuses to run against (default `~/.wisp`).

Daemon tests isolate `WISP_HOME` through `wispd/tests/setup.ts`; server and smoke tests
use dynamically allocated ports so they can run while the installed daemon
remains active. That preload only runs when Bun reads it from `wispd`'s own
`bunfig.toml` — `bun test wispd/tests/...` from the repository root does not.
`config.ts`'s `resolveWispHome` closes that gap: under `NODE_ENV=test` (which
`bun test` sets) with no `WISP_HOME` in the environment, it throws instead of
falling back to `~/.wisp`. Always invoke the daemon suite as `bun run --cwd
wispd test` (or `bun run test:wispd`) so the preload runs in the first place.

The preload also points `TMPDIR` at one `wisp-run-*` directory per run, which
holds that `WISP_HOME` and every fixture made with `tmpdir()`, and removes it
after the last file; set `WISP_KEEP_TEST_TMP=1` to keep it for a post-mortem.
Terminal tests run `/bin/sh` with an empty `HOME` (`tests/helpers/hermetic-shell.ts`)
rather than your login shell and dotfiles. `typecheck:wispd` covers
`wispd/tests` as well as the sources, so a fixture that drifts from a real type
fails the gate.

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
| Task operations every caller shares (create and launch, archive) | `wispd/src/domain/`; a route parses the request and maps the result to HTTP, and lint keeps store writes out of `routes/` |
| Persistence and state transitions | `wispd/src/store.ts` |
| Harness process lifecycle | `wispd/src/runner.ts` |
| Worktrees, git, setup hooks | `wispd/src/worktree.ts` |
| Archive hooks and teardown | `wispd/src/archive-hooks.ts`, `wispd/src/archive-worker.ts` |
| Harness definitions and wire formats | `wispd/src/adapters/` |
| Realtime streams | `wispd/src/events.ts`, `wispd/src/routes/stream.ts` |
| Webhook delivery | `wispd/src/outbox.ts` |
| Cross-task search (a Worker with its own read-only connection; the compiled binary embeds its entry) | `wispd/src/store-search.ts`, `wispd/src/search-runner.ts`, `wispd/src/search-worker.ts` |
| Terminal sessions | `wispd/src/terminal.ts`, `wispd/src/daemon.ts` |
| Shell tabs (the list every client shows) | `wispd/src/terminal-tabs.ts`, `wispd/src/routes/terminals.ts` |
| Pty allocation, sizing, and the `__pty-exec` child | `wispd/src/pty.ts` |
| The daemon's model of each shell's screen | `wispd/src/terminal-screen.ts` |
| Shared public shapes | `shared/api/` (the daemon's actual output; routes name it in `json<T>(…)`), route serializers, `web/src/lib/types.ts` (re-exports, plus views that mark fields an older daemon omits as optional), desktop bridge/proxy contracts where applicable |

## Validation

`package.json` is authoritative. `bun run check` is the aggregate gate for
generating both ignored UI bundles plus backend and UI lint, typecheck, and unit
tests. Generated `web/ui-dist` and `web/web-dist` bytes are never staged in a PR.

For server changes, run the nearest tests while iterating, then run:

```sh
bun run check
```

When a route or public type consumed by Desktop changes, include its focused
client/contract tests. Run `bun run desktop:check`
only when native code or a rule enforced by the native proxy is affected:
capability or identity negotiation, authentication and headers, redirects,
HTTP/SSE/WebSocket/media proxying, connection metadata, credentials, or Local
setup. A generic JSON shape does not gain coverage from Cargo.

Also run `bun run smoke` for lifecycle, worktree, process, or restart-recovery
changes: it is the one run that drives the real CLI, daemon, and a subprocess
harness end to end. Webhooks, attachments, and the other API surfaces are the
daemon suite's job. Run `bun run build` when the compiled binary or embedded
UI boundary matters.

Frontend changes have additional cross-client build and bundle gates in the
[frontend conventions](frontend.md). Native desktop contract changes run both
`bun run check` and `bun run desktop:check`. When work changes Tauri branching,
connection/runtime/native integration, or qualifies a material shared flow for
release, build with `bash scripts/desktop/build-macos.sh --app-only` and
exercise the same scenario in the browser and app. Brand changes use
`bun run brand:check`.

### Performance budgets

`bun run bench` builds both UIs, seeds a synthetic home in a fresh
`wisp-bench-*` directory under the system temp root, and starts a real daemon
on it with `git`, `gh` and `ps` wrapped by counting shims. The launch policy is
`block` and no turn starts, so no harness runs. It fails when a number goes
over its maximum in `bench/budgets.json`:

- bytes of the browser bundle's initial JavaScript (gzip), its HTML, and the
  Desktop bundle;
- full-table `SCAN` steps in the query plans of the running-turn, task-list
  and search paths, taken from the statements those functions actually run;
- git spawns for one `/api/status` after one task's event, with a dozen live
  worktrees;
- bytes a live-only log stream sends for a finished task with a large
  transcript.

Those are counts, so CI's `bench` job enforces them. Search latency, health
latency during a search, and boot time are printed for comparison and never
gate. A change that lowers a count lowers its budget in the same PR; a change
that raises one edits the budget and says why in the PR description. Add a
case by measuring it in `bench/` and giving it a budget; `--json <file>` saves
a run for comparison.

CI splits the daemon suite across six shards by recorded per-file duration
(`wispd/tests/durations.json`, read by `scripts/test-shards.ts`), not by file
name. A new test file with no entry counts as a median file. When a file
becomes much slower or faster, refresh the map with the commands at the top of
that script.
