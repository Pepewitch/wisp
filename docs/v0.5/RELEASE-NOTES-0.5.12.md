# Wisp 0.5.12

Wisp 0.5.12 is a regular pre-1.0 release of both the daemon and Desktop
app. It opens cited worktree files at the requested source lines, keeps
Droid questionnaire cards in sync during live turns, and removes a duplicate
mobile workflows title.

## What changed since 0.5.11

- **Jump directly to cited source lines.** Worktree file links using
  compiler-style `path:line[:column]` locations or GitHub-style `#L42` and
  `#L42-L50` anchors now open the text preview, scroll to the requested line,
  and highlight the selected range. Nested document links preserve their line
  target. (#239)
- **Droid questionnaires stay live.** Structured questionnaire events now pass
  through the Browser and Desktop stream decoder, so an active `AskUser`
  request renders its answer card instead of falling back to **Needs input**
  beside a stale **Working…** row. (#238)
- **The mobile workflows pane has one title.** The redundant title-only header
  is hidden on mobile while the Desktop tab strip remains unchanged. (#237)
- Internal release hygiene: the 0.5.11 publication and promotion evidence is
  recorded without claiming qualification that did not run. (#236)

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
channel URL remains compatible and advertises the regular 0.5.12 version.
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
  https://raw.githubusercontent.com/Pepewitch/wisp/v0.5.12/scripts/install.sh | sh
```

Back up task state **and the original Git repositories** before upgrading.
Follow [backup and restore](https://github.com/Pepewitch/wisp/blob/v0.5.12/docs/INSTALL.md#back-up-and-restore-a-wisp-home); copying `.wisp`
alone does not preserve linked worktrees or unpublished Git objects.
This release adds no database migration.

## Scope and known limits

This release is for a trusted single OS user. Worktrees separate checkouts;
they do not sandbox agents or their credentials. There is no multi-user
permission boundary. Closing Desktop leaves daemons and agents running.
Intel macOS and non-Apple-Silicon Desktop builds are unsupported.

Desktop publication requires Developer ID signing, notarization, a stapled
ticket, and a verified updater signature. The macOS daemon remains ad-hoc
signed. Automated release gates verify immutable downloads and promote the
Formula, Cask, daemon channel, and Desktop channel together. At source
preparation, the 0.5.12 artifact gates are pending; the [qualification ledger](https://github.com/Pepewitch/wisp/blob/main/docs/v0.5/QUALIFICATION.md)
records the final outcome separately from these immutable release notes.

Source-line targeting is limited to text files inside the task worktree;
binary files still show only their metadata. Compiler-style locations require
an unambiguous path, while bare filenames can use the GitHub `#L` form.
Questionnaire cards require structured events from the harness; older event
shapes retain the message-based **Needs input** fallback.
Native dependency advisories still include upstream maintenance notices and a
locked Linux-only glib warning. Full clean-machine provider journeys, a
human-observed Desktop upgrade across this version, broad OS coverage, and
cross-machine restore remain incomplete. Task export excludes repositories and
provider sessions; it is not a complete backup or an import format. Permanent
deletion is logical, not forensic erasure. This release is not a security
certification.

## Release assets

The release contains these ten immutable assets:

- `wisp-v0.5.12-linux-x86_64`
- `release-manifest.json`
- `SHA256SUMS`
- `wisp-v0.5.12-darwin-arm64.tar.gz`
- `release-manifest-darwin-arm64.json`
- `SHA256SUMS-darwin-arm64`
- `wisp-desktop-v0.5.12-darwin-arm64.tar.gz`
- `wisp-desktop-v0.5.12-darwin-arm64.tar.gz.sig`
- `release-manifest-desktop-darwin-arm64.json`
- `SHA256SUMS-desktop-darwin-arm64`
