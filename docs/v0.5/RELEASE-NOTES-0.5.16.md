# Wisp 0.5.16

Wisp 0.5.16 fixes a daemon crash that made 0.5.15 unusable. Opening a terminal
killed the whole daemon rather than just the terminal, so Desktop lost its
connection and every request failed with it. It also keeps a Claude task alive
through a background Monitor's whole run instead of ending it one result early.
Upgrade from 0.5.15; there is nothing to configure.

## What changed since 0.5.15

- The published macOS daemon is now signed with the JIT and
  unsigned-executable-memory entitlements its hardened runtime requires. The
  daemon reaches libc through `bun:ffi` to open a pty for the embedded terminal,
  and the hardened runtime blocks the executable memory that needs unless the
  signature grants it. 0.5.15 was signed hardened with no entitlements at all,
  so every terminal open trapped in `pthread_jit_write_protect_np` and took the
  daemon down; launchd restarted it and the next attempt did the same. Desktop
  reported `could not open a shell (1006)` and then `could not reach the
  daemon` (#256).
- The release pipeline refuses to build a signed daemon whose signature lacks
  either entitlement, and re-checks both on the published bytes after
  anonymous download (#256).
- A Claude task that starts a background Monitor now runs to the follow-up its
  completion wakes. Each event the monitor delivers drives its own model call
  and its own result, and the turn stays open across all of them. Previously a
  completion arriving while a call was still in flight closed the turn on that
  in-flight result and dropped the follow-up, and a foreground subagent's
  completion notification was mistaken for a background one (#258).

## If 0.5.15 left your daemon crashing

`brew services list` may show `wisp` restarting repeatedly, and Desktop may show
`could not open a shell (1006)` or `could not reach the daemon`. Upgrading
replaces the signature and the launchd service together:

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
channel URL remains compatible and advertises the regular 0.5.16 version.
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
  https://raw.githubusercontent.com/Pepewitch/wisp/v0.5.16/scripts/install.sh | sh
```

Back up task state **and the original Git repositories** before upgrading.
Follow [backup and restore](https://github.com/Pepewitch/wisp/blob/v0.5.16/docs/INSTALL.md#back-up-and-restore-a-wisp-home); copying `.wisp`
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
preparation, the 0.5.16 artifact gates are pending; the [qualification ledger](https://github.com/Pepewitch/wisp/blob/main/docs/v0.5/QUALIFICATION.md)
records the final outcome separately from these immutable release notes.

The release gates verify that the signed daemon carries both entitlements, but
no gate yet runs the shipped daemon's terminal end to end: 0.5.15 passed every
check while crashing on the first terminal open, because each gate runs the
binary only long enough for `wisp version`. Upgrading from 0.5.14 or earlier has
not been observed on a clean machine for this version, and the qualification
ledger records what the automated gates do and do not prove. macOS does not
remove App Management records for binaries installed by earlier Wisp releases;
those older rows can still be removed manually in System Settings. Native
dependency advisories still include upstream maintenance notices and a
locked Linux-only glib warning. Full clean-machine provider journeys, a
human-observed Desktop upgrade across this version, broad OS coverage, and
cross-machine restore remain incomplete. Task export excludes repositories and
provider sessions; it is not a complete backup or an import format. Permanent
deletion is logical, not forensic erasure. This release is not a security
certification.

## Release assets

The release contains these ten immutable assets:

- `wisp-v0.5.16-linux-x86_64`
- `release-manifest.json`
- `SHA256SUMS`
- `wisp-v0.5.16-darwin-arm64.tar.gz`
- `release-manifest-darwin-arm64.json`
- `SHA256SUMS-darwin-arm64`
- `wisp-desktop-v0.5.16-darwin-arm64.tar.gz`
- `wisp-desktop-v0.5.16-darwin-arm64.tar.gz.sig`
- `release-manifest-desktop-darwin-arm64.json`
- `SHA256SUMS-desktop-darwin-arm64`
