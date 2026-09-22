# Wisp 0.5.13

Wisp 0.5.13 adds a per-task fast mode for harnesses that sell a faster lane
for the same model, discovers available Cursor models from the authenticated
`cursor-agent` CLI instead of a hardcoded list, and fixes Claude background
tasks being cancelled when an intermediate result arrived. Source links that
target specific lines now keep Markdown rendering and syntax highlighting
instead of falling back to raw views.

## What changed since 0.5.12

- Claude no longer closes its live session on the first intermediate result
  while a harness-managed background task is running, so task completions can
  still trigger the final model response and scheduled follow-ups (#246).
- Cursor models are discovered from the authenticated `cursor-agent models`
  command, so the model picker shows what your Cursor account actually offers
  rather than a fixed pair of IDs (#245).
- Fast mode is now a per-task toggle for harnesses that provide a faster lane
  for the same model (currently Codex), instead of a global setting you had to
  change by editing the harness's own config file (#244).
- Opening a source file at a specific line or range keeps syntax highlighting
  and scrolls to and highlights the requested lines (#243).
- Markdown files stay rendered when a link targets specific source lines, and
  the corresponding rendered blocks are highlighted and scrolled into view
  (#242).
- Documentation: the 0.5.12 qualification record landed on `main` (#241).

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
channel URL remains compatible and advertises the regular 0.5.13 version.
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
  https://raw.githubusercontent.com/Pepewitch/wisp/v0.5.13/scripts/install.sh | sh
```

Back up task state **and the original Git repositories** before upgrading.
Follow [backup and restore](https://github.com/Pepewitch/wisp/blob/v0.5.13/docs/INSTALL.md#back-up-and-restore-a-wisp-home); copying `.wisp`
alone does not preserve linked worktrees or unpublished Git objects.
This release adds database migration 13, so a 0.5.12 daemon cannot reopen a profile that 0.5.13 has opened.

## Scope and known limits

This release is for a trusted single OS user. Worktrees separate checkouts;
they do not sandbox agents or their credentials. There is no multi-user
permission boundary. Closing Desktop leaves daemons and agents running.
Intel macOS and non-Apple-Silicon Desktop builds are unsupported.

Desktop publication requires Developer ID signing, notarization, a stapled
ticket, and a verified updater signature. The macOS daemon remains ad-hoc
signed. Automated release gates verify immutable downloads and promote the
Formula, Cask, daemon channel, and Desktop channel together. At source
preparation, the 0.5.13 artifact gates are pending; the [qualification ledger](https://github.com/Pepewitch/wisp/blob/main/docs/v0.5/QUALIFICATION.md)
records the final outcome separately from these immutable release notes.

Fast mode currently applies only to harnesses that declare a speed tier
(Codex); other harnesses expose no faster lane yet. Cursor model discovery
requires `cursor-agent` to be installed and authenticated, and the picker
keeps `auto` plus `composer-*` and `cursor-*` model IDs. Native dependency
advisories still include upstream maintenance notices and a
locked Linux-only glib warning. Full clean-machine provider journeys, a
human-observed Desktop upgrade across this version, broad OS coverage, and
cross-machine restore remain incomplete. Task export excludes repositories and
provider sessions; it is not a complete backup or an import format. Permanent
deletion is logical, not forensic erasure. This release is not a security
certification.

## Release assets

The release contains these ten immutable assets:

- `wisp-v0.5.13-linux-x86_64`
- `release-manifest.json`
- `SHA256SUMS`
- `wisp-v0.5.13-darwin-arm64.tar.gz`
- `release-manifest-darwin-arm64.json`
- `SHA256SUMS-darwin-arm64`
- `wisp-desktop-v0.5.13-darwin-arm64.tar.gz`
- `wisp-desktop-v0.5.13-darwin-arm64.tar.gz.sig`
- `release-manifest-desktop-darwin-arm64.json`
- `SHA256SUMS-desktop-darwin-arm64`
