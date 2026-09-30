# Wisp 0.6.6

Wisp 0.6.6 brings autopilot together in one tab and keeps it within GitHub's
limits. It also lets a Claude task leave a dev server running without holding
its turn open, and records who took each task action.
- **An Autopilot tab.** The task panel's first tab holds the brief, the
  Auto-merge and Auto-fix switches with their live status, and the autopilot
  history.
- **Lighter on GitHub.** Wisp keeps its GitHub API use to a quarter of the
  hourly limit and, when GitHub rate-limits it, says when it will resume.
- **Background processes don't hold a turn open.** A Claude task that starts
  a dev server finishes its turn and reads
  **Done · 1 background process running**.

## What changed since 0.6.5

### Autopilot

- **The Brief tab becomes an Autopilot tab** (#354). The task panel's first
  tab, still open by default, is now **Autopilot**.
  - The brief comes first, then the **Auto-merge** and **Auto-fix**
    switches. While a switch is on, it shows the live status: the PR, the
    reason and how long it has stood. The action that status asks for sits
    under it: **Resume**, **Continue now**, or **Send now** / **Skip**.
  - **History** lists the latest autopilot events, and **All history** opens
    a full log for each PR. `#PR` and commit links open on GitHub, and
    **View message** scrolls to the message an auto-fix round sent.
  - When a long brief pushes the switches out of view, their status stays
    docked at the bottom of the pane.
  - The task `…` menu keeps the switches as shortcuts.
- **Wisp keeps to a quarter of GitHub's hourly limit** (#347). Autopilot and
  the sidebar's PR status share that limit with every other tool you run
  through `gh`, so Wisp now keeps its own use to a quarter of it.
  - While it waits on a reviewer or an approval, it checks less often, and it
    slows down when GitHub reports little left.
  - When GitHub rate-limits the account, the PR status reads
    `Paused: GitHub rate limit, resumes 14:05` instead of
    "GitHub unavailable", and a merge refused for the rate limit no longer
    counts as a failed merge.
  - `wisp doctor` gains a `github budget` check.

### Also new

- **A background process no longer keeps a Claude turn running** (#349).
  When a Claude task starts a background process, such as a dev server, and
  then answers, the turn finishes and the task reads
  **Done · 1 background process running**. Hovering the state names the
  process.
  - The process keeps running. The next message goes to the same process as
    a new turn, and **Stop** ends it.
  - When the background work wakes the agent later, that becomes a
    follow-up turn of its own, with no webhook and no "finished" banner.
  - A normal archive refuses while the process runs; force-archive stops it.
  - A daemon restart stops a harness a finished turn left running, so the
    next message resumes the session in a single process.
- **`wisp audit <task>` shows who took each action** (#345). Each task action
  now records where it came from: the web app, Desktop, the CLI, an agent
  inside a task, autopilot, or a workflow.
- **A changelog** (#344). `CHANGELOG.md` lists every published release with
  its summary and a link to its notes.
- **Wisp's own default models** (#350). A new task with no model chosen and
  no `harnessDefaults` entry now starts on Wisp's default for its harness:
  `claude-opus-5-5` for claude and droid, `gpt-6.1-sol` for codex, and
  `grok-4.7-high` for cursor. opencode keeps its own.
  - Wisp uses its default only when the installed CLI offers that model, so
    an older CLI keeps its own default.
  - A model set in `harnessDefaults` still wins, and `wisp models` says
    which default applies.
  - The harness facts Wisp checks each CLI against are re-pinned to the
    current CLI releases.
- **Auto-fix waits for a reviewer bot to finish** (#353). Some reviewer bots
  edit their summary comment when their check starts, before the new review
  is in. Auto-fix now holds a round while that bot's own check is still
  running on the PR's head, for up to 20 minutes, then sends its findings
  with everything else in one round. Stale rounds no longer use up the PR's
  five.

### Fixes

- **Live input, queue order and setup scripts** (#341).
  - One failed write to a running turn no longer breaks every later write,
    so a steer or a retried answer still gets through.
  - Queued messages are delivered in the order they were sent, even if the
    system clock moves.
  - A setup script's leftover processes are stopped at its timeout. A normal
    archive refuses while they run, and force-archive stops them.

### Performance

- **27% less JavaScript on first load** (#343). The browser app loads the
  terminal, the code highlighter and the gallery only when they are needed.
  Switching back to a browser tab no longer resyncs a healthy connection,
  and reconnects after a daemon restart back off instead of arriving all at
  once.

### Internals

- The daemon and the web app share their API types, task create and archive
  move into domain operations, routes get one daemon context, and the daemon
  tests are typechecked and hermetic (#342, #346, #348, #351, #352). The
  release notes count migrations kept in their own files (#340), and the
  0.6.5 publication is recorded (#339).

## Install or upgrade

Apple Silicon macOS (12.3 configured minimum):

```sh
brew install Pepewitch/tap/wisp Pepewitch/tap/wisp-desktop
open -a Wisp
```

The Cask installs the separate daemon Formula as a dependency. Name both:
Homebrew trusts only the fully qualified names you install from a non-official
tap, so the Cask alone refuses to load that Formula. Existing updater-capable
Desktop builds can use **Updates → Check now**, then **Update Desktop and
relaunch**. Update **Local daemon** separately. The legacy alpha
channel URL remains compatible and advertises the regular 0.6.6 version.
For Homebrew recovery or older builds without an updater:

```sh
brew update
brew upgrade Pepewitch/tap/wisp
brew upgrade --cask --greedy Pepewitch/tap/wisp-desktop
brew services restart wisp
open -a Wisp
```

Linux (Ubuntu 24.04 LTS, x86_64, glibc):

```sh
curl --proto '=https' --tlsv1.2 -fsSL \
  https://raw.githubusercontent.com/Pepewitch/wisp/v0.6.6/scripts/install.sh | sh
```

Back up task state **and the original Git repositories** before upgrading.
Follow [backup and restore](https://github.com/Pepewitch/wisp/blob/v0.6.6/docs/INSTALL.md#back-up-and-restore-a-wisp-home); copying `.wisp`
alone does not preserve linked worktrees or unpublished Git objects.
This release adds database migrations 20 and 21, so a 0.6.5 daemon cannot reopen a profile that 0.6.6 has opened.

## Scope and known limits

This release is for a trusted single OS user. Worktrees separate checkouts;
they do not sandbox agents or their credentials. There is no multi-user
permission boundary. Closing Desktop leaves daemons and agents running.
Intel macOS and non-Apple-Silicon Desktop builds are unsupported.

Desktop publication requires Developer ID signing, notarization, a stapled
ticket, and a verified updater signature. The public macOS daemon application
also requires Developer ID signing, notarization, and a stapled ticket.
Automated release gates verify immutable downloads and promote the Formula,
Cask, daemon channel, and Desktop channel together. At source
preparation, the 0.6.6 artifact gates are pending; the [qualification ledger](https://github.com/Pepewitch/wisp/blob/main/docs/v0.6/QUALIFICATION.md)
records the final outcome separately from these immutable release notes.

Specific to this release:
- A daemon restart or upgrade now stops a background process, such as a dev
  server, that a Claude task left running after its turn finished.
- The client `wisp audit` names for an action is what that client reports
  about itself. It is not authentication.
- The autopilot history shows a PR's status only for the task's current PR.
- Wisp counts its own GitHub use in memory, so a daemon restart starts that
  count again.
- Against an older daemon, the tab keeps the name **Brief** and shows only
  the brief, or has no History section.

The updater-signing, Linux update manifest, error-boundary and older-daemon
composer limits listed for
[0.6.5](https://github.com/Pepewitch/wisp/blob/v0.6.5/docs/v0.6/RELEASE-NOTES-0.6.5.md#scope-and-known-limits),
the task-brief limits listed for
[0.6.4](https://github.com/Pepewitch/wisp/blob/v0.6.4/docs/v0.6/RELEASE-NOTES-0.6.4.md#scope-and-known-limits),
the shell-tab, plan-limit, and Desktop first-launch limits listed for
[0.6.3](https://github.com/Pepewitch/wisp/blob/v0.6.3/docs/v0.6/RELEASE-NOTES-0.6.3.md#scope-and-known-limits),
and the auto-merge, auto-fix, review judge and draft limits listed for
[0.6.2](https://github.com/Pepewitch/wisp/blob/v0.6.2/docs/v0.6/RELEASE-NOTES-0.6.2.md#scope-and-known-limits),
still apply.
Native dependency advisories still include upstream maintenance notices and a
locked Linux-only glib warning. Full clean-machine provider journeys, a
human-observed Desktop upgrade across this version, broad OS coverage, and
cross-machine restore remain incomplete. Task export excludes repositories and
provider sessions; it is not a complete backup or an import format. Permanent
deletion is logical, not forensic erasure. This release is not a security
certification.

## Release assets

The release contains these ten immutable assets:

- `wisp-v0.6.6-linux-x86_64`
- `release-manifest.json`
- `SHA256SUMS`
- `wisp-v0.6.6-darwin-arm64.tar.gz`
- `release-manifest-darwin-arm64.json`
- `SHA256SUMS-darwin-arm64`
- `wisp-desktop-v0.6.6-darwin-arm64.tar.gz`
- `wisp-desktop-v0.6.6-darwin-arm64.tar.gz.sig`
- `release-manifest-desktop-darwin-arm64.json`
- `SHA256SUMS-desktop-darwin-arm64`
