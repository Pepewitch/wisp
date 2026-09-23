# Wisp 0.5.18

Wisp 0.5.18 refreshes every built-in harness catalog and fixes Cursor model
discovery after an upgrade. Claude Opus 5.5 and the latest Codex, Droid,
Cursor, and OpenCode models now appear in Wisp's model controls. Cursor no
longer restores the old 17-model filtered catalog from its persisted cache, so
provider models such as Grok 4.7 become available without waiting for the
cache's 24-hour refresh.

## What changed since 0.5.16

- Cursor's model manager now follows the complete output of
  `cursor-agent models` immediately after a Wisp upgrade. The filter that once
  kept only `auto`, `composer-*`, and `cursor-*` had already been removed, but
  the persisted cache still treated its old filtered answer as compatible for
  up to 24 hours. Cache identity now includes the discovery implementation, so
  a parser or filtering change forces a fresh probe instead of restoring a
  semantically stale catalog (#261).
- Built-in harness facts now match Claude Code 2.1.280, Codex 0.156.1, Cursor
  2026.09.18-9a7762b, Droid 0.225.1, and OpenCode 1.18.31. Claude's curated
  picker replaces Opus 5 with Opus 5.5; Codex discovers GPT-6 Sol and GPT-6
  Luna and reports GPT-6 Sol as its default; Droid and Cursor include their
  newly advertised Claude, GPT, Grok, and Mistral entries; and OpenCode moves
  its free MiMo entry to `mimo-v2.6-flash-free` (#260).

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
channel URL remains compatible and advertises the regular 0.5.18 version.
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
  https://raw.githubusercontent.com/Pepewitch/wisp/v0.5.18/scripts/install.sh | sh
```

Back up task state **and the original Git repositories** before upgrading.
Follow [backup and restore](https://github.com/Pepewitch/wisp/blob/v0.5.18/docs/INSTALL.md#back-up-and-restore-a-wisp-home); copying `.wisp`
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
preparation, the 0.5.18 artifact gates are pending; the [qualification ledger](https://github.com/Pepewitch/wisp/blob/main/docs/v0.5/QUALIFICATION.md)
records the final outcome separately from these immutable release notes.

The catalog refresh verifies zero-token CLI surfaces. It does not re-run the
token-spending fixture, steering, and usage probes, or qualify every newly
listed model with a live coding turn. Actual model availability still depends
on the harness provider and account.
Native dependency advisories still include upstream maintenance notices and a
locked Linux-only glib warning. Full clean-machine provider journeys, a
human-observed Desktop upgrade across this version, broad OS coverage, and
cross-machine restore remain incomplete. Task export excludes repositories and
provider sessions; it is not a complete backup or an import format. Permanent
deletion is logical, not forensic erasure. This release is not a security
certification.

## Release assets

The release contains these ten immutable assets:

- `wisp-v0.5.18-linux-x86_64`
- `release-manifest.json`
- `SHA256SUMS`
- `wisp-v0.5.18-darwin-arm64.tar.gz`
- `release-manifest-darwin-arm64.json`
- `SHA256SUMS-darwin-arm64`
- `wisp-desktop-v0.5.18-darwin-arm64.tar.gz`
- `wisp-desktop-v0.5.18-darwin-arm64.tar.gz.sig`
- `release-manifest-desktop-darwin-arm64.json`
- `SHA256SUMS-desktop-darwin-arm64`
