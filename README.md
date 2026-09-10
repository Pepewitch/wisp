<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="brand/wisp-logo-dark.svg" />
  <img src="brand/wisp-logo-light.svg" alt="Wisp" width="179" height="72" />
</picture>

**Every coding agent, one daemon.**

An isolated Git worktree per task, and a state machine that cannot lie about it.

<sub>TypeScript on Bun · self-contained binary · Linux + Apple Silicon path to 1.0 · self-hosted · no accounts</sub>

</div>

Wisp is a harness-independent manager for coding-agent tasks. One daemon
creates a dedicated Git worktree per task, runs `droid`, `claude`, `codex`,
`cursor-agent`, or `opencode` one turn at a time, records what actually
happened, and exposes
the same task through a CLI, API, browser/phone UI, and native desktop app.

**Wisp 0.5.3** starts each worktree from the project's base branch instead of
whatever is checked out, makes leftover background processes name themselves
instead of flashing after a turn, and hides OpenCode models that cannot run a
coding turn. The 0.5 series brought the daemon and Desktop app together after
the 0.4 alpha series. Desktop is a usable daily interface for local and remote
tasks, with a real terminal, clearer background-work status, and actionable
recovery. A substantial engineering and security review led to fixes across
process cleanup, database ownership, authenticated media, and task retention.

See [0.5.3 release notes](docs/v0.5/RELEASE-NOTES-0.5.3.md) and the
[qualification ledger](docs/v0.5/QUALIFICATION.md) for evidence and remaining
limits. This is a pre-1.0 release for single-user, self-hosted use; the review
is not a guarantee that no security issues remain.

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
self-hosted, no account, harness-independent, separate worktrees, truthful
lifecycle state, and phone-capable steering.

“Isolated worktree” means one thing precisely: each task gets its own checkout
and branch, so parallel agents do not edit the same files. That branch starts
from the project's base branch — Wisp fetches and resolves the remote default,
so a task does not inherit whatever your project directory happens to have
checked out. Per project you can name another base, and `wisp new --base <ref>`
overrides it for one task. It is **not** a sandbox. A harness runs as your user with your credentials and your network,
and it can read and write outside its worktree. For a repository you do not
trust, use a separate OS account or a disposable VM — a prompt that says “work
only here” does not enforce anything.

## Supported release targets

| Platform | 0.5.3 scope |
|---|---|
| Ubuntu 24.04 LTS, x86_64, glibc | CLI/daemon and browser UI; automated install and activation gates |
| Apple Silicon arm64, macOS 12.3+ configured minimum | CLI/daemon and Desktop; Desktop publication requires Developer ID signing and notarization |
| Intel macOS | Unsupported; no release artifact |

“Supported” in that table means gated and qualified — what the automated
install and activation gates cover and what the qualification ledger records.
It is not a claim about where the binary runs at all. The Linux artifact is a
self-contained x86_64 executable that needs glibc 2.17 or newer, a floor
derived from the release toolchain and re-checked by the release build, and
both the installer and `wisp doctor` gate on Linux x86_64 alone. Another glibc
distribution above that floor is untested rather than blocked; problems there
are outside the gates and the ledger. There is no musl artifact.

Built-in harnesses are Droid, Claude Code, Codex, Cursor, and OpenCode. Wisp runs as your
OS user, without a multi-user authorization boundary or an agent sandbox.
The macOS deployment minimum is not a claim that every supported OS version
has been exercised. Full clean-machine, provider, update/rollback, and backup
relocation journeys still have qualification gaps; see the
[0.5 ledger](docs/v0.5/QUALIFICATION.md).

You bring Git, a repository, and at least one installed and authenticated
harness. Wisp runs on the same host and as the same user so it can reach that
repository and the harness's credentials.

## Install

The public Linux release command is:

```sh
version=0.5.3 # replace with the current published release
curl --proto '=https' --tlsv1.2 -fsSL \
  "https://raw.githubusercontent.com/Pepewitch/wisp/v${version}/scripts/install.sh" |
  sh
```

Maintainers can instead install a locally built candidate:

```sh
bun run release:linux
artifact=dist/release/v0.5.3/wisp-v0.5.3-linux-x86_64
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

The public Apple Silicon desktop command is:

```sh
brew install --cask Pepewitch/tap/wisp-desktop
```

The Cask declares `Pepewitch/tap/wisp` as a required Formula dependency, so a
fresh machine gets the CLI/daemon too. Install only the Formula with
`brew install Pepewitch/tap/wisp` when the desktop app is not wanted.

Homebrew bootstraps and repairs Wisp Desktop. Starting with alpha.12, the app's
**Updates** popover can install later signed Desktop versions itself; the
machine's built-in **Local daemon** has a separate, explicitly named update
row. Saved remote daemons are updated on their own hosts, never by this
app-global control. Alpha.8 predates
the updater, so moving from it to a current updater-capable release requires
`brew upgrade --cask --greedy Pepewitch/tap/wisp-desktop`.
The public alpha.12-to-alpha.13 journey has exercised discovery, signature
verification, replacement, relaunch, and state preservation end to end.

See [Apple Silicon installation](docs/INSTALL-MACOS.md) for the current
platform limits and activation steps.

## Activate

```sh
# Safe to run again after installation.
wisp init

# The daemon must be reachable before project commands. On Linux:
systemctl --user status wisp.service
# Or, when systemd user services are unavailable — docs/INSTALL.md#run-without-systemd:
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

If startup says the profile is already being served, keep using that instance.
Before upgrading, stop its service (`brew services stop wisp` on macOS or
`systemctl --user stop wisp` on Linux), then start the updated service. For a
foreground daemon, use Ctrl-C in its terminal. Ownership releases automatically
when the process exits; never delete `daemon-owner.lock.db` to bypass it. A
separate daemon needs both a different `WISP_HOME` and a different port.

Wisp takes ownership before opening or migrating the task database. A rejected
start leaves its schema and task data unchanged. Failed migration steps roll
back; after fixing the reported cause, restart to retry the remaining steps.
For a database startup error, run `wisp doctor --database` with the same
`WISP_HOME`: it checks the database read-only without probing installed harnesses.
A newer schema requires the same or a newer Wisp version. For damaged files,
preserve a copy before repair or restore; deleting the database discards tasks.

Use `wisp doctor --storage` for a strictly read-only local storage report,
including largest and orphan worktrees, live/archived log bytes, a rough growth
rate, and potential reclaim. `--archived-before 30d` (the default) or a UTC
`YYYY-MM-DD` changes the archive estimate. It scans logical file bytes without
following symlinks or initializing the home. See [storage and retention](docs/ARCHIVE-CLEANUP.md#storage-report).

`wisp purge --archived-before 30d` previews permanent deletion of archived
tasks. It deletes nothing unless repeated with `--confirm-count <n>` matching
the preview. Export anything to keep first. Cleanup and process safety checks
still apply; failures are named without stopping the remaining deletions.

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

`wisp search <text>` is the terminal half of the app's cross-task search — the
same exact-text scan over task titles, turn prompts, turn results, queued
messages, and the agent's own prose, with the matched field and a snippet per
hit:

```sh
wisp search "swallowing cmd-enter"      # live tasks
wisp search reducer -a                  # include archived tasks
wisp search reducer --json              # the daemon's answer, for scripts
```

Recorder-capable live turns do not fail merely because their activity stream
outgrows the retained transcript budget. Wisp keeps draining the harness,
checkpoints the outcome independently, and marks incomplete retained history;
`wisp log -f` continues to show current activity.

For incident analysis, Wisp also keeps a private JSONL diagnostic flight
recorder under its home directory. Export it with
`wisp log <task> [turn] --diagnostic`. The archive is intentionally bounded:
by default, settled turn archives expire after 7 days and share a hard 512 MiB
quota, with oldest whole turns evicted first. Set `diagnosticEnabled`,
`diagnosticRetentionDays`, or `diagnosticMaxBytes` in `config.json` to change
that policy. A turn reports whether its archive is complete, partial, evicted,
disabled, or unavailable; diagnostic loss never stops the agent process.
The export is the full retained sequence of bounded records, not a byte-for-byte
pipe dump: an individually oversized protocol record still carries an omission marker.

`wisp send <task> "correction"` is non-destructive. Wisp persists the message
before delivery. During a running turn it uses the verified native steering
channel for Claude, Droid, and Codex; other harnesses keep the message visibly
queued and start it as the next turn. Sending never stops current work.
`wisp interrupt` and the UI's Stop control are the explicit destructive path.
Stop waits for the active turn and its task's tracked background process groups
to exit, escalating if necessary, before reporting success or starting queued work.
A completed agent result stays Done when a watcher or server remains: the sidebar
shows a blue ring and “Background work running”; green means no tracked work
remains. Stop stays available with an empty composer and preserves that result.
Amber indicates stopping or unverified background work. Tracking covers older
turns and daemon restarts. The indicator also says WHAT is running, because
"something is running" is not enough to decide whether stopping is safe: hover
the dot, or run `wisp show <task>`, for the turn that started each group, how
many processes are left, how long they have outlived that turn, and the
programs' names (names only — never their arguments). A group is only reported
once it has outlived its turn by a few seconds, so a shell or `git` child that
exits with the turn never flashes the badge; every safety check still sees it
immediately. Plain archive refuses surviving background work;
force-archive stops verified groups before deleting files. While stopping, new sends
and archive requests are refused. An incomplete stop keeps those operations
blocked until Stop can confirm completion; the conversation session is kept.
Wisp's short-lived Git commands also bound process-group cleanup and output
draining after a timeout, cancellation, or stdout cap. If cleanup cannot be
confirmed, the operation reports an error rather than claiming it stopped.
If the daemon loses durable proof while starting or natively admitting a
message, it keeps the message queued and marks the delivery uncertain rather
than risking data loss. Recovery may therefore replay that stable-ID message
at least once, and the UI says so.

Archive cleanup runs in the background without delaying daemon startup. Unfinished
archives stay visible under **Cleanup**, even with **Show archived** off. Safe
steps retry with backoff; repeated failures show a reason and **Retry cleanup**.
A failed or interrupted cleanup script pauses deletion: verify its effects,
then confirm completion or explicitly rerun it. Completed scripts are not replayed
because a later removal failed. Use `wisp cleanup <task> --log` for the same
status and last script output from the CLI. See [Archive cleanup](docs/ARCHIVE-CLEANUP.md)
for recovery actions and the API contract.

## Web and phone UI

Run `wisp token` and open the URL it prints. A new home prefers
<http://127.0.0.1:8710>; `wisp init` persists the first available loopback port
from `8711`–`8799` when the default is unavailable. A persisted port never
moves silently. Paste the printed token into the app once; the browser keeps it
in origin-scoped storage and sends it as a bearer token on every request,
stream, terminal socket, and image. Nothing is authenticated ambiently — no
cookie — because a cookie is scoped to a host rather than a port, and would
hand the daemon's token to any other local service. The app provides:

- projects and task creation;
- streamed turn history and steering;
- explicit lifecycle, branch, dirty, and ahead state;
- linked GitHub pull-request lifecycle, CI, review, and policy-aware merge
  readiness for the original task branch, including glanceable sidebar status,
  when the daemon's `gh` can read it;
- a Git diff pane and worktree terminal;
- search in two scopes: `⌘F` finds exact text in the task you are reading, and
  `⌘⇧F` searches every task from the projects sidebar — titles, prompts,
  results, queued messages, and what the agent said inside a turn; archived
  tasks are searched too, and shown when *Show archived* is on;
- phone-specific chat, changes, and terminal tabs.

The UI is one self-contained HTML bundle embedded in the binary. It loads no
runtime assets from a CDN.

## Desktop UI

Wisp Desktop uses that same React bundle inside a Tauri shell. Its header is a
connection workspace: the built-in Local tab comes first, and `+` adds saved
remote daemons. Local and remote tabs can be renamed; remotes can be edited,
reconnected, or removed without touching their daemon data. Local project add
uses the native macOS folder picker, while a remote project takes a path on the
remote daemon's machine.

The app keeps daemon credentials in native storage: remote tokens live in the
macOS Keychain, and the standard Local token is read from Wisp's own profile.
The webview talks through immutable connection-qualified loopback routes and
never receives those tokens. A URL and token do not create connectivity—the
remote daemon must already be reachable through trusted HTTPS or a
user-managed exact-loopback tunnel.

The Desktop distribution requires Apple Silicon and is configured for macOS
12.3 or newer, but that full OS range has not been broadly qualified. The old
alpha.8 archive was ad-hoc signed; current releases are Developer ID signed and
notarized and fail closed before publication if that trust chain is absent. Do
not bypass Gatekeeper for a current artifact that fails verification. See
[Desktop updates](docs/DESKTOP-UPDATES.md).

For another device, keep Wisp bound to loopback and use Tailscale Serve or an
SSH tunnel. Never publish the configured Wisp port directly to the internet.
Follow [Secure remote and phone access](docs/REMOTE-ACCESS.md) and
[Security](SECURITY.md).

On a phone, install the web UI from your private HTTPS address for a Wisp
home-screen icon and a standalone window. See
[Install Wisp on your phone](docs/REMOTE-ACCESS.md#install-wisp-on-your-phone)
for iPhone and Android steps, keyboard support, and connection recovery.

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

Archived turn logs also have retention: by default, 90 days and 1 GiB shared
across archived turns, evicting whole turns (stdout and stderr) oldest first.
Live-task logs are never eligible. Retention waits for completed archive cleanup,
stopped processes and a complete indexed-prose row, and defers active readers or
exports. Protected logs can keep the archive above its limit. Set
`turnLogRetentionEnabled`, `turnLogRetentionDays` or `turnLogMaxBytes` in
`config.json`, then restart. These are separate from the per-turn capture budget
`turnTranscriptBytes`. Eviction is stated in the conversation and `wisp log`,
including `--raw`; indexed prose, prompts and final results remain in SQLite.
See [retention details](docs/ARCHIVE-CLEANUP.md#turn-log-retention).

The shipped daemon is one compiled binary: no Node, no `node_modules`, and no
sibling asset directory to install. That is what “self-contained” means, and it
is not the same as dependency-free. The binary embeds the generated single-file
UI bundle and two npm packages — `@xterm/headless` and `@xterm/addon-serialize`,
which model each terminal's screen server-side — plus the UI bundle's own
build-time dependencies. The macOS desktop shell is a Tauri application with a
Rust dependency tree of its own (`desktop/src-tauri/Cargo.lock`). Bundling
those removes an installation step, not their supply chain: `bun.lock` and that
`Cargo.lock` are the inventory, and CI audits both weekly.

The daemon is the authority. The CLI's task and project operations, the
daemon-served browser runtime, and the native desktop runtime use its HTTP API;
local setup and diagnostics also inspect the installation. Browser updates use
SSE and WebSockets; Wisp Desktop relays those same protocols through a
credential-holding native proxy. Task history remains in each daemon's SQLite
store when a client or realtime connection restarts. See
[Architecture](docs/ARCHITECTURE.md) for the ownership boundaries and
shared-client contract.

Wisp admits up to 100 simultaneously running tasks by default, including tasks
preparing a workspace. Set a positive integer `maxConcurrentTasks` in
`config.json` and restart the daemon to change that ceiling. At capacity, finish
or stop another task and retry; Wisp does not silently queue a new task. Steering
an already running task keeps its slot. There is no limit on the accumulated
number of turns in a task; harness iteration behavior remains harness-owned.


## Safe removal

For a Linux installation:

```sh
version=0.5.3 # replace with the installed version
curl --proto '=https' --tlsv1.2 -fsSL \
  "https://raw.githubusercontent.com/Pepewitch/wisp/v${version}/scripts/uninstall.sh" |
  sh
```

From a checkout, run `sh scripts/uninstall.sh`.

The uninstaller removes only installer-managed binaries and the managed
systemd user unit. It always preserves `~/.wisp`, repositories, branches, and
worktrees, and refuses unmarked install directories.

## Build and contribute

The release binary is self-contained: nothing is installed alongside it and it
resolves no packages at runtime. That is not the same as dependency-free — see
the inventory above. The source workspace uses Bun 1.3.14; the
React/Vite/Tailwind/shadcn frontend builds into one ignored, derived HTML file
that CI embeds in the daemon and Desktop artifacts.

```sh
bun install --frozen-lockfile
bun run check
bun run desktop:check # when the native bridge/proxy contract is affected
bun run smoke
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
Every shared UI or daemon-contract PR must identify and validate its effect on
both the daemon-served browser and packaged Desktop clients; an intentional
runtime difference belongs behind the documented boundary rather than in a
shared component shortcut.
Release maintainers must follow the
[publishing and qualification playbook](skills/wisp-dev/references/releasing.md).
Immutable GitHub publication and mutable Homebrew/update-channel promotion are
separate serialized jobs. A promotion failure can be rerun for the existing tag
without rebuilding, re-signing, notarizing, or changing public release assets.

## Documentation

- [Install and activate](docs/INSTALL.md)
- [Install on Apple Silicon](docs/INSTALL-MACOS.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Archive, export, and deletion](docs/ARCHIVE-CLEANUP.md)
- [Secure remote access](docs/REMOTE-ACCESS.md)
- [Desktop transport contract](docs/DESKTOP-TRANSPORT.md)
- [Desktop updates](docs/DESKTOP-UPDATES.md)
- [0.5.3 release notes](docs/v0.5/RELEASE-NOTES-0.5.3.md)
- [0.5.0 release notes](docs/v0.5/RELEASE-NOTES-0.5.0.md)
- [v0.5 release qualification](docs/v0.5/QUALIFICATION.md)
- [Historical v0.4 qualification](docs/v0.4/QUALIFICATION.md)
- [Security policy and trust model](SECURITY.md)
- [Adding a harness](docs/ADDING-A-HARNESS.md)
- [Operator skill](skills/wisp/SKILL.md)
- [Contributor skill](skills/wisp-dev/SKILL.md)
- [Release and publishing playbook](skills/wisp-dev/references/releasing.md)
- [Brand source and generation](brand/README.md)

## License

[MIT](LICENSE) © 2026 pepewitch.
