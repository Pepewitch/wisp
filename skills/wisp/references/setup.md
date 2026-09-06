# Daemon, config, models, API

## The daemon

`wisp serve` runs wispd in the foreground. It must be supervised, because an
unsupervised daemon dies with its shell or container. Any of:

- container entrypoint: `while true; do wisp serve; sleep 1; done`
- supervisord: `command=wisp serve`, `autorestart=true`
- systemd: `ExecStart=/usr/local/bin/wisp serve`, `Restart=always`
- Homebrew on macOS: `brew services start wisp` (launchd)

Liveness: `GET /api/health`. `wisp doctor` is the full self-check (harness
CLIs and their auth, git identity, config files, daemon reachability) and
exits 1 naming what failed. Crash recovery (re-adopting running tasks) is the
daemon's job; process restart is the supervisor's.

## Browser and desktop clients

`wisp token` prints the browser URL and access token for the daemon selected by
the CLI profile. The browser runtime controls that one daemon. It keeps the
token in origin-scoped storage for ordinary API requests and exchanges it for a
same-origin session cookie used by browser-managed streams, terminals, and
media. It remains independently usable without Wisp Desktop.

On Apple Silicon, install the desktop interface and daemon together with:

```sh
brew install --cask Pepewitch/tap/wisp-desktop
```

The Cask depends on the separate `wisp` Formula, so Homebrew installs the
CLI/daemon too when needed. The app does not bundle or own a child daemon;
Local uses the standard `~/.wisp` profile and Homebrew service. Public alpha.8
is ad-hoc signed and not notarized, so follow the documented macOS Privacy &
Security approval instead of disabling Gatekeeper. Future tag releases fail
closed unless Developer ID signing and notarization pass.

The desktop header scopes the entire UI to one connection. Local is fixed but
can be renamed; `+` adds a saved remote; a remote can be renamed, reconnected,
or removed even while offline. Removal immediately revokes its desktop route
and hides it, then attempts Keychain cleanup. A failure remains visible and is
retried by **Reset desktop data** or the next launch. It does not stop tasks or
delete projects, worktrees, or history on the daemon.

Local Add Project uses the native folder picker. Adding a remote connection
requires a name, URL, and token. After it is saved, Add Project asks for a path
exactly as it exists on the remote daemon's machine. URL and token are
identity/authentication inputs, not networking: trusted HTTPS or an
exact-loopback user-managed tunnel must already make the daemon reachable.
See [`docs/INSTALL-MACOS.md`](../../../docs/INSTALL-MACOS.md) and
[`docs/REMOTE-ACCESS.md`](../../../docs/REMOTE-ACCESS.md).

After Homebrew installation, launch with `open -a Wisp`. Local diagnoses the
standard profile and service and asks before running `wisp init` or starting
the Formula service. If macOS blocks the ad-hoc alpha, use its per-app Privacy
& Security **Open Anyway** flow; never disable Gatekeeper globally.

The Desktop **Updates** popover separates the global **Wisp Desktop** release
from the selected connection's daemon release. Checks do not install anything;
Desktop replacement requires **Update Desktop and relaunch**. Alpha.8 cannot
self-update, so bootstrap the first signed updater release with:

```sh
brew update
brew upgrade --cask --greedy Pepewitch/tap/wisp-desktop
```

Later Desktop releases can use the native signed updater. Homebrew remains the
repair path with `brew reinstall --cask Pepewitch/tap/wisp-desktop`. See
[`docs/DESKTOP-UPDATES.md`](../../../docs/DESKTOP-UPDATES.md).

Before uninstalling, remove each remote or use **Reset desktop data** if saved
credentials should be deleted. `brew uninstall --cask wisp-desktop` removes
the app but leaves the separate Formula and daemon state installed. Stop and
uninstall `wisp` separately only when its tasks, worktrees, and preserved
`~/.wisp` state have been reviewed.

The daemon URL comes from the `host` and `port` in the active
`WISP_HOME/config.json`; `wisp token` prints the authority. Initializing a new
production home prefers `127.0.0.1:8710` and persists the first free port
through 8799 when needed. Use `wisp init --port <port>` to select a different
first port. Once persisted, Wisp never moves it silently. If the port is
occupied later, inspect the existing listener, then stop that listener or
change config and restart Wisp. Wisp never kills the process holding the port.

Keep development separate from an installed service:

```sh
bun run dev:install-cli
bun run dev
```

The contributor scripts and `wisp-dev` command force process-local
`WISP_HOME=~/.wisp-dev` and initialize port `18710`. Bare `wisp` remains the
production client. For another isolated development home or port, initialize
it once before running:

```sh
WISP_DEV_HOME="$HOME/.wisp-feature" WISP_DEV_PORT=18711 wisp-dev init
WISP_DEV_HOME="$HOME/.wisp-feature" bun run dev
```

Production owns `~/.wisp`; default development owns `~/.wisp-dev`. Sharing a
home also shares the token, database, tasks, worktrees, logs, and port, not just
harmless preferences.

## Files under ~/.wisp (WISP_HOME env relocates)

- `config.json` — daemon config. Wrong-typed values fail at boot with a named
  field; unknown keys warn. Keys: `instanceId` (a generated, non-secret
  Wisp-home identity), `port` (8710), `host` (127.0.0.1), `token`,
  `webhooks` (URLs POSTed on every done/needs-input/stuck/failed transition,
  at-least-once, dedup on task_id+seq), `repos`, `stuckMinutes` (10),
  `turnTranscriptBytes` (5 MB; `logMaxBytes` is its legacy alias),
  `setupTimeoutMinutes` (10), `envAllowlist`,
  `harnessDefaults`.
- `instance-id` — the create-exclusive authority mirrored by
  `config.json.instanceId`; it prevents simultaneous legacy migrations from
  minting different identities. Do not edit either value independently.
- `harnessDefaults` example — the default model/effort for new tasks;
  `--model`/`--effort` always win over it:
  `"harnessDefaults": { "claude": { "model": "claude-sonnet-5", "reasoningEffort": "medium" } }`
- `adapters.json` — declare extra harnesses or override builtin fields (a
  harness is a headless one-shot command plus resume/model/effort templates).
- `suffix-prompts.json` — reusable prompt suffixes, created/edited in the
  browser or desktop composers and appended to the prompt on submit. UI-only
  convenience: the CLI has no flag for it (the API accepts `suffixPromptId` on
  create/send); an agent just writes the full text into the prompt itself.
- `tasks/<id>/attachments/turn-<n>/` — image bytes (see images.md);
  `worktrees/` — the task worktrees; `wisp.db` — all state (SQLite);
  `logs/` — bounded primary transcripts for recorder-capable live turns;
  unsupported legacy turns retain the fatal size cap.

## Models and effort

`wisp models` prints, per harness, the effective model for new tasks
(`--model` > `harnessDefaults` > harness default) and the model list the
installed CLI exposes. Builtin harnesses: `droid`, `claude`, `codex`,
`cursor`.

`--effort <level>` sets reasoning effort; unset means the harness picks per
model. Levels per harness:

- droid: none, dynamic, off, minimal, low, medium, high, xhigh, max
- claude: low, medium, high, xhigh, max
- codex: none, minimal, low, medium, high, xhigh, max
- cursor: no effort flag — effort is a bracket override on the model id
  (`claude-opus-4-8[effort=high]`), so pass it via `--model`

## The HTTP API (for scripts; the CLI covers normal use)

`wisp token` prints the base URL and bearer token. `GET /api/health` is
unauthenticated. `POST /api/session` accepts `{token}` and mints the browser's
HttpOnly cookie. Every other API route requires
`authorization: Bearer <token>` or that browser cookie. The web UI is served
at `/`.

- `GET /api/health` — liveness
- `GET /api/capabilities` — authenticated stable instance identity, Wisp build,
  integer API protocol version, and implemented API feature flags. Flags mean
  an API surface exists; runtime readiness such as automatic-update support is
  reported by that surface's own status response.
- `POST /api/session` — exchange the token for the browser cookie
- `GET /api/tasks?archived=1` · `POST /api/tasks` (`{repoPath, prompt,
  harness, model?, effort?, mode?, attachments?, suffixPromptId?}`)
- `GET /api/tasks/:id` · `POST /api/tasks/:id/send` (`{message, attachments?,
  suffixPromptId?}`) · `…/interrupt` · `…/fresh-session` · `…/push` ·
  `…/archive` (`{force?}`)
- `GET /api/tasks/:id/log?turn=N&offset=B` — pollable log bytes
- `GET /api/tasks/:id/attachments/:turn/:name` — image bytes (410 after
  archive)
- `GET /api/tasks/:id/diff` · `GET /api/tasks/:id/log/stream` (SSE) ·
  `GET /api/events` (SSE, all task transitions)
- `GET /api/tasks/:id/pull-request` (selected task) ·
  `GET /api/pull-requests` (batched live-task overview)
- `POST /api/tasks/:id/probe` (`{command: "context"|"usage"}`) ·
  `GET /api/tasks/:id/skills`
- `POST /api/tasks/:id/compact` — run the harness's own compaction out of band
  (droid/codex; for claude send `/compact` as an ordinary turn)
- `GET /api/status` · `GET /api/repos` · `POST|DELETE /api/projects` ·
  `POST /api/projects/copy-preview`
- `GET|POST /api/suffix-prompts` ·
  `PATCH|DELETE /api/suffix-prompts/:id`
- `GET /api/harnesses` (capabilities, effort levels, offered models per
  harness) ·
  `GET /api/outbox` (undelivered webhook queue)
- `GET|POST /api/update` — daemon update status/action. Status reports current
  and latest API protocol versions; latest is `null` when legacy, malformed,
  or unreachable release metadata cannot establish it.
- `GET /api/tasks/:id/terminal` — browser-cookie-authenticated WebSocket

Errors are JSON `{error}` with a named reason; 400 = bad request, 409 = state
refusal (archived, turn running, unsaved work), 404 = no such task.
