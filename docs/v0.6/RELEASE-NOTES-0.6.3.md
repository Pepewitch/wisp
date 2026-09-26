# Wisp 0.6.3

Wisp 0.6.3 gives shell tabs real lifetimes, and makes the usage ring follow
the window that moves turn to turn.
- **Closing a shell tab ends its shell.** Tabs are kept by the daemon, so
  every window shows the same ones. Each tab has a ⋯ menu and a find bar.
- **The usage ring shows the shortest main window** and refreshes shortly
  after a turn ends, for that turn's harness.
- **Desktop opens a new version zoomed and focused**, including after an
  in-app update.

## What changed since 0.6.2

- **Shell tabs belong to the daemon** (#300). Closing a tab now hangs up its
  shell and everything in its process group, the way closing a terminal
  window does. Before, closing a tab only forgot it in that browser, and the
  next new tab could reattach to the old shell.
  - Every window of a task shows the same tabs. Tab numbers never repeat
    within a task, so a new tab is never a closed tab's number.
  - Tabs are named after the user's rename, then the program running in the
    foreground, then the shell's title, then "Shell N".
  - The ⋯ menu has Rename, Find, Clear, Restart shell and Close shell.
    Closing or restarting a tab with a program still running asks first.
  - Find in the terminal: ⌘F on Apple platforms, Ctrl+Alt+F elsewhere, with
    match count, match case, whole word and regex. ⌘K clears on Apple
    platforms; elsewhere Ctrl+K stays readline's kill-line.
  - A shell that exits on its own drops its tab. The last tab stays as an
    exited tab you can restart.
  - The 30-minute idle reaper is gone. A shell lives until its tab closes,
    its task is archived, or the daemon stops.
  - A daemon older than 0.6.3 keeps the old per-browser tabs.
- **The usage ring shows the shortest main window** (#297): claude's 5h,
  codex's 5h (7d on plans without one), and droid's standard 5h. Per-model
  windows and droid's core pool no longer count toward the ring.
  - The arc is neutral, amber from 80%, and red from 99%. It also turns red
    when any other main window reaches 99%, and its accessible name says
    which one.
  - Wisp pages ask for limits every 2 minutes instead of every minute. About
    5 seconds after a turn ends, the daemon re-reads that turn's harness, at
    most once every 30 seconds per harness.
- **Connection tabs stay green while switching** (#298). Opening a
  connection's update stream shows a subtle green ring instead of a yellow
  outage. Yellow now means a failed update stream or one that took over
  three seconds, and red means the server check failed.
- **Desktop focuses and zooms a new version on its first launch** (#299),
  including a relaunch after an in-app update. Later launches keep the
  window where you left it. The zoom fills the usable screen area without
  entering a full-screen Space.
- Release hygiene: the 0.6.2 publication record (#296).

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
channel URL remains compatible and advertises the regular 0.6.3 version.
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
  https://raw.githubusercontent.com/Pepewitch/wisp/v0.6.3/scripts/install.sh | sh
```

Back up task state **and the original Git repositories** before upgrading.
Follow [backup and restore](https://github.com/Pepewitch/wisp/blob/v0.6.3/docs/INSTALL.md#back-up-and-restore-a-wisp-home); copying `.wisp`
alone does not preserve linked worktrees or unpublished Git objects.
This release adds no database migration.

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
preparation, the 0.6.3 artifact gates are pending; the [qualification ledger](https://github.com/Pepewitch/wisp/blob/main/docs/v0.6/QUALIFICATION.md)
records the final outcome separately from these immutable release notes.

Shell tabs:
- The tab list and tab names live in daemon memory. Restarting the daemon
  ends every shell and starts each task's tabs from scratch.
- With the idle reaper gone, an open tab's shell keeps running until you
  close it, archive its task, or stop the daemon.
- Closing a tab ends its whole process group, including programs started
  from it that have not detached.

Plan-limit readings still follow each harness's own CLI, not a documented
API, and cursor and opencode still have no limits read. While a Wisp page is
open, the daemon starts an installed `claude` and `codex` about every 2
minutes and shortly after their turns end. With a Factory API key set, it
calls `api.factory.ai` on the same schedule. It skips turn-end reads when no
page has asked for limits in the last 10 minutes.

The Desktop first-launch zoom has not been observed across a signed
two-version update.

The auto-merge, auto-fix, review judge and draft limits listed for
[0.6.2](https://github.com/Pepewitch/wisp/blob/v0.6.2/docs/v0.6/RELEASE-NOTES-0.6.2.md#scope-and-known-limits)
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

- `wisp-v0.6.3-linux-x86_64`
- `release-manifest.json`
- `SHA256SUMS`
- `wisp-v0.6.3-darwin-arm64.tar.gz`
- `release-manifest-darwin-arm64.json`
- `SHA256SUMS-darwin-arm64`
- `wisp-desktop-v0.6.3-darwin-arm64.tar.gz`
- `wisp-desktop-v0.6.3-darwin-arm64.tar.gz.sig`
- `release-manifest-desktop-darwin-arm64.json`
- `SHA256SUMS-desktop-darwin-arm64`
