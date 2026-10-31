# Wisp 0.8.5

Wisp 0.8.5 fixes one thing: Droid tasks no longer lose the work they start in
the background.

- **Droid background work survives its turn.** When a Droid turn starts a
  background command (`Execute` with `fireAndForget`) or a background subagent
  and then ends, the work keeps running. When it finishes, Droid answers it in
  a turn of its own, as Claude tasks already did. A prompt telling Droid to do
  everything in one turn, or a heartbeat to wake it, is no longer needed.

## What changed since 0.8.4

- **Droid background work** (#486, fixes #485). Wisp used to close Droid's
  input as soon as a turn ended. Droid then exited within seconds and killed
  any command or subagent the turn had left running, so the completion Droid
  would have woken itself with never came.
  - **The turn settles, the work keeps running.** A turn that ends with such
    work still running now settles as done. The Droid process stays alive, and
    `wisp show`, the background badge, Stop and archive all treat it as the
    task's background work.
  - **Each finish gets its own turn.** When the work finishes, Droid's answer
    is recorded as a follow-up turn, for example
    `Background update: "Full suite" finished (code 0)`. That turn sends no
    finish notification or webhook.
  - **A message in the meantime** becomes the next turn on the same process.
  - **The process exits** once nothing is left running and Droid is idle.
- **Dependency advisory** (#488): minimatch, used only by the development
  linter, is pinned to 11.0.1 or later for GHSA-g3hv-75wg-m249. Nothing that
  ships changes.
- **Release record for 0.8.4** (#484): the qualification ledger notes how
  0.8.4 was published.

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
channel URL remains compatible and advertises the regular 0.8.5 version.
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
  https://raw.githubusercontent.com/Pepewitch/wisp/v0.8.5/scripts/install.sh | sh
```

Back up task state **and the original Git repositories** before upgrading.
Follow [backup and restore](https://github.com/Pepewitch/wisp/blob/v0.8.5/docs/INSTALL.md#back-up-and-restore-a-wisp-home); copying `.wisp`
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
preparation, the 0.8.5 artifact gates are pending; the [qualification ledger](https://github.com/Pepewitch/wisp/blob/main/docs/v0.8/QUALIFICATION.md)
records the final outcome separately from these immutable release notes.

In this release: a daemon restart still stops a Droid process that is waiting
on background work, as it does for Claude, because the new daemon cannot write
to its input. A background subagent whose completion Wisp does not recognize
keeps the process waiting until Stop or archive. The Droid change was verified
with protocol fixtures and one live run against droid 0.251.0. It has not yet
been verified on an installed daemon. droid and opencode pins were not
refreshed.
Native dependency advisories still include upstream maintenance notices and a
locked Linux-only glib warning. Full clean-machine provider journeys, a
human-observed Desktop upgrade across this version, broad OS coverage, and
cross-machine restore remain incomplete. Task export excludes repositories and
provider sessions; it is not a complete backup or an import format. Permanent
deletion is logical, not forensic erasure. This release is not a security
certification.

## Release assets

The release contains these ten immutable assets:

- `wisp-v0.8.5-linux-x86_64`
- `release-manifest.json`
- `SHA256SUMS`
- `wisp-v0.8.5-darwin-arm64.tar.gz`
- `release-manifest-darwin-arm64.json`
- `SHA256SUMS-darwin-arm64`
- `wisp-desktop-v0.8.5-darwin-arm64.tar.gz`
- `wisp-desktop-v0.8.5-darwin-arm64.tar.gz.sig`
- `release-manifest-desktop-darwin-arm64.json`
- `SHA256SUMS-desktop-darwin-arm64`
