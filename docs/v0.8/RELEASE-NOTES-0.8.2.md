# Wisp 0.8.2

Wisp 0.8.2 makes a turn's images readable and the phone layout physical.
Images now sit under the step that produced them, with their real names, and
the phone's sidebar and task sheet follow your thumb when you drag them.

- **Images where they happened.** Expand a turn's steps and each image sits
  under the step that made it; after the reply, only the images the agent
  shared appear. Codex's generated images are kept whole.
- **Drag on the phone.** Swipe right to open the sidebar, left to close it, and
  drag the task sheet down to close it; each follows the finger and settles
  when you let go.
- **Current Claude lineup.** The picker offers Sonnet 5.5 and Haiku 5.5.

## What changed since 0.8.1

- **Turn images by step** (#460). Every captured image records the step that
  produced it and keeps its real file name. Expanded, a turn's steps show each
  image under its step; collapsed, the steps row reads "looked at N images".
  After the reply only images the agent shared appear, each captioned with its
  step. Images claude and droid open, and codex's MCP results, image views and
  generated images, are captured while the turn runs (droid's and codex's are
  new; codex's generated images used to be lost to the transcript's size cap).
  A \`wisp output add\` gets a step only when exactly one command is running.
  \`wisp output list\` and \`wisp show\` name each image's step.
- **Phone sidebar by drag** (#463). A sideways drag anywhere on the main view
  opens the sidebar under the thumb, and dragging it back closes it; it settles
  on release by distance and speed. Vertical scrolls, text fields, code blocks
  and tables that scroll sideways keep their own touches.
- **Phone task sheet by drag** (#464). Drag the task sheet down to close it,
  the same way; a list inside the sheet scrolls back to its top before the
  sheet moves.
- **Harness pins** (#461). Claude, codex and cursor are re-verified against
  their current CLIs (claude 2.1.311, codex 0.164.0, cursor 2026.10.22).
  Claude's picker offers Sonnet 5.5 and Haiku 5.5 instead of Sonnet 5 and
  Haiku 4.5; an \`adapters.json\` default naming a dropped id falls back to
  Opus 5.5 with a warning instead of stopping the daemon.

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
channel URL remains compatible and advertises the regular 0.8.2 version.
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
  https://raw.githubusercontent.com/Pepewitch/wisp/v0.8.2/scripts/install.sh | sh
```

Back up task state **and the original Git repositories** before upgrading.
Follow [backup and restore](https://github.com/Pepewitch/wisp/blob/v0.8.2/docs/INSTALL.md#back-up-and-restore-a-wisp-home); copying `.wisp`
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
preparation, the 0.8.2 artifact gates are pending; the [qualification ledger](https://github.com/Pepewitch/wisp/blob/main/docs/v0.8/QUALIFICATION.md)
records the final outcome separately from these immutable release notes.

In this release: Cursor and opencode capture no images the agent opens
(their reads report a path only; #462). The phone drags were verified with
synthetic touches in a browser, not yet on a device. droid and opencode pins
were not refreshed (their installed CLIs are behind upstream).
Native dependency advisories still include upstream maintenance notices and a
locked Linux-only glib warning. Full clean-machine provider journeys, a
human-observed Desktop upgrade across this version, broad OS coverage, and
cross-machine restore remain incomplete. Task export excludes repositories and
provider sessions; it is not a complete backup or an import format. Permanent
deletion is logical, not forensic erasure. This release is not a security
certification.

## Release assets

The release contains these ten immutable assets:

- `wisp-v0.8.2-linux-x86_64`
- `release-manifest.json`
- `SHA256SUMS`
- `wisp-v0.8.2-darwin-arm64.tar.gz`
- `release-manifest-darwin-arm64.json`
- `SHA256SUMS-darwin-arm64`
- `wisp-desktop-v0.8.2-darwin-arm64.tar.gz`
- `wisp-desktop-v0.8.2-darwin-arm64.tar.gz.sig`
- `release-manifest-desktop-darwin-arm64.json`
- `SHA256SUMS-desktop-darwin-arm64`
