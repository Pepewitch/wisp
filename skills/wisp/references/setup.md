# Daemon, config, models, API

## The daemon

`wisp serve` runs wispd in the foreground. It must be supervised, because an
unsupervised daemon dies with its shell or container. Any of:

- container entrypoint: `while true; do wisp serve; sleep 1; done`
- supervisord: reproduce `KillMode=process` (signal only the daemon, not its
  process group), `UMask=0077`, `Restart=always` / `RestartSec=2`, and a
  user-session `HOME` plus a `PATH` that reaches harness binaries. Worked
  example: [Run without systemd](../../../docs/INSTALL.md#run-without-systemd)
- systemd: `ExecStart=/usr/local/bin/wisp serve`, `Restart=always`
- Homebrew on macOS: `brew services start wisp` (launchd)

Liveness: `GET /api/health`. `wisp doctor` is the full self-check (harness
CLIs and their auth, git identity, config files, daemon reachability) and
exits 1 naming what failed. Crash recovery (re-adopting running tasks) is the
daemon's job; process restart is the supervisor's.

## Browser and desktop clients

`wisp token` prints the browser URL and access token for the daemon selected by
the CLI profile. The browser runtime controls that one daemon. It keeps the
token in origin-scoped storage and sends it as a bearer credential on every
hop — API requests, event streams, the terminal socket's first frame, and
attachment media. No cookie authenticates anything. It remains independently
usable without Wisp Desktop.

On Apple Silicon, install the desktop interface and daemon together with:

```sh
brew install --cask Pepewitch/tap/wisp-desktop
```

The Cask depends on the separate `wisp` Formula, so Homebrew installs the
CLI/daemon too when needed. The app does not bundle or own a child daemon;
Local uses the standard `~/.wisp` profile and Homebrew service. Public alpha.8
is ad-hoc signed and not notarized. Starting with alpha.12, releases fail
closed unless Developer ID signing and notarization pass; do not bypass
Gatekeeper for a current artifact that fails verification. The public
alpha.12-to-alpha.13 self-update passed end to end on one Apple Silicon Mac.

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
the Formula service. A per-app Privacy & Security exception may be needed for
the older ad-hoc alpha.8; current releases must instead pass their Developer ID and
notarization checks. Never disable Gatekeeper globally.

The Desktop **Updates** popover separates the global **Wisp Desktop** release
from the built-in **Local daemon**, regardless of the selected tab. **Check
now** refreshes both rows; it never installs either one. Saved remote daemons
must be updated on their host or through their own browser UI. Desktop
replacement requires **Update Desktop and relaunch**. Alpha.8 cannot self-update,
so bootstrap the current release with:

```sh
brew update
brew upgrade --cask --greedy Pepewitch/tap/wisp-desktop
```

Later Desktop releases can use the native signed updater. Homebrew remains the
repair path with `brew reinstall --cask Pepewitch/tap/wisp-desktop`. An in-app
replacement does not update Homebrew's Caskroom receipt; use `brew update` and
`brew upgrade --cask --greedy Pepewitch/tap/wisp-desktop` when that receipt
needs to catch up to the already-installed app. See
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
(`--model` > `harnessDefaults` > harness default) and the models on offer.
That list is the installed CLI's own enumeration where it has one, and the
adapter's pinned selection where it does not — the latter is labelled
`pinned by the adapter`, because it is a subset and other ids the CLI accepts
still work. Builtin harnesses: `droid`, `claude`, `codex`, `cursor`,
`opencode`.

Pass the id `wisp models` prints, not a shortened form of it. A harness CLI
may accept an unknown `--model` and silently run something else: cursor's
Grok 4.6 is `cursor-grok-4.6-high`, and a bare `grok-4.6` is not an id.

`--effort <level>` sets reasoning effort; unset means the harness picks per
model. Levels per harness:

- droid: none, dynamic, off, minimal, low, medium, high, xhigh, max
- claude: low, medium, high, xhigh, max
- codex: none, minimal, low, medium, high, xhigh, max
- cursor: no effort flag — effort is a bracket override on the model id
  (`claude-opus-4-8[effort=high]`), so pass it via `--model`
- opencode: minimal, low, medium, high, xhigh, max — opencode calls these
  model *variants*, and which ones exist depends on the model; ids are
  `provider/model` (e.g. `google/gemini-3.6-flash`)

opencode's model list is whatever YOUR opencode exposes: the providers you
have credentials for, opencode's own Zen gateway (whose free models need no
credential), and any custom `provider` block in `opencode.json` — a local
llama.cpp or Ollama server shows up on its own, no Wisp configuration needed.
Models the catalog marks as unable to call tools or emit text (embeddings,
image/video generation, TTS) are hidden, because they cannot run a coding
turn. Nothing is hidden for being unreachable: a local model whose server is
switched off still appears, so you can pick it and then start the server.
Note that a custom provider id which collides with a known provider (naming
yours `llama`, say) inherits that provider's catalog models too — give it a
unique id if you only want the models you declared.

## The HTTP API (for scripts; the CLI covers normal use)

`wisp token` prints the base URL and bearer token. `GET /api/health` is
unauthenticated. `POST /api/session` accepts `{token}` and answers whether it is
the right one, so the browser's dialog can refuse a wrong token before storing
it; it mints no credential. Every other API route requires
`authorization: Bearer <token>`. The web UI is served at `/`.

- `GET /api/health` — liveness
- `GET /api/capabilities` — authenticated stable instance identity, Wisp build,
  integer API protocol version, and implemented API feature flags. Flags mean
  an API surface exists; runtime readiness such as automatic-update support is
  reported by that surface's own status response.
- `POST /api/session` — verify a token (mints nothing)
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
- `GET|POST /api/update` — daemon update status/action. `GET` with `refresh=1`
  bypasses the release cache for an explicit check. Status reports current and
  latest API protocol versions; latest is `null` when legacy, malformed, or
  unreachable release metadata cannot establish it.
- `GET /api/tasks/:id/terminal` — WebSocket. A bearer handshake attaches
  immediately; a browser handshake (which cannot set a header) upgrades
  unauthenticated, is asked for the token in an `auth_required` frame, and
  attaches only after `{"type":"auth","token":"…"}`. Refused outright from a
  foreign `Origin`

Errors are JSON `{error}` with a named reason; 400 = bad request, 409 = state
refusal (archived, turn running, unsaved work), 404 = no such task.
