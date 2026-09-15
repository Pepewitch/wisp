# Wisp 0.5.9

Wisp 0.5.9 is a regular pre-1.0 release of both the daemon and Desktop app.
It adds keyboard task cycling in Desktop and a Droid limits shortcut, makes
prompt compaction visible and non-interruptible, and polishes the connection
and attachment controls.

## What changed since 0.5.8

- **Desktop can cycle through visible tasks from the keyboard.** `Ctrl+Tab`
  selects the next task and `Ctrl+Shift+Tab` selects the previous one, wrapping
  at either end while leaving browser tab shortcuts unchanged. (#219)
- **Droid tasks expose `/limits` without starting a turn.** Choosing the
  command opens Factory usage settings directly, so checking allowance does
  not spend model tokens or add conversation activity. (#221)
- **Prompt compaction now has an explicit lifecycle.** The active turn shows
  that context is being compacted, suppresses duplicate status, and blocks
  steering until compaction settles instead of accepting work that cannot run
  yet. (#220)
- **Current harness contracts and model lists are verified.** Built-in facts
  now cover Claude 2.1.272, Codex 0.154.0, Cursor
  2026.09.10-fd3934a, Droid 0.219.0, and OpenCode 1.18.31, including an
  upstream release check for OpenCode. (#217)
- **Connection actions live on the selected Desktop tab.** Rename, reconnect,
  edit, and remove controls now sit beside the connection they affect rather
  than looking like a global action at the end of the tab row. (#218)
- **The composer stays legible in narrow panes.** The attachment button remains
  inside the composer, live send-state guidance uses the existing hint row,
  and controls wrap rather than overlap when the pane or Desktop zoom leaves
  less room. (#215, #216)
- Internal release hygiene: Linux and macOS release payloads can build in
  parallel behind candidate checks, promotion handles concurrent verification
  safely, and updater verification is built as a standalone locked tool.
  The Desktop TLS stack is also locked to the fix for RUSTSEC-2026-0285, and
  the 0.5.8 qualification record is current. (#213, #214)

## Install or upgrade

Apple Silicon macOS (12.3 configured minimum):

```sh
brew install --cask Pepewitch/tap/wisp-desktop
open -a Wisp
```

The Cask installs the separate daemon Formula as a dependency. Existing
updater-capable Desktop builds can use **Updates → Check now**, then **Update
Desktop and relaunch**. Update **Local daemon** separately. The legacy alpha
channel URL remains compatible and advertises the regular 0.5.9 version.
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
  https://raw.githubusercontent.com/Pepewitch/wisp/v0.5.9/scripts/install.sh | sh
```

Back up task state **and the original Git repositories** before upgrading.
Follow [backup and restore](https://github.com/Pepewitch/wisp/blob/v0.5.9/docs/INSTALL.md#back-up-and-restore-a-wisp-home); copying `.wisp`
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
preparation, the 0.5.9 artifact gates are pending; the [qualification ledger](https://github.com/Pepewitch/wisp/blob/main/docs/v0.5/QUALIFICATION.md)
records the final outcome separately from these immutable release notes.

Keyboard task cycling is Desktop-only and follows the current sidebar order.
`/limits` is Droid-only and opens Factory's hosted settings rather than
reporting allowance inside Wisp. Native compaction still costs model tokens,
and steering remains unavailable while it runs.
Native dependency advisories still include upstream maintenance notices and a
locked Linux-only glib warning. Full clean-machine provider journeys, a
human-observed Desktop upgrade across this version, broad OS coverage, and
cross-machine restore remain incomplete. Task export excludes repositories and
provider sessions; it is not a complete backup or an import format. Permanent
deletion is logical, not forensic erasure. This release is not a security
certification.

## Release assets

The release contains these ten immutable assets:

- `wisp-v0.5.9-linux-x86_64`
- `release-manifest.json`
- `SHA256SUMS`
- `wisp-v0.5.9-darwin-arm64.tar.gz`
- `release-manifest-darwin-arm64.json`
- `SHA256SUMS-darwin-arm64`
- `wisp-desktop-v0.5.9-darwin-arm64.tar.gz`
- `wisp-desktop-v0.5.9-darwin-arm64.tar.gz.sig`
- `release-manifest-desktop-darwin-arm64.json`
- `SHA256SUMS-desktop-darwin-arm64`
