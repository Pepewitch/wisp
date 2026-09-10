# Wisp 0.5.4

Wisp 0.5.4 is a regular pre-1.0 release of both the daemon and Desktop app. It
makes the phone UI an installable PWA with an explicit offline recovery screen,
adds read-only storage reporting and bounded retention for archived raw turn
logs, and lets operators choose the shell used by embedded terminals.

## What changed since 0.5.3

- **Embedded terminals can use a configured shell.** Browser and Desktop
  terminals still use the OS account's login shell by default. Set an absolute
  executable path such as `"terminalShell": "/bin/zsh"` in `config.json` and
  restart the daemon to use it for new terminal sessions instead. Invalid or
  non-executable paths now fail at configuration load rather than at the first
  terminal connection. (#147)
- **The phone UI is an installable PWA.** Wisp now supplies its own home-screen
  icons, standalone display metadata, safe-area and keyboard handling, and
  browser-specific installation guidance in Settings. Launching an installed
  app while its private Wisp route is unavailable shows a small recovery page
  that retries when the network or app returns. The service worker deliberately
  does not cache conversations, credentials, the app bundle, or commands for
  later delivery. (#146)
- **Archived history has visible, bounded storage.** `wisp doctor --storage`
  reports the local home's logical storage without modifying it or requiring a
  daemon. `wisp purge --archived-before <age-or-date>` previews old archived
  tasks and requires the matching count before deleting them. Archived raw turn
  logs now default to 90 days and 1 GiB in total, evicting whole eligible turns
  oldest first while preserving indexed agent prose, prompts, and final
  results. Live tasks, incomplete indexes, active readers, exports, and
  unsettled cleanup remain protected, and every surface states when a raw
  transcript was evicted. (#130)
- **`wisp models` agrees with the task picker.** When an installed harness does
  not enumerate models, the command now reports the adapter's pinned default and
  curated subset instead of claiming that no default exists. Curated lists are
  clearly labeled as subsets, so Cursor users see the same offered IDs in the
  CLI report and composer without implying that other accepted IDs are invalid.
  (#131)
- **Task mode and base are easier to scan.** The worktree/local mode and base
  selectors now have distinct icons and their own row beside the project,
  keeping model controls separate and preserving the project path at narrow
  widths. (#144)
- **Linux requirements now separate qualification from compatibility.** Ubuntu
  24.04 remains the gated Linux target, while the self-contained x86_64
  artifact's glibc 2.17 floor is stated separately. Release builds derive the
  required glibc symbols from the binary and fail if the pinned toolchain raises
  that floor without a deliberate documentation and gate update. (#135, #145)
- **Non-systemd operation has an explicit contract.** The install guide now
  documents the restart, private-umask, environment, PATH, and process-only stop
  behavior another supervisor must reproduce, with a worked supervisord
  example. It also explains that credentials exported only in an interactive
  shell are unavailable to any separately supervised daemon, and that a green
  shell-side `wisp doctor` probe does not prove a real daemon-spawned turn can
  authenticate. (#134, #142, #143)
- **`wisp project list` works as documented.** It is now accepted as an alias
  for `wisp project ls`. (#136, #137)

## Install or upgrade

Apple Silicon macOS (12.3 configured minimum):

```sh
brew install --cask Pepewitch/tap/wisp-desktop
open -a Wisp
```

The Cask installs the separate daemon Formula as a dependency. Existing
updater-capable Desktop builds can use **Updates → Check now**, then **Update
Desktop and relaunch**. Update **Local daemon** separately. The legacy alpha
channel URL remains compatible and advertises the regular 0.5.4 version.
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
  https://raw.githubusercontent.com/Pepewitch/wisp/v0.5.4/scripts/install.sh | sh
```

Back up task state **and the original Git repositories** before upgrading.
Follow [backup and restore](https://github.com/Pepewitch/wisp/blob/v0.5.4/docs/INSTALL.md#back-up-and-restore-a-wisp-home); copying `.wisp`
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
preparation, the 0.5.4 artifact gates are pending; the [qualification ledger](https://github.com/Pepewitch/wisp/blob/main/docs/v0.5/QUALIFICATION.md)
records the final outcome separately from these immutable release notes.

The PWA's offline page is recovery-only: the first visit needs a working private
HTTPS route, and no task data or commands are available offline. Archived-log
retention can permanently remove raw reasoning and tool activity after its age
or byte limit; protected logs may keep the archive above the configured byte
ceiling. Storage reports use logical file sizes and can be approximate during
concurrent writes; purging does not remove orphan worktrees or shrink SQLite.
A configured terminal shell must accept `-l`, takes effect only for new
sessions after restart, and does not change harness subprocess shells.
Adapter-curated model lists remain non-exhaustive, and Wisp does not reject
unknown model IDs that a harness may accept or silently reinterpret. Ubuntu
24.04 is still the only qualified Linux distribution; other x86_64 glibc
systems at or above the stated floor remain untested.
Native dependency advisories still include upstream maintenance notices and a
locked Linux-only glib warning. Full clean-machine provider journeys, a
human-observed Desktop upgrade across this version, broad OS coverage, and
cross-machine restore remain incomplete. Task export excludes repositories and
provider sessions; it is not a complete backup or an import format. Permanent
deletion is logical, not forensic erasure. This release is not a security
certification.

## Release assets

The release contains these ten immutable assets:

- `wisp-v0.5.4-linux-x86_64`
- `release-manifest.json`
- `SHA256SUMS`
- `wisp-v0.5.4-darwin-arm64.tar.gz`
- `release-manifest-darwin-arm64.json`
- `SHA256SUMS-darwin-arm64`
- `wisp-desktop-v0.5.4-darwin-arm64.tar.gz`
- `wisp-desktop-v0.5.4-darwin-arm64.tar.gz.sig`
- `release-manifest-desktop-darwin-arm64.json`
- `SHA256SUMS-desktop-darwin-arm64`
