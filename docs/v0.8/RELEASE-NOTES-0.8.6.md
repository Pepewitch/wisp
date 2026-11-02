# Wisp 0.8.6

Wisp 0.8.6 makes subtasks and long-running agents easier to coordinate and
fixes a week of reported bugs. You would notice four things:

- **`wisp wait`** blocks until tasks settle, so an orchestrating agent or a
  script no longer polls `wisp show`.
- **Subtasks can queue** (`wisp new --subtask --queue`) instead of being
  refused at the running cap, and their reports reach a busy parent.
- **Cursor shows its models again.** A model check that lists nothing no
  longer leaves the picker empty for a day.
- **Network drops recover by themselves in more places.** An auto-review
  reviewer is resumed, and a heartbeat task stops looping on resumes during
  an outage.

## What changed since 0.8.5

**Subtasks and orchestration**

- **`wisp wait <task>… [--any|--all] [--settled] [--timeout <sec>]`** (#496,
  fixes #493 and #494). Exits 0 when a task is done, 2 when it needs input, 1
  when it failed and 3 on timeout. With `--settled`, a done task whose agent
  will wake again for background work (a lingering Claude or Droid process)
  holds the wait until that work is over. A process a finished harness merely
  left behind, such as a dev server, never holds it.
- **`wisp new --subtask --queue`** (#508, fixes #495). A subtask past its
  parent's running cap waits in a new `queued` state (the API gives its place
  in line as `queue_position`) and starts when a sibling settles, rather than
  being refused. Cancelling its
  queued first prompt moves it to needs-input.
- **`wisp send --report`** (#500, fixes #477). A parent's follow-up to one of
  its subtasks reports back when the subtask finishes, like its first prompt
  did. Such a message never steers a running turn.
- **Reports no longer starve behind a busy parent** (#510, fixes #499). A
  parent that keeps being sent messages used to never be idle, so its
  subtasks' reports never went. Now a waiting report goes first when the
  parent's turn ends, unless the person pressed Stop or background work is
  still running.

**Harnesses**

- **Cursor "no models reported"** (#503). A harness whose model check answers
  with no models now counts as a failed check: the last good list stays, the
  picker shows why, and the check retries within 5 minutes instead of the next
  day. An empty list saved by an older version is ignored.
- **Codex Goals** (#506, fixes #491). While a Codex goal is active, Codex goes
  on to its next turn by itself. Wisp now follows it, recording each
  continuation as a turn of the task, instead of cutting the goal off at the
  first answer.
- **Codex usage is saved as it arrives** (#498, fixes #428), so the token
  panel shows a running turn's usage and survives a daemon restart.
- **A failed turn keeps its reason** (#497, fixes #492). For example, Cursor's
  "Model unavailable" used to leave a failed turn with no text. `wisp result`,
  `wisp show` and the conversation now show the reason on the turn itself.
- **Cursor and OpenCode images** (#509, fixes #462). Images these agents view
  are saved with the turn and shown in its outputs, as Claude, Codex and Droid
  images already were.
- **Droid without live input** (#512, fixes #399). An `adapters.json` Droid
  that runs plain `droid exec -o stream-json` no longer reports "Plan is
  up-to-date." as the turn's answer when that line only acknowledges a
  `TodoWrite`.

**Autopilot and auto-review**

- **A reviewer that loses the network is resumed** (#513, fixes #411). It is
  told to continue after 1, 2, then 4 minutes, at most three times, inside the
  round's time limit and before its verdict nudge or any fallback agent.
- **A long outage gets three resumes, not three per wake** (#513, fixes
  #416). A heartbeat wake whose turn also drops on the network now counts
  toward the same run of resumes. Your own message still starts the count
  over.
- **Repeated bot comments are held for you** (#507, fixes #476). After auto-fix
  has sent a review bot's same findings twice, the third time waits for you,
  with Send now and Skip. `wisp project set --review-start ready|checks`
  chooses whether a review round starts when the PR is ready or once its
  checks pass.
- **Review budget kept** (#505, fixes #472). Cancelling a queued fix message,
  or switching auto-review on or resuming it, no longer brings back rejections
  that were already spent.
- **Desktop's inactive connections** (#511, fixes #407) no longer show a task
  paused on the network as failed.

**Web app**

- **@ mentions** (#504, fixes #457): `.` path segments, links to ignored
  folders and nested `.git` folders are handled, and at most four file
  listings run at once.
- **Project order** (#502, fixes #456) keeps your order through a failed read,
  and a refused reorder shows the daemon's own words.
- **Project drag** (#501, fixes #470) lets go of a cancelled touch, and places
  the drop line correctly as soon as a project is picked up.
- **Release record for 0.8.5** (#490).

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
channel URL remains compatible and advertises the regular 0.8.6 version.
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
  https://raw.githubusercontent.com/Pepewitch/wisp/v0.8.6/scripts/install.sh | sh
```

Back up task state **and the original Git repositories** before upgrading.
Follow [backup and restore](https://github.com/Pepewitch/wisp/blob/v0.8.6/docs/INSTALL.md#back-up-and-restore-a-wisp-home); copying `.wisp`
alone does not preserve linked worktrees or unpublished Git objects.
This release adds database migrations 30 and 31, so a 0.8.5 daemon cannot reopen a profile that 0.8.6 has opened.

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
preparation, the 0.8.6 artifact gates are pending; the [qualification ledger](https://github.com/Pepewitch/wisp/blob/main/docs/v0.8/QUALIFICATION.md)
records the final outcome separately from these immutable release notes.

A Cursor image is captured only while Wisp follows the turn. If the daemon
restarts mid-turn, only the images viewed after it is back are kept. An image
read through a symbolic link is not captured, because the link could change
before Wisp copies the file.
Native dependency advisories still include upstream maintenance notices and a
locked Linux-only glib warning. Full clean-machine provider journeys, a
human-observed Desktop upgrade across this version, broad OS coverage, and
cross-machine restore remain incomplete. Task export excludes repositories and
provider sessions; it is not a complete backup or an import format. Permanent
deletion is logical, not forensic erasure. This release is not a security
certification.

## Release assets

The release contains these ten immutable assets:

- `wisp-v0.8.6-linux-x86_64`
- `release-manifest.json`
- `SHA256SUMS`
- `wisp-v0.8.6-darwin-arm64.tar.gz`
- `release-manifest-darwin-arm64.json`
- `SHA256SUMS-darwin-arm64`
- `wisp-desktop-v0.8.6-darwin-arm64.tar.gz`
- `wisp-desktop-v0.8.6-darwin-arm64.tar.gz.sig`
- `release-manifest-desktop-darwin-arm64.json`
- `SHA256SUMS-desktop-darwin-arm64`
