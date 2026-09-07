# Server architecture and development

Read this reference for daemon, CLI, API, persistence, task lifecycle,
worktree, adapter, SSE, terminal, and validation changes. Exact route lists,
schemas, strategy names, and timeouts belong in source and tests, not here.

## Runtime map

- `src/index.ts` selects daemon mode for `wisp serve`; every other command
  enters `src/cli.ts`.
- `src/cli.ts` is primarily a bearer-authenticated HTTP client. Business logic
  belongs behind the API, not in a CLI-only path.
- `src/daemon.ts` loads config and adapters, performs recovery, starts
  background loops, serves the generated web bundle, owns browser auth and
  terminal WebSocket upgrades, then delegates ordinary API requests.
- `src/routes/index.ts` dispatches route families. Its order is behavior:
  specific stream and attachment paths must precede generic task paths.
- `src/store.ts` owns SQLite rows and task transitions. `src/runner.ts` owns
  one-shot harness processes, persisted logs, finalization, interruption,
  restart recovery, and stuck detection.
- `src/worktree.ts` owns worktree creation, setup and cleanup hooks, health,
  git status/diff, and archive teardown.
- `src/adapters/` is the only home for harness argv, machine-output parsing,
  capabilities, and named wire strategies.
- `src/events.ts` feeds realtime clients. `src/outbox.ts` delivers durable
  notifications. Do not confuse either one's role with the other.

## Stable contracts

### State and process lifecycle

- Each turn is one short-lived headless harness process. Output is written
  directly to persisted log files so daemon restart recovery can re-adopt or
  finalize the turn.
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
- Browser SSE and WebSockets authenticate with the daemon-minted cookie.
  Bearer tokens do not belong in URLs.
- A shell outlives its socket and holds exactly ONE attachment, so the latest
  client to connect owns it and the previous one is told it was displaced. Two
  clients on one task — a browser and the desktop app — is therefore normal
  and visible, never a terminal that silently ignores what you type.
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

Install the locked root workspace once; it includes `web/ui`:

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

Root tests isolate `WISP_HOME` through `tests/setup.ts`; server and smoke tests
use dynamically allocated ports so they can run while the installed daemon
remains active.

## Find the owning surface

| Concern | Primary source |
| --- | --- |
| Config, paths, defaults | `src/config.ts` |
| CLI parsing and presentation | `src/cli.ts` |
| Authentication and HTTP responses | `src/routes/auth.ts`, `src/routes/http.ts` |
| Task/API behavior | `src/routes/` |
| Persistence and state transitions | `src/store.ts` |
| Harness process lifecycle | `src/runner.ts` |
| Worktrees, git, setup/archive hooks | `src/worktree.ts` |
| Harness definitions and wire formats | `src/adapters/` |
| Realtime streams | `src/events.ts`, `src/routes/stream.ts` |
| Webhook delivery | `src/outbox.ts` |
| Terminal sessions | `src/terminal.ts`, `src/daemon.ts` |
| Shared public shapes | `src/types.ts`, route serializers, `web/ui/src/lib/types.ts`, desktop bridge/proxy contracts where applicable |

## Validation

`package.json` is authoritative. `bun run check` is the aggregate gate for
generating the ignored UI bundle plus backend and UI lint, typecheck, and unit
tests. Generated `web/ui-dist` bytes are never staged in a PR.

For server changes, run the nearest tests while iterating, then run:

```sh
bun run check
```

When a route or public type consumed by Desktop changes, include its focused
client/contract tests and run `bun test tests/desktop-transport.test.ts` if the
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
