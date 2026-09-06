<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="brand/wisp-logo-dark.svg" />
  <img src="brand/wisp-logo-light.svg" alt="Wisp" width="179" height="72" />
</picture>

**Every coding agent, one daemon.**

An isolated Git worktree per task, and a state machine that cannot lie about it.

<sub>TypeScript on Bun · zero runtime dependencies · Linux + Apple Silicon path to 1.0 · self-hosted · no accounts</sub>

</div>

Wisp is a harness-independent manager for coding-agent tasks. One daemon
creates a dedicated Git worktree per task, runs `droid`, `claude`, `codex`, or
`cursor-agent` one turn at a time, records what actually happened, and exposes
the same task through a CLI, API, and desktop/phone web app.

**Current source version: `0.4.0-alpha.7`.** This is experimental software,
not a production-ready release. Alpha.7 adds managed updates, project removal,
harness drift checks, refreshed harness contracts, and safer native steering.

## Why Wisp

- Parallel agents should not edit the same checkout, so every normal task gets
  its own worktree and branch.
- “Still running,” “quiet,” “needs input,” “failed,” and “done” are different
  operational facts, so Wisp persists process-backed lifecycle state instead
  of guessing from prose.
- Coding-agent subscriptions and model availability change, so harness
  behavior sits behind adapters rather than inside the task manager.
- Remote control should not require a Wisp account or hosted relay, so the web
  app is served by the daemon you operate.

No individual feature is unique. The product bet is their combination:
self-hosted, no account, harness-independent, isolated worktrees, truthful
lifecycle state, and phone-capable steering.

## v0.4 platform claims

| Platform | Current v0.4 claim |
|---|---|
| Ubuntu 24.04 LTS, x86_64, glibc | Experimental alpha |
| Apple Silicon arm64 | Experimental alpha; ad-hoc signed and not notarized |
| Intel macOS | Unsupported; no artifact planned |

Built-in harnesses are Droid, Claude Code, Codex, and Cursor. The Linux result
is machine qualification only. Apple Silicon support is not Developer ID
signed or notarized.

You bring Git, a repository, and at least one installed and authenticated
harness. Wisp runs on the same host and as the same user so it can reach that
repository and the harness's credentials.

## Install

The public Linux release command is:

```sh
version=0.4.0-alpha.7 # replace with the current published alpha
curl --proto '=https' --tlsv1.2 -fsSL \
  "https://raw.githubusercontent.com/Pepewitch/wisp/v${version}/scripts/install.sh" |
  sh
```

Maintainers can instead install a locally built candidate:

```sh
bun run release:linux
artifact=dist/release/v0.4.0-alpha.7/wisp-v0.4.0-alpha.7-linux-x86_64
WISP_ARTIFACT_PATH="$artifact" \
WISP_SHA256="$(sha256sum "$artifact" | awk '{print $1}')" \
WISP_COMMIT="$(git rev-parse HEAD)" \
sh scripts/install.sh
```

The installer verifies the checksum, embedded version, build commit, and clean
build flag before atomically activating the binary under
`~/.local/share/wisp`. It creates `~/.local/bin/wisp`, initializes private
state in `~/.wisp`, and starts a managed systemd user service when that facility
is available. It refuses to replace unmanaged paths.

Full prerequisites, foreground operation, service credentials, upgrades,
troubleshooting, and removal: [Linux install and activation](docs/INSTALL.md).

The public Apple Silicon command is:

```sh
brew install Pepewitch/tap/wisp
```

See [Apple Silicon installation](docs/INSTALL-MACOS.md) for the current
platform limits and activation steps.

## Activate

```sh
# Safe to run again after installation.
wisp init

# The daemon must be reachable before project commands. On Linux:
systemctl --user status wisp.service
# Or, when systemd user services are unavailable:
wisp serve

# On macOS after the Homebrew install:
brew services info wisp

wisp project add /absolute/path/to/repository
wisp doctor --harness droid
```

Fix the first `fail` line from doctor and rerun it. The final receipt must say:

```text
ok   activation: ready for a first task with droid
```

Then create a task:

```sh
wisp new /absolute/path/to/repository \
  "Run the tests, fix one failing case, and commit the change." \
  --harness droid
```

`wisp wait <task>` is the script-friendly completion signal:

```sh
wisp wait tq2szu --timeout 900
# exit 0 done · 2 needs-input · 1 failed · 3 timeout
```

It waits through `stuck`, which means a live process has been quiet, not that
the turn has settled. Use `wisp show`, `wisp log -f`, `wisp send`, `wisp
interrupt`, `wisp push`, and `wisp archive` for the rest of the lifecycle.
Run `wisp help` for the complete CLI.

`wisp send <task> "correction"` is non-destructive. Wisp persists the message
before delivery. During a running turn it uses the verified native steering
channel for Claude, Droid, and Codex; other harnesses keep the message visibly
queued and start it as the next turn. Sending never stops current work.
`wisp interrupt` and the UI's Stop control are the explicit destructive path.
If the daemon loses durable proof while starting or natively admitting a
message, it keeps the message queued and marks the delivery uncertain rather
than risking data loss. Recovery may therefore replay that stable-ID message
at least once, and the UI says so.

## Web and phone UI

Run `wisp token` and open the URL it prints. A new home prefers
<http://127.0.0.1:8710>; `wisp init` persists the first available loopback port
from `8711`–`8799` when the default is unavailable. A persisted port never
moves silently. Paste the printed token into the app once; the daemon exchanges
it for an HttpOnly, SameSite=Strict cookie. The app provides:

- projects and task creation;
- streamed turn history and steering;
- explicit lifecycle, branch, dirty, and ahead state;
- linked GitHub pull-request lifecycle, CI, review, and policy-aware merge
  readiness for the original task branch, including glanceable sidebar status,
  when the daemon's `gh` can read it;
- a Git diff pane and worktree terminal;
- phone-specific chat, changes, and terminal tabs.

The UI is one self-contained HTML bundle embedded in the binary. It loads no
runtime assets from a CDN.

For another device, keep Wisp bound to loopback and use Tailscale Serve or an
SSH tunnel. Never publish the configured Wisp port directly to the internet.
Follow [Secure remote and phone access](docs/REMOTE-ACCESS.md) and
[Security](SECURITY.md).

## How it works

Each turn is one headless process using the harness's own session contract.
Wisp does not scrape a TUI or synthesize terminal keystrokes. Claude
stream-json, Droid JSON-RPC, and Codex app-server processes stay duplex for the
duration of a turn so they can accept safe-boundary messages. Harnesses without
a verified duplex protocol keep the one-shot path.

Turn logs are size-capped. One-shot harnesses write them fd-direct; duplex
drivers append normalized native events as they arrive. Task state, user
messages, and the at-least-once webhook outbox live in SQLite. A daemon restart
identifies a saved child by PID plus process start time, or finalizes a dead
one from its persisted log. Undelivered messages remain in their per-task FIFO;
native RPC admissions have bounded acknowledgement waits and never hold turn
finalization open forever.

The daemon is the authority. CLI and web clients use its HTTP API. Browser
updates use SSE and WebSockets; task history remains in SQLite when a realtime
connection restarts.

## Safe removal

For a Linux installation:

```sh
version=0.4.0-alpha.7 # replace with the installed alpha
curl --proto '=https' --tlsv1.2 -fsSL \
  "https://raw.githubusercontent.com/Pepewitch/wisp/v${version}/scripts/uninstall.sh" |
  sh
```

From a checkout, run `sh scripts/uninstall.sh`.

The uninstaller removes only installer-managed binaries and the managed
systemd user unit. It always preserves `~/.wisp`, repositories, branches, and
worktrees, and refuses unmarked install directories.

## Build and contribute

The release binary has no runtime package dependency. The source workspace uses
Bun 1.3.14; the React/Vite/Tailwind/shadcn frontend builds into one committed
HTML file.

```sh
bun install --frozen-lockfile
bun run check
bash scripts/smoke.sh
bun run build
bun run release:linux
bun run release:macos
```

Install the source-only development command once from a Wisp checkout:

```sh
bun run dev:install-cli
```

`wisp` remains the installed production command and uses `~/.wisp`.
`wisp-dev` always runs source from the current Wisp checkout and uses
`~/.wisp-dev`. It ignores a globally exported `WISP_HOME` so production and
development can run concurrently without sharing config, tokens, databases,
worktrees, logs, or ports.

`bun run dev` initializes development on port `18710` by default:

```sh
bun run dev
wisp-dev token
```

Open the URL Vite prints, normally <http://localhost:5173>. Vite proxies API,
SSE, and WebSocket traffic to the daemon named by that same `WISP_HOME`. Do not
run source commands directly without an isolated `WISP_HOME` when an installed
Wisp service exists: that would reuse production config, token, database, and
worktrees. If `18710` is occupied before first development initialization,
choose another port explicitly:

```sh
wisp-dev init --port 18711
bun run dev
```

The contributor contract is [skills/wisp-dev/SKILL.md](skills/wisp-dev/SKILL.md).
Frontend changes must follow
[the frontend conventions](skills/wisp-dev/references/frontend.md).
Release maintainers must follow the
[publishing and qualification playbook](skills/wisp-dev/references/releasing.md).

## Documentation

- [Install and activate](docs/INSTALL.md)
- [Install on Apple Silicon](docs/INSTALL-MACOS.md)
- [Secure remote access](docs/REMOTE-ACCESS.md)
- [Desktop transport contract](docs/DESKTOP-TRANSPORT.md)
- [Security policy and trust model](SECURITY.md)
- [Adding a harness](docs/ADDING-A-HARNESS.md)
- [Operator skill](skills/wisp/SKILL.md)
- [Contributor skill](skills/wisp-dev/SKILL.md)
- [Release and publishing playbook](skills/wisp-dev/references/releasing.md)
- [Brand source and generation](brand/README.md)

## License

[MIT](LICENSE) © 2026 pepewitch.
