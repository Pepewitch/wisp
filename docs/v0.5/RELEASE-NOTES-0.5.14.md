# Wisp 0.5.14

Wisp 0.5.14 gives the Homebrew daemon one stable, branded macOS application
identity so future upgrades stop adding indistinguishable App Management
entries. It also adds per-harness model visibility controls shared by Desktop
and browser clients, and exposes Cursor's full discovered model catalog instead
of filtering it to a small built-in subset.

## What changed since 0.5.13

- The Homebrew daemon now ships inside a background-only `Wisp Daemon.app`
  with the Wisp icon, while the `wisp` command and launchd service continue to
  invoke its bundled executable. New macOS App Management entries are therefore
  recognizable and remain associated with one application across upgrades.
- Publishable macOS daemon builds now keep the stable `dev.wisp.daemon` code
  identity and require Developer ID signing, notarization, and stapling. This
  prevents each upgraded executable from looking like an unrelated app to
  macOS (#249).
- Models can be hidden per harness from **Settings → Models** or directly from
  either model picker. The preference follows the daemon across Desktop,
  browser, and phone clients; hidden models remain runnable and can be revealed
  temporarily from the picker. Cursor discovery now shows its full reported
  catalog so users, rather than a built-in filter, decide which models to keep
  visible (#248).

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
channel URL remains compatible and advertises the regular 0.5.14 version.
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
  https://raw.githubusercontent.com/Pepewitch/wisp/v0.5.14/scripts/install.sh | sh
```

Back up task state **and the original Git repositories** before upgrading.
Follow [backup and restore](https://github.com/Pepewitch/wisp/blob/v0.5.14/docs/INSTALL.md#back-up-and-restore-a-wisp-home); copying `.wisp`
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
Cask, daemon channel, and Desktop channel together. At source preparation, the
0.5.14 artifact gates are pending; the [qualification ledger](https://github.com/Pepewitch/wisp/blob/main/docs/v0.5/QUALIFICATION.md)
records the final outcome separately from these immutable release notes.

macOS does not remove App Management records for binaries installed by earlier
Wisp releases. After upgrading, those pale or terminal-icon rows can be removed
manually in System Settings; future upgrades use the single branded daemon
application identity. Model visibility is a presentation preference, not an
execution restriction: hidden models remain valid through the CLI and API.
Native dependency advisories still include upstream maintenance notices and a
locked Linux-only glib warning. Full clean-machine provider journeys, a
human-observed Desktop upgrade across this version, broad OS coverage, and
cross-machine restore remain incomplete. Task export excludes repositories and
provider sessions; it is not a complete backup or an import format. Permanent
deletion is logical, not forensic erasure. This release is not a security
certification.

## Release assets

The release contains these ten immutable assets:

- `wisp-v0.5.14-linux-x86_64`
- `release-manifest.json`
- `SHA256SUMS`
- `wisp-v0.5.14-darwin-arm64.tar.gz`
- `release-manifest-darwin-arm64.json`
- `SHA256SUMS-darwin-arm64`
- `wisp-desktop-v0.5.14-darwin-arm64.tar.gz`
- `wisp-desktop-v0.5.14-darwin-arm64.tar.gz.sig`
- `release-manifest-desktop-darwin-arm64.json`
- `SHA256SUMS-desktop-darwin-arm64`
