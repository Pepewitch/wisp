# Wisp 0.5.3

Wisp 0.5.3 is a regular pre-1.0 release of both the daemon and Desktop app. It
starts each worktree from the project's base branch instead of whatever is
checked out, makes leftover background processes name themselves instead of
flashing after a turn, and hides OpenCode models that cannot run a coding turn.

## What changed since 0.5.2

- **Tasks fork from the project's base, not your checkout.** Creating a
  worktree used to run `git worktree add -b` with no start-point, so the task
  inherited whatever the project directory had checked out — usually a local
  `main` behind origin, or the feature branch you were mid-experiment on, with
  that WIP riding into the agent's PR. Creation now fetches origin (best
  effort) and resolves, in order: an explicit per-task base, the project's
  configured `baseBranch`, `origin/HEAD` / `origin/main` / `origin/master`,
  then the checkout's HEAD for a repo with no remote. New branches are created
  `--no-track`, so an agent's bare `git push` cannot land the task branch on
  `main`. Surfaces: `wisp new --base <ref>`, `wisp project set --base` /
  `--clear-base`, a **Base** picker in the composer, and a **Base branch** field
  in project settings. This adds database migration 8, which records `base_ref`
  alongside the commit the task forked at. (#124)
- **Background work says what is running.** A harness can leave a shell,
  `git`, or `gh` child in the turn's group for a second or two past the turn.
  The inventory caught the straggler and the task flashed **Background work
  running** for one poll, which taught operators to ignore the badge. The
  reported state now waits five seconds before showing it; Stop, archive
  admission, and process-ended checks still see every row the instant a turn
  ends. When the badge does appear, `wisp show` prints a `background:` block,
  the state-dot tooltip names the programs and which turn started them, and
  the composer note beside Stop lists the same names. `ls` keeps the bare
  word. This also fixes the Stop refusal that told you to inspect the task's
  background work when no surface exposed any. (#128)
- **OpenCode's model list drops models that cannot run a coding turn.** The
  picker listed every entry `opencode models` prints, including embeddings,
  image and video generation, TTS, and live-translate — picking one fails at
  the provider. The catalog already states this per model; the filter now
  reads `capabilities.toolcall` and `capabilities.output.text` from
  `opencode models --verbose`. Only an explicit `false` hides a model, so a
  custom provider with no capabilities block still appears, and a local
  server that is switched off stays in the list. (#125)
- **Stale background status after a 0.5.0 upgrade.** The 0.5.0 migration
  backfilled process-group records for turns created before durable group
  tracking, with no boot identity. When the OS later reused those group IDs,
  Wisp reported **Background status unknown**, and a failed Stop persisted
  `stop_requested`, which also blocked force-archive. Recovery now retires
  only those bootless rows whose replacement leader started after the
  historical turn ended; ambiguous identities stay fail-closed. (#123)

## Install or upgrade

Apple Silicon macOS (12.3 configured minimum):

```sh
brew install --cask Pepewitch/tap/wisp-desktop
open -a Wisp
```

The Cask installs the separate daemon Formula as a dependency. Existing
updater-capable Desktop builds can use **Updates → Check now**, then **Update
Desktop and relaunch**. Update **Local daemon** separately. The legacy alpha
channel URL remains compatible and advertises the regular 0.5.3 version.
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
  https://raw.githubusercontent.com/Pepewitch/wisp/v0.5.3/scripts/install.sh | sh
```

Back up task state **and the original Git repositories** before upgrading.
Follow [backup and restore](https://github.com/Pepewitch/wisp/blob/v0.5.3/docs/INSTALL.md#back-up-and-restore-a-wisp-home); copying `.wisp`
alone does not preserve linked worktrees or unpublished Git objects.
This release adds database migration 8, so a 0.5.2 daemon cannot reopen a
profile that 0.5.3 has opened.

## Scope and known limits

This release is for a trusted single OS user. Worktrees separate checkouts;
they do not sandbox agents or their credentials. There is no multi-user
permission boundary. Closing Desktop leaves daemons and agents running.
Intel macOS and non-Apple-Silicon Desktop builds are unsupported.

Desktop publication requires Developer ID signing, notarization, a stapled
ticket, and a verified updater signature. The macOS daemon remains ad-hoc
signed. Automated release gates verify immutable downloads and promote the
Formula, Cask, daemon channel, and Desktop channel together. At source
preparation, the 0.5.3 artifact gates are pending; the [qualification ledger](https://github.com/Pepewitch/wisp/blob/main/docs/v0.5/QUALIFICATION.md)
records the final outcome separately from these immutable release notes.

The origin fetch at task creation is best-effort; a configured project base
that stops resolving degrades to the default and says so in the task's state
detail, rather than failing the create. An explicit `--base` that does not
resolve still fails. A `--local` task still adopts the checkout's branch;
passing it a base is rejected. Migration 8 does not backfill: tasks opened
before this release keep a NULL `base_ref`, which means they forked from
checkout HEAD. Background settle is five seconds, so leftover children that
die inside that window never appear; names come from a best-effort `ps` of
executable names only, never argv, and are never persisted. Process-group
recovery after a 0.5.0 upgrade only retires bootless backfill rows whose
chronology is unambiguous. OpenCode's model filter is fail-open and does not
hide unreachable models; OpenCode was verified against opencode 1.18.29, and
subagent activity cards and compact mode are still not wired. Native
dependency advisories still include upstream maintenance notices and a
locked Linux-only glib warning. Full clean-machine provider journeys, a
human-observed Desktop upgrade across this version, broad OS coverage, and
cross-machine restore remain incomplete. Task export excludes repositories and
provider sessions; it is not a complete backup or an import format. Permanent
deletion is logical, not forensic erasure. This release is not a security
certification.

## Release assets

The release contains these ten immutable assets:

- `wisp-v0.5.3-linux-x86_64`
- `release-manifest.json`
- `SHA256SUMS`
- `wisp-v0.5.3-darwin-arm64.tar.gz`
- `release-manifest-darwin-arm64.json`
- `SHA256SUMS-darwin-arm64`
- `wisp-desktop-v0.5.3-darwin-arm64.tar.gz`
- `wisp-desktop-v0.5.3-darwin-arm64.tar.gz.sig`
- `release-manifest-desktop-darwin-arm64.json`
- `SHA256SUMS-desktop-darwin-arm64`
