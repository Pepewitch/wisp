# Wisp 0.9.2

Wisp 0.9.2 lets a project be a plain folder. A folder that is not a Git
repository used to accept tasks and then fail every one with "not a git
repository"; its tasks now run in the folder itself. You would notice three
things:

- **Tasks run in a folder without Git.** `wisp new` and the composer run the
  task in the folder itself, and say so.
- **What needs Git says so.** Worktrees, a base, auto-merge, auto-fix,
  auto-review and subtasks are refused by name in such a folder, instead of
  being offered and then failing.
- **Initialize Git from the composer.** One action turns the folder into a
  repository whose tasks get their own worktrees again.

## What changed since 0.9.1

**Projects without Git**

- **Tasks run in the folder itself** (#591). When a task is created without
  choosing a mode (`wisp new` without `--local`, or an API create with no
  `mode`), a project folder that is not a Git repository, or is one with no
  ref at all, gets a local task. `wisp new` prints `local — the folder has no
  Git commit`. The task has no branch and no diff: the Changes pane, the task
  detail and `wisp show` say the folder is not a Git repository instead of
  telling you to archive the task. The agent is told it works directly in the
  folder and not to run `git init` or commit unless asked.
- **What needs Git is refused by name** (#591). An explicit worktree, a
  `--base`, auto-merge, auto-fix and auto-review are refused there with the
  reason and the fix, and so is a subtask of a task in such a folder. As with
  any local task, one task at a time works in the folder; the refusal now
  says to send that task a message or archive it.
- **Initialize Git** (#591). For such a project the composer's mode menu reads
  **This folder**, with Worktree shown but unavailable and an **Initialize
  Git** action. It asks once more, then runs `git init` when needed and
  commits the folder's current files, minus whatever its `.gitignore`
  excludes, as a first commit. After that the project offers Worktree, Base
  and autopilot again. Git's own reason is shown when it refuses: no
  identity configured, the folder sits inside another repository, or it
  already has a commit. The same action is `POST /api/projects/git`.
- **`GET /api/repos` reports each project's Git state** (#591), as `git`:
  `repo`, `unborn`, `none`, or `null` for a missing folder. An older client
  ignores it; this client treats a daemon without it as before.
- **Wisp never guesses a folder is plain** (#591). Only git's own "not a git
  repository" makes it one. A repository on an orphan branch, or one git
  cannot answer for (a timeout, `safe.directory`, git missing), keeps the old
  behaviour: a worktree, or git's own error.

**Project**

- **Docs:** 0.9.1's publication was recorded (#590).

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
channel URL remains compatible and advertises the regular 0.9.2 version.
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
  https://raw.githubusercontent.com/Pepewitch/wisp/v0.9.2/scripts/install.sh | sh
```

Back up task state **and the original Git repositories** before upgrading.
Follow [backup and restore](https://github.com/Pepewitch/wisp/blob/v0.9.2/docs/INSTALL.md#back-up-and-restore-a-wisp-home); copying `.wisp`
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
preparation, the 0.9.2 artifact gates are pending; the [qualification ledger](https://github.com/Pepewitch/wisp/blob/main/docs/v0.9/QUALIFICATION.md)
records the final outcome separately from these immutable release notes.

A task in a folder without Git has nothing to show or undo its changes with,
and only one task at a time works in such a folder. Initialize Git commits
every file `.gitignore` does not exclude, including secrets or build output
when there is no `.gitignore`; it asks once more before it does. The
composer reads a project's Git state when it opens, so a `git init` run
outside Wisp while the composer is open shows after it is reopened. Asking
for a worktree in a plain folder from inside Wisp, such as setting up a
verification recipe, is refused with the general reason rather than advice
specific to that action. The npm advisory audit still reports a ReDoS in
picomatch 4.0.7
([GHSA-fc5q-39xc-vjpf](https://github.com/advisories/GHSA-fc5q-39xc-vjpf)),
which only the web build and test tools load; no fixed picomatch is
published yet, and nothing Wisp ships contains it.
Native dependency advisories still include upstream maintenance notices and a
locked Linux-only glib warning. Full clean-machine provider journeys, a
human-observed Desktop upgrade across this version, broad OS coverage, and
cross-machine restore remain incomplete. Task export excludes repositories and
provider sessions; it is not a complete backup or an import format. Permanent
deletion is logical, not forensic erasure. This release is not a security
certification.

## Release assets

The release contains these ten immutable assets:

- `wisp-v0.9.2-linux-x86_64`
- `release-manifest.json`
- `SHA256SUMS`
- `wisp-v0.9.2-darwin-arm64.tar.gz`
- `release-manifest-darwin-arm64.json`
- `SHA256SUMS-darwin-arm64`
- `wisp-desktop-v0.9.2-darwin-arm64.tar.gz`
- `wisp-desktop-v0.9.2-darwin-arm64.tar.gz.sig`
- `release-manifest-desktop-darwin-arm64.json`
- `SHA256SUMS-desktop-darwin-arm64`
