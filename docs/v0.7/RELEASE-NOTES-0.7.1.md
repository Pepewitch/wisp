# Wisp 0.7.1

Wisp 0.7.1 removes task briefs and fixes what the first runs of auto-review
turned up.
- **Task briefs are gone.** The Brief section, its switch, `wisp brief` and
  the per-turn brief request are removed, so no task spends tokens on a brief
  any more.
- **Autopilot rides out a dropped network.** A turn that fails because the
  connection dropped is shown as paused and resumed on its own, up to three
  times, instead of waiting for you as failed.
- **Auto-review is easier to start.** A task created with auto-review on now
  has it armed, and verification setup works while reviewers run on each
  task's own agent.

## What changed since 0.7.0

### Removed

- **Task briefs** (#402). The Brief section and its switch in the task view,
  the composer and model-default switches, `wisp brief`, `wisp new --brief`,
  and the brief Wisp asked for at the end of every turn are removed. The
  database keeps the brief tables, unread, so 0.7.0 can still open a profile
  that 0.7.1 has used. A 0.7.0 daemon keeps asking brief-enabled tasks for a
  brief until it is upgraded; this release's web and Desktop no longer show a
  switch to turn that off.

### Autopilot and auto-review

- **Resume after the network drops** (#403). Under autopilot, a turn that
  ends because the machine lost its connection to the provider (the system's
  own network errors, or each harness's words for the same outage) shows as
  **Paused · network**. Wisp resumes it with one message after 1, 2 and 4
  minutes, three times at most, and records each resume in the Autopilot
  history. Credential, plan-limit and quota failures are never treated as
  network drops.
- **Creating a task with auto-review arms it** (#395). The create request
  used to drop the switch, so auto-review had to be turned on again once the
  task existed.
- **Verification setup with each task's own agent** (#396). Project settings
  → Verification no longer needs a named reviewer agent before it can start a
  recipe task: a **Recipe agent** row picks what that task runs on, starting
  from what a new task in the project would use. Both reviewers also get an
  effort picker.
- **No stale "task failed" status** (#401). Autopilot stops saying the task
  failed once the task is running again.

### Harnesses and usage

- **Droid keeps its answer** (#394). When Droid acknowledged its own
  TodoWrite after answering, the turn's result was the acknowledgement
  ("Plan is up-to-date.") instead of the answer.
- **A turn's usage adds up every result** (#400). A turn that ended on an
  error result with no usage no longer reads as zero tokens.

### Dependencies

- **Desktop locks `rustls` 0.23.46** (#408), the fix for the advisories
  published on 2026-10-14 (RUSTSEC-2026-0338, -0346, -0347, -0348 and -0349)
  that 0.7.0 shipped without because it was not yet on crates.io.
- **Vite 8.3.4** (#408) builds the web UI, past three advisories in Vite's
  dev-server editor launch path, which the shipped bundle does not contain.

### Release tooling

- **Recording a release whose publish job failed after publication** (#404,
  #405). `release:closeout` now records a release whose `publish` job failed
  only after the release went public, and does not claim the checks that did
  not run. The 0.7.0 publication is recorded that way.

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
channel URL remains compatible and advertises the regular 0.7.1 version.
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
  https://raw.githubusercontent.com/Pepewitch/wisp/v0.7.1/scripts/install.sh | sh
```

Back up task state **and the original Git repositories** before upgrading.
Follow [backup and restore](https://github.com/Pepewitch/wisp/blob/v0.7.1/docs/INSTALL.md#back-up-and-restore-a-wisp-home); copying `.wisp`
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
preparation, the 0.7.1 artifact gates are pending; the [qualification ledger](https://github.com/Pepewitch/wisp/blob/main/docs/v0.7/QUALIFICATION.md)
records the final outcome separately from these immutable release notes.

- Network resume reads the failure's words, so an unusual harness error that
  quotes a network error code could be resumed up to three times. An inactive
  Desktop connection still shows a network-paused task as failed (#407).
- The README hero image still shows the removed Brief panel (#406).
- Desktop still locks `rustls-webpki` 0.103.15 and `webpki-root-certs` 1.0.9.
  Their fixes for the distrusted-intermediate advisories of 2026-10-19 and
  2026-10-20 (RUSTSEC-2026-0382 and -0383), 0.103.16 and 1.0.10, were listed
  on crates.io but not yet in its package index when this release was cut, so
  they could not be locked. A later release locks them.
- Desktop's updater plugin still uses `zip` 4.6.1, which has extraction
  advisories (RUSTSEC-2026-0367, -0368 and -0369) fixed only in `zip` 9. The
  macOS updater installs a signature-verified `.tar.gz`, never a zip archive.

The auto-review, verification-recipe and `wisp capture` limits listed for
[0.7.0](https://github.com/Pepewitch/wisp/blob/v0.7.0/docs/v0.7/RELEASE-NOTES-0.7.0.md#scope-and-known-limits)
(except its `rustls` 0.23.45 limit: Desktop now locks 0.23.46, #408),
the per-model default and `ultracode` limits listed for
[0.6.9](https://github.com/Pepewitch/wisp/blob/v0.6.9/docs/v0.6/RELEASE-NOTES-0.6.9.md#scope-and-known-limits),
the image-output and attachment-preview limits listed for
[0.6.8](https://github.com/Pepewitch/wisp/blob/v0.6.8/docs/v0.6/RELEASE-NOTES-0.6.8.md#scope-and-known-limits),
the icon-cache and tooltip limits listed for
[0.6.7](https://github.com/Pepewitch/wisp/blob/v0.6.7/docs/v0.6/RELEASE-NOTES-0.6.7.md#scope-and-known-limits),
the Autopilot-tab, background-process, `wisp audit` and GitHub-use limits
listed for
[0.6.6](https://github.com/Pepewitch/wisp/blob/v0.6.6/docs/v0.6/RELEASE-NOTES-0.6.6.md#scope-and-known-limits),
the updater-signing, Linux update manifest, error-boundary and older-daemon
composer limits listed for
[0.6.5](https://github.com/Pepewitch/wisp/blob/v0.6.5/docs/v0.6/RELEASE-NOTES-0.6.5.md#scope-and-known-limits),
the shell-tab, plan-limit, and Desktop first-launch limits listed for
[0.6.3](https://github.com/Pepewitch/wisp/blob/v0.6.3/docs/v0.6/RELEASE-NOTES-0.6.3.md#scope-and-known-limits),
and the auto-merge, auto-fix, review judge and draft limits listed for
[0.6.2](https://github.com/Pepewitch/wisp/blob/v0.6.2/docs/v0.6/RELEASE-NOTES-0.6.2.md#scope-and-known-limits),
still apply.
The task-brief limits listed for 0.6.4 no longer apply: briefs are removed.
Native dependency advisories still include upstream maintenance notices and a
locked Linux-only glib warning. Full clean-machine provider journeys, a
human-observed Desktop upgrade across this version, broad OS coverage, and
cross-machine restore remain incomplete. Task export excludes repositories and
provider sessions; it is not a complete backup or an import format. Permanent
deletion is logical, not forensic erasure. This release is not a security
certification.

## Release assets

The release contains these ten immutable assets:

- `wisp-v0.7.1-linux-x86_64`
- `release-manifest.json`
- `SHA256SUMS`
- `wisp-v0.7.1-darwin-arm64.tar.gz`
- `release-manifest-darwin-arm64.json`
- `SHA256SUMS-darwin-arm64`
- `wisp-desktop-v0.7.1-darwin-arm64.tar.gz`
- `wisp-desktop-v0.7.1-darwin-arm64.tar.gz.sig`
- `release-manifest-desktop-darwin-arm64.json`
- `SHA256SUMS-desktop-darwin-arm64`
