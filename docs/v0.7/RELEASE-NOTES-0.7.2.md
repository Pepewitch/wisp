# Wisp 0.7.2

Wisp 0.7.2 adds subtasks: a task can start tasks of its own, hear back from
them, and archive them as one family.
- **Subtasks.** `wisp new --subtask` (or **New subtask** in a task) starts a
  child task: `explore` on the project's base, `review` at the parent's PR
  head, or `continue` from the parent's branch. Children nest under their
  parent in the sidebar and on a **Subtasks** tab.
- **Reports to the parent.** A child asked to report tells its parent when a
  turn ends, when it goes quiet, when setup fails, and when its PR is
  reviewed, needs a person, merges or closes. The parent reads those reports
  in its next turn as another agent's words.
- **`wisp new` inside a task makes a task for the project**, not for the
  calling task's worktree, so its project settings and reviewers apply.

## What changed since 0.7.1

### Subtasks

- **Creating a subtask** (#414, #417, #418). `wisp new --subtask` from inside a
  task, `wisp new --parent <task>` from anywhere, or **New subtask** in the web
  and Desktop. `--kind` picks where it starts: `explore` (the default) on the
  project's base, `review` at the parent's open PR head, `continue` from the
  parent's committed branch. A parent has at most 10 live subtasks and 3
  running at once (`maxSubtasks`, `maxRunningSubtasks` in config.json); a
  child over the running limit waits its turn instead of failing. Subtasks are
  one level deep. Auto-review's reviewers are now review subtasks of the task
  whose PR they check, and appear under it.
- **Reports to the parent** (#417). A subtask created with `--report` (the
  default for `--subtask`) records what happened in the same step as the
  change itself, and Wisp delivers its reports to the parent once the parent
  is idle, a few together in one turn. Wisp's facts and the child's own words
  are kept apart, and the child's words reach the parent quoted, as data. A
  turn the parent itself started on its child, and autopilot's own turns,
  report nothing back. In the transcript a report turn shows as Wisp's, not as
  yours, and a finished report turn sends no Desktop notification.
- **Autopilot on explore subtasks, and merge rights** (#417). An `explore`
  subtask may have auto-merge, auto-fix and auto-review; `review` and
  `continue` subtasks may not. Only a person can let a task merge: an agent
  may pass auto-merge to its own explore subtask only while its own task holds
  a person's grant, and Wisp checks that grant again just before merging. A
  heartbeat an agent starts begins with merges off, and an agent cannot turn
  `allowMerge` on.
- **Archiving a family** (#414, #418). Archiving a parent asks about its live
  subtasks and takes them along only when you say so (`--subtasks
  archive|force`); the confirm names every child and what happens to it, and
  asks separately before forcing a child or stopping a child's autopilot. A
  family archives whole or not at all. A parent with live subtasks cannot be
  deleted.
- **In the web and Desktop** (#418). Subtasks nest under their parent in the
  sidebar, collapsed by default with a count; a subtask shows its parent as a
  breadcrumb; a parent has a **Subtasks** tab listing every child with its
  state, latest result and reports. `wisp ls` nests them the same way.
- **Turning it off.** Subtasks are on by default. `"subtasks": false` in
  config.json turns them off: the daemon refuses every subtask field, and
  Wisp's own reviewers keep working.

### Fixes

- **`wisp new` from inside a task** (#413). A worktree task created by an
  agent from inside its own task now belongs to the project's checkout, not to
  the calling task's worktree, so the project's settings, reviewers and
  verification recipe apply to it. A relative `--base` is resolved where it was
  given and must exist there.

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
channel URL remains compatible and advertises the regular 0.7.2 version.
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
  https://raw.githubusercontent.com/Pepewitch/wisp/v0.7.2/scripts/install.sh | sh
```

Back up task state **and the original Git repositories** before upgrading.
Follow [backup and restore](https://github.com/Pepewitch/wisp/blob/v0.7.2/docs/INSTALL.md#back-up-and-restore-a-wisp-home); copying `.wisp`
alone does not preserve linked worktrees or unpublished Git objects.
This release adds database migration 26, so a 0.7.1 daemon cannot reopen a profile that 0.7.2 has opened.

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
preparation, the 0.7.2 artifact gates are pending; the [qualification ledger](https://github.com/Pepewitch/wisp/blob/main/docs/v0.7/QUALIFICATION.md)
records the final outcome separately from these immutable release notes.

- Subtasks are new in this release and have not yet been used on long-running
  real work. Their reports and events are tested, and were reviewed in four
  pull requests, but expect rough edges in how a busy parent's queue of
  reports reads.
- A force push back to a head a subtask's PR already reported, with the same
  hold, does not report again, so the parent's last word can name the newer
  head.
- The parent's **Subtasks** tab refreshes from events about its children; a
  child created by another client, or an archived child changed while archive
  history is not loaded, can show stale until the next event.
- Codex turns record the usage of their last model call, not the turn's total
  (#419).
- Network resume reads the failure's words, so an unusual harness error that
  quotes a network error code could be resumed up to three times; a workflow
  wake resets the count (#416). An inactive Desktop connection still shows a
  network-paused task as failed (#407). A reviewer whose turn fails on the
  network is not resumed (#411).
- The README hero image still shows the removed Brief panel (#406).
- Desktop still locks `rustls-webpki` 0.103.15 and `webpki-root-certs` 1.0.9
  (RUSTSEC-2026-0382 and -0383), and its updater plugin still uses `zip`
  4.6.1 (RUSTSEC-2026-0367, -0368 and -0369), as described for 0.7.1. The
  macOS updater installs a signature-verified `.tar.gz`, never a zip archive.

The limits listed for
[0.7.1](https://github.com/Pepewitch/wisp/blob/v0.7.1/docs/v0.7/RELEASE-NOTES-0.7.1.md#scope-and-known-limits)
and the releases it refers to still apply.
Native dependency advisories still include upstream maintenance notices and a
locked Linux-only glib warning. Full clean-machine provider journeys, a
human-observed Desktop upgrade across this version, broad OS coverage, and
cross-machine restore remain incomplete. Task export excludes repositories and
provider sessions; it is not a complete backup or an import format. Permanent
deletion is logical, not forensic erasure. This release is not a security
certification.

## Release assets

The release contains these ten immutable assets:

- `wisp-v0.7.2-linux-x86_64`
- `release-manifest.json`
- `SHA256SUMS`
- `wisp-v0.7.2-darwin-arm64.tar.gz`
- `release-manifest-darwin-arm64.json`
- `SHA256SUMS-darwin-arm64`
- `wisp-desktop-v0.7.2-darwin-arm64.tar.gz`
- `wisp-desktop-v0.7.2-darwin-arm64.tar.gz.sig`
- `release-manifest-desktop-darwin-arm64.json`
- `SHA256SUMS-desktop-darwin-arm64`
