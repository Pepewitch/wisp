# Wisp 0.8.7

Wisp 0.8.7 makes subtask reports dependable for a parent that stays busy, and
fixes the usage popover on a busy machine. You would notice four things:

- **Reports reach a busy parent.** A report that has waited five minutes
  behind a running turn now steers into it, background work holds a report
  back for five minutes at most, and a long run of reports arrives in bounded
  batches.
- **Reports look like Wisp's own.** A report waiting in the queue, or steered
  into a running turn, shows as Wisp's report block instead of your own
  queued-message bubble.
- **Usage limits keep their numbers.** A Claude limits read that times out on
  a loaded machine no longer replaces the last good reading with an error.
- **A PR pushed under another branch name is found.** A task whose agent
  pushed its work as `fix/<ticket>-…` instead of its `wisp/<id>-…` branch now
  shows that PR, and autopilot can bind it.

## What changed since 0.8.6

**Subtasks**

- **A report steers into a long-running turn** (#526). A report queued
  behind a parent's running turn for five minutes (counted from the later of
  its queueing and the turn's start) is sent into that turn as a mid-turn
  message, on harnesses that take live input (Claude, Droid, Codex). It is not
  sent again if an earlier steer may have reached the harness, and a Stop
  still holds it.
- **Background work holds a report for five minutes at most** (#522, fixes
  #517). A parent that always keeps something running, such as a background
  `wisp wait` for its subtasks, used to never get its reports.
- **Bounded report batches** (#524, fixes #519). A message carries at most 10
  reports and about 12,000 characters of the children's words; the rest come
  next, in order. A turn report the child has moved past says so and leaves
  its words out, unless that turn failed or asked for input.
- **`wisp report ack <subtask> --through-turn <n>`** (#531, fixes #527). A
  parent that already read turn n of a subtask's result marks that subtask's
  waiting `done` turn reports up to n as handled, so they do not arrive later
  as news. A failure, a question, a stuck turn and a PR event always stay.
  Only the parent or a person may run it.
- **A subtask's live question reaches its parent** (#523, fixes #518). A
  reporting Droid subtask that asks a question mid-turn now reports it, with
  the question and its options; a question answered or withdrawn before the
  parent reads it says so.

**Web app**

- **Reports are Wisp's block in every state** (#528). Queued and steered
  reports show as "Wisp · reports from subtasks", with only "Cancel queued
  reports" as an action.
- **Usage limits** (#530). When a refresh fails, the popover keeps the last
  good numbers for up to an hour (never past one of their windows' resets)
  with "Read 12 min ago; the refresh failed: …" beside them. The Claude read
  also starts no MCP server and runs none of your hooks, which roughly halved
  it on a loaded machine. `wisp limits` prints the same note.

**Harnesses and pull requests**

- **Droid recovers from a rejected model request** (#525, fixes #520). A live
  Droid turn whose first end was `model_request_rejected` but that went on to
  finish now ends with its real answer, instead of failing with a half
  sentence.
- **A branch pushed under another name** (#521). Wisp also looks for a task's
  PR under up to two `origin` branch names that hold commits the task itself
  made, so a fast-forward or someone else's branch is never claimed.
- **Archiving a big worktree** (#529). Removing a worktree now moves it to a
  trash folder in milliseconds and deletes the files in the background, so a
  worktree with hundreds of thousands of files no longer times out halfway
  and leaves cleanup needing attention. `wisp doctor --storage` reports the
  trash as removed worktrees still being deleted.

**Project**

- **Docs:** the README hero was re-shot with the current task screen (#515),
  and 0.8.6's publication was recorded (#516).

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
channel URL remains compatible and advertises the regular 0.8.7 version.
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
  https://raw.githubusercontent.com/Pepewitch/wisp/v0.8.7/scripts/install.sh | sh
```

Back up task state **and the original Git repositories** before upgrading.
Follow [backup and restore](https://github.com/Pepewitch/wisp/blob/v0.8.7/docs/INSTALL.md#back-up-and-restore-a-wisp-home); copying `.wisp`
alone does not preserve linked worktrees or unpublished Git objects.
This release adds database migration 32, so a 0.8.6 daemon cannot reopen a profile that 0.8.7 has opened.

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
preparation, the 0.8.7 artifact gates are pending; the [qualification ledger](https://github.com/Pepewitch/wisp/blob/main/docs/v0.8/QUALIFICATION.md)
records the final outcome separately from these immutable release notes.

A report steers into a running turn only on harnesses that take live input
(Claude, Droid, Codex); on the others it still waits for the turn to end.
`wisp report ack` never marks a report on its own: reading a result with
`wisp result` or `wisp wait` does not acknowledge anything. The Claude limits
read passes `--settings` as JSON, which needs a claude from the 2.x line; with
an older one the popover shows the read's error.
Native dependency advisories still include upstream maintenance notices and a
locked Linux-only glib warning. Full clean-machine provider journeys, a
human-observed Desktop upgrade across this version, broad OS coverage, and
cross-machine restore remain incomplete. Task export excludes repositories and
provider sessions; it is not a complete backup or an import format. Permanent
deletion is logical, not forensic erasure. This release is not a security
certification.

## Release assets

The release contains these ten immutable assets:

- `wisp-v0.8.7-linux-x86_64`
- `release-manifest.json`
- `SHA256SUMS`
- `wisp-v0.8.7-darwin-arm64.tar.gz`
- `release-manifest-darwin-arm64.json`
- `SHA256SUMS-darwin-arm64`
- `wisp-desktop-v0.8.7-darwin-arm64.tar.gz`
- `wisp-desktop-v0.8.7-darwin-arm64.tar.gz.sig`
- `release-manifest-desktop-darwin-arm64.json`
- `SHA256SUMS-desktop-darwin-arm64`
