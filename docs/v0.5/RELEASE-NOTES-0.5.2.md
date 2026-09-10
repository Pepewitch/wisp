# Wisp 0.5.2

Wisp 0.5.2 is a regular pre-1.0 release of both the daemon and Desktop app. It
adds task search in the browser and Desktop, adds OpenCode as a fifth built-in
harness, and fixes pull-request status drifting between the sidebar and the
task header.

## What changed since 0.5.1

- **Search in two scopes.** ⌘F opens a find bar over the task you are reading:
  it walks the visible transcript, highlights matches without mutating the
  tree, and steps with Enter/⇧Enter. ⌘⇧F opens a sidebar search that answers
  "which task said that" across title, turn prompts, turn results, queued
  messages, and the agent's prose extracted from turn logs. Picking a result
  selects the task, opens the turn that matched, and hands the query to ⌘F so
  you land on the hit. Archived tasks are included and flagged; the sidebar's
  **Show archived** switch decides whether they appear or are counted as hidden.
  `wisp search` exposes the same cross-task search from the terminal, with
  `-a` to include archived tasks and `--json` for scripts. Remote daemons
  advertise `features.taskSearch`; without it, ⌘⇧F is disabled but ⌘F still
  works client-side. This adds database migration 7 for the prose index; older
  turns are backfilled in the background after upgrade.
- **OpenCode harness.** Wisp now runs `opencode` as a fifth built-in harness
  alongside Droid, Claude Code, Codex, and Cursor. Doctor reports the installed
  version; turns record per-step token usage; resume, quota-limit detection, and
  worktree isolation are wired through the same adapter path as the other
  harnesses.
- **Harness cwd fix.** Spawning a harness no longer leaves children with the
  daemon's launch-directory `PWD` while pointing `cwd` at the task worktree.
  OpenCode resolves its project root from `PWD` before `cwd`, so this bug could
  make every harness read and glob the wrong tree; `envForCwd` now sets `PWD`
  from the same directory each spawn already uses.
- **Pull-request status stays in sync.** The task header and sidebar row used
  separate timers and caches for the same PR, so merging could turn the header
  purple while the row stayed gray for up to a minute. Both surfaces now share
  one reconciled record, so they change together and a failed `gh` lookup no
  longer silently drops a PR the other surface still shows.

## Install or upgrade

Apple Silicon macOS (12.3 configured minimum):

```sh
brew install --cask Pepewitch/tap/wisp-desktop
open -a Wisp
```

The Cask installs the separate daemon Formula as a dependency. Existing
updater-capable Desktop builds can use **Updates → Check now**, then **Update
Desktop and relaunch**. Update **Local daemon** separately. The legacy alpha
channel URL remains compatible and advertises the regular 0.5.2 version.
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
  https://raw.githubusercontent.com/Pepewitch/wisp/v0.5.2/scripts/install.sh | sh
```

Back up task state **and the original Git repositories** before upgrading.
Follow [backup and restore](https://github.com/Pepewitch/wisp/blob/v0.5.2/docs/INSTALL.md#back-up-and-restore-a-wisp-home); copying `.wisp`
alone does not preserve linked worktrees or unpublished Git objects.
This release adds database migration 7, so a 0.5.1 daemon cannot reopen a
profile that 0.5.2 has opened.

## Scope and known limits

This release is for a trusted single OS user. Worktrees separate checkouts;
they do not sandbox agents or their credentials. There is no multi-user
permission boundary. Closing Desktop leaves daemons and agents running.
Intel macOS and non-Apple-Silicon Desktop builds are unsupported.

Desktop publication requires Developer ID signing, notarization, a stapled
ticket, and a verified updater signature. The macOS daemon remains ad-hoc
signed. Automated release gates verify immutable downloads and promote the
Formula, Cask, daemon channel, and Desktop channel together. At source
preparation, the 0.5.2 artifact gates are pending; the [qualification ledger](https://github.com/Pepewitch/wisp/blob/main/docs/v0.5/QUALIFICATION.md)
records the final outcome separately from these immutable release notes.

Cross-task search uses SQL `LIKE` for narrowing and JavaScript for locating,
so non-ASCII case folding is incomplete. Prose indexing backfills older turns
in the background; until that finishes, a miss may mean "not indexed yet"
rather than "not present." OpenCode was verified against opencode 1.18.29;
subagent activity cards and compact mode are not wired yet. Native dependency
advisories still include upstream maintenance notices and a locked Linux-only
glib warning. Full clean-machine provider journeys, a human-observed Desktop
upgrade across this version, broad OS coverage, and cross-machine restore
remain incomplete. Task export excludes repositories and provider sessions; it
is not a complete backup or an import format. Permanent deletion is logical,
not forensic erasure. This release is not a security certification.

## Release assets

The release contains these ten immutable assets:

- `wisp-v0.5.2-linux-x86_64`
- `release-manifest.json`
- `SHA256SUMS`
- `wisp-v0.5.2-darwin-arm64.tar.gz`
- `release-manifest-darwin-arm64.json`
- `SHA256SUMS-darwin-arm64`
- `wisp-desktop-v0.5.2-darwin-arm64.tar.gz`
- `wisp-desktop-v0.5.2-darwin-arm64.tar.gz.sig`
- `release-manifest-desktop-darwin-arm64.json`
- `SHA256SUMS-desktop-darwin-arm64`
