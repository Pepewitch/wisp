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
  `logMaxBytes`, `setupTimeoutMinutes` (10), `envAllowlist`,
  `harnessDefaults`.
- `instance-id` — the create-exclusive authority mirrored by
  `config.json.instanceId`; it prevents simultaneous legacy migrations from
  minting different identities. Do not edit either value independently.
- `harnessDefaults` example — the default model/effort for new tasks;
  `--model`/`--effort` always win over it:
  `"harnessDefaults": { "claude": { "model": "claude-sonnet-5", "reasoningEffort": "medium" } }`
- `adapters.json` — declare extra harnesses or override builtin fields (a
  harness is a headless one-shot command plus resume/model/effort templates).
- `suffix-prompts.json` — reusable prompt suffixes, created/edited in the web
  composers and appended to the prompt on submit. Web-only convenience: the
  CLI has no flag for it (the API accepts `suffixPromptId` on create/send);
  an agent just writes the full text into the prompt itself.
- `tasks/<id>/attachments/turn-<n>/` — image bytes (see images.md);
  `worktrees/` — the task worktrees; `wisp.db` — all state (SQLite);
  `logs/` — per-turn output logs, size-capped.

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
