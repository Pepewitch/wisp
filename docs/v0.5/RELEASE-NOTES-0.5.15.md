# Wisp 0.5.15

Wisp 0.5.15 repairs Homebrew installation. 0.5.14 could not be installed or
upgraded at all: `brew upgrade Pepewitch/tap/wisp` stopped with
`Errno::ENOENT: No such file or directory - Wisp Daemon.app`, and the failed
upgrade still rewrote the launchd service, so the daemon stopped with it.
Upgrade straight to 0.5.15. Nothing else about 0.5.14 changes.

## What changed since 0.5.14

- The macOS daemon archive nests its `Wisp Daemon.app` bundle under one
  versioned directory. Homebrew descends into a lone top-level directory before
  a formula's `install` runs, so 0.5.14's bundle-at-the-archive-root layout left
  the Formula searching for the bundle from inside it. The Formula, the branded
  background app, and the stable `dev.wisp.daemon` code identity that 0.5.14
  introduced are otherwise unchanged (#253).
- The release pipeline installs the rendered Formula from the published release
  and runs its test before the Homebrew tap is advanced, and proves the
  archive's staged layout offline before publication. `brew audit` is static and
  never stages an archive, so it could not see this class of failure (#253).

## Recovering from a failed 0.5.14 upgrade

The failed upgrade rewrote the launchd service to the path 0.5.14 would have
installed, so `brew services list` may report `wisp` in `error` and the daemon
may be stopped. Upgrading restores both:

```sh
brew update
brew upgrade Pepewitch/tap/wisp
brew services restart wisp
```

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
channel URL remains compatible and advertises the regular 0.5.15 version.
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
  https://raw.githubusercontent.com/Pepewitch/wisp/v0.5.15/scripts/install.sh | sh
```

Back up task state **and the original Git repositories** before upgrading.
Follow [backup and restore](https://github.com/Pepewitch/wisp/blob/v0.5.15/docs/INSTALL.md#back-up-and-restore-a-wisp-home); copying `.wisp`
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
preparation, the 0.5.15 artifact gates are pending; the [qualification ledger](https://github.com/Pepewitch/wisp/blob/main/docs/v0.5/QUALIFICATION.md)
records the final outcome separately from these immutable release notes.

Homebrew installation of 0.5.14 is broken and stays broken; its published
assets are immutable, so the only fix is this release. Upgrading from 0.5.13 or
earlier has not been observed on a clean machine for this version, and the
qualification ledger records what the automated gates do and do not prove.
macOS does not remove App Management records for binaries installed by earlier
Wisp releases; those older rows can still be removed manually in System
Settings. Native dependency advisories still include upstream maintenance notices and a
locked Linux-only glib warning. Full clean-machine provider journeys, a
human-observed Desktop upgrade across this version, broad OS coverage, and
cross-machine restore remain incomplete. Task export excludes repositories and
provider sessions; it is not a complete backup or an import format. Permanent
deletion is logical, not forensic erasure. This release is not a security
certification.

## Release assets

The release contains these ten immutable assets:

- `wisp-v0.5.15-linux-x86_64`
- `release-manifest.json`
- `SHA256SUMS`
- `wisp-v0.5.15-darwin-arm64.tar.gz`
- `release-manifest-darwin-arm64.json`
- `SHA256SUMS-darwin-arm64`
- `wisp-desktop-v0.5.15-darwin-arm64.tar.gz`
- `wisp-desktop-v0.5.15-darwin-arm64.tar.gz.sig`
- `release-manifest-desktop-darwin-arm64.json`
- `SHA256SUMS-desktop-darwin-arm64`
