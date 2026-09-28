# Wisp 0.6.4

Wisp 0.6.4 adds optional task briefs, loads faster, and fixes a few terminal
and Desktop rough edges.
- **Task briefs.** Switch a task's brief on and, at the end of each turn, the
  agent saves a short report that Wisp shows under the task header beside
  your latest message.
- **Wisp's own text is marked.** Everything Wisp adds to an agent's input now
  sits in one `<wisp>` section, apart from your words.
- **Faster first load.** The daemon serves its page gzip-compressed, and the
  task list and background cleanup do less repeated work.

## What changed since 0.6.3

- **Optional task briefs** (#305). Off by default, per task: turn it on from
  the task ⋯ menu, the create toggle, `wisp new --brief`, or
  `wisp brief enable`.
  - An eligible turn gets a one-line reminder to save a JSON brief with
    `wisp brief set --stdin`. A missing brief never blocks, fails, or
    restarts a turn.
  - The collapsible **Brief** band under the task header shows your latest
    message, recorded by Wisp, then the agent's report. It says when the
    report is older than your latest message.
  - claude, codex, cursor, and droid can publish briefs. opencode and custom
    harnesses that override the command cannot, unless configured.
  - `wisp brief show` strips terminal control sequences from agent-written
    text.
- **Wisp's text goes in a `<wisp>` section** (#305) on every task: the
  first-turn preamble, standing notes, attached-files notes, auto-fix rounds,
  heartbeat wakes, scheduled steers, and plugin control lines. The old
  `Task:` label is gone. Stored messages and the transcript are unchanged.
- **Faster first load and background work** (#304). The embedded page is
  compressed once at startup and served gzip to clients that accept it
  (about 5.7 MB down to 1.7 MB). Task lists read their rows and latest turns
  in one query, obsolete search, diff, and file reads are cancelled, and
  inactive Desktop tasks refresh less often.
- **One status mark per Desktop connection tab** (#306). An unreachable tab
  shows only the red crossed-out cloud, and clicking it reconnects without
  switching tabs.
- **Terminal and daemon fixes** (#301). A closed shell tab can no longer
  write into, or close, a file descriptor the daemon opened afterwards, which
  could leave shells dead or report `EBADF`. The compiled daemon now starts
  in about 75 MB instead of about 3 GB, so it no longer stalls on a
  low-memory host before it listens.
- Release hygiene: scripted release checks and closeout (#301), and the
  0.6.3 publication record (#303).

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
channel URL remains compatible and advertises the regular 0.6.4 version.
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
  https://raw.githubusercontent.com/Pepewitch/wisp/v0.6.4/scripts/install.sh | sh
```

Back up task state **and the original Git repositories** before upgrading.
Follow [backup and restore](https://github.com/Pepewitch/wisp/blob/v0.6.4/docs/INSTALL.md#back-up-and-restore-a-wisp-home); copying `.wisp`
alone does not preserve linked worktrees or unpublished Git objects.
This release adds database migration 14 and 15, so a 0.6.3 daemon cannot reopen a profile that 0.6.4 has opened.

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
preparation, the 0.6.4 artifact gates are pending; the [qualification ledger](https://github.com/Pepewitch/wisp/blob/main/docs/v0.6/QUALIFICATION.md)
records the final outcome separately from these immutable release notes.

Task briefs:
- A brief is the agent's own report, not a verified result. Wisp never shows
  it as done or complete.
- Whether an agent publishes depends on the model. In testing, some models
  skipped the brief on read-only requests, and some narrowed the brief's goal
  to the current turn.
- An older daemon advertises no brief support, so the band does not appear
  when a newer client connects to it.

The task-brief band and the gzip page have been checked in a browser; they
have not been observed in a packaged Desktop build before this release.

The shell-tab, plan-limit, and Desktop first-launch limits listed for
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

- `wisp-v0.6.4-linux-x86_64`
- `release-manifest.json`
- `SHA256SUMS`
- `wisp-v0.6.4-darwin-arm64.tar.gz`
- `release-manifest-darwin-arm64.json`
- `SHA256SUMS-darwin-arm64`
- `wisp-desktop-v0.6.4-darwin-arm64.tar.gz`
- `wisp-desktop-v0.6.4-darwin-arm64.tar.gz.sig`
- `release-manifest-desktop-darwin-arm64.json`
- `SHA256SUMS-desktop-darwin-arm64`
