# Wisp 0.5.1

Wisp 0.5.1 is a regular pre-1.0 release of both the daemon and Desktop app. It
adds harness, model, and effort switching on an existing task, makes daemon
update discovery read the promoted Homebrew channel, and fixes a steering bug
that could leave a task accepting messages while no turn ever ran.

## What changed since 0.5.0

- A task no longer owns the harness and model it was created with. The composer
  offers a harness/model/effort picker for an existing task: a same-harness
  model change rides the next turn with the provider session intact, while a
  cross-harness switch asks for confirmation, then starts a fresh context under
  the same task id with the old history preserved and a divider in the
  timeline. Each turn and message records the agent that produced it, so
  recovery, logs, and the CLI report the turn's own harness rather than
  whatever the task was switched to later. This adds database migration 6.
- Daemon update discovery reads `updates/wisp-daemon.json` from the promoted
  Homebrew tap instead of the GitHub releases API, so a new daemon version is
  advertised when it is actually installable rather than when its release page
  appears. An explicit refresh now bypasses the HTTP cache and ETag, which
  previously let a stale `304` hide a new version. **This is the first release
  to publish that channel**, so daemon update checks on 0.5.0 clients begin
  resolving once 0.5.1 is promoted.
- `wisp update` updates the daemon from the command line, as a thin client of
  the daemon's already-verified updater API.
- A queued message could look accepted while no turn ever ran. Holding a
  message back for force-archive was decided partly by searching a task's
  display text, which carries whatever the harness last said — so a task whose
  own summary discussed archiving read as a task being archived, and stayed
  that way. That decision now comes only from the turn detail Wisp itself
  writes. A message left queued with no turn running is also a daemon-log
  warning, which nothing previously said out loud.
- Droid's top-level `tool_result` notifications are recorded, alongside the
  previously handled nested shape.
- The task state marker is one shape in two axes: fill says whose state it
  is — a filled dot is the agent's own outcome, a ring is ambient work outside
  the turn — and hue says how that work is going. `unknown` background work now
  takes the neutral hue instead of the warning one, because it means Wisp could
  not inventory the process group: no data, and nothing to act on.
- Repository hygiene not visible in the products: the daemon test suite refuses
  to run against a real `~/.wisp` profile, and the release-promotion dry run
  derives its fixture from the tap rather than a pinned tag.

## Install or upgrade

Apple Silicon macOS (12.3 configured minimum):

```sh
brew install --cask Pepewitch/tap/wisp-desktop
open -a Wisp
```

The Cask installs the separate daemon Formula as a dependency. Existing
updater-capable Desktop builds can use **Updates → Check now**, then **Update
Desktop and relaunch**. Update **Local daemon** separately. The legacy alpha
channel URL remains compatible and advertises the regular 0.5.1 version.
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
  https://raw.githubusercontent.com/Pepewitch/wisp/v0.5.1/scripts/install.sh | sh
```

Back up task state **and the original Git repositories** before upgrading.
Follow [backup and restore](https://github.com/Pepewitch/wisp/blob/v0.5.1/docs/INSTALL.md#back-up-and-restore-a-wisp-home); copying `.wisp`
alone does not preserve linked worktrees or unpublished Git objects.
This release adds database migration 6, so a 0.5.0 daemon cannot reopen a
profile that 0.5.1 has opened.

## Scope and known limits

This release is for a trusted single OS user. Worktrees separate checkouts;
they do not sandbox agents or their credentials. There is no multi-user
permission boundary. Closing Desktop leaves daemons and agents running.
Intel macOS and non-Apple-Silicon Desktop builds are unsupported.

Desktop publication requires Developer ID signing, notarization, a stapled
ticket, and a verified updater signature. The macOS daemon remains ad-hoc
signed. Automated release gates verify immutable downloads and promote the
Formula, Cask, daemon channel, and Desktop channel together. At source
preparation, the 0.5.1 artifact gates are pending; the [qualification ledger](https://github.com/Pepewitch/wisp/blob/main/docs/v0.5/QUALIFICATION.md)
records the final outcome separately from these immutable release notes.

Harness switching is qualified by automated tests, not by a human-observed
cross-provider session handover on every harness. Native dependency advisories
still include upstream maintenance notices and a locked Linux-only glib
warning. Full clean-machine provider journeys, a human-observed Desktop upgrade
across this version, broad OS coverage, and cross-machine restore remain
incomplete. Task export excludes repositories and provider sessions; it is not
a complete backup or an import format. Permanent deletion is logical, not
forensic erasure. This release is not a security certification.

## Release assets

The release contains these ten immutable assets:

- `wisp-v0.5.1-linux-x86_64`
- `release-manifest.json`
- `SHA256SUMS`
- `wisp-v0.5.1-darwin-arm64.tar.gz`
- `release-manifest-darwin-arm64.json`
- `SHA256SUMS-darwin-arm64`
- `wisp-desktop-v0.5.1-darwin-arm64.tar.gz`
- `wisp-desktop-v0.5.1-darwin-arm64.tar.gz.sig`
- `release-manifest-desktop-darwin-arm64.json`
- `SHA256SUMS-desktop-darwin-arm64`
