# Wisp 0.9.1

Wisp 0.9.1 makes updates easier to find and to install, and moves new Codex
tasks to GPT-6.2 Sol. You would notice four things:

- **Check now sees a release the moment it is out.** Desktop's **Check now**,
  the daemon's update check and `wisp update` no longer report "up to date"
  for the first few minutes after a release, and a Desktop left open checks
  again every six hours instead of only at launch.
- **A daemon nothing supervises can still update.** A foreground
  `wisp serve`, a Homebrew daemon outside `brew services`, or a Linux daemon
  outside `wisp.service` installs the update and tells you how to restart,
  instead of refusing.
- **New Codex tasks start on `gpt-6.2-sol`.** Codex's catalog added GPT-6.2
  Sol and GPT-6.2 Astra, and Wisp's Codex default follows Codex's own.
- **Desktop's sidebar is glassy.** On macOS the sidebar shows the system's
  sidebar material through a mostly opaque tint, like native sidebars.

## What changed since 0.9.0

**Updates**

- **Check now reads the tap at its current commit** (#583, #585). GitHub's
  CDN caches the update channel for about five minutes and ignores query
  strings, so an explicit check could miss a release that had just been
  promoted. Desktop's Check now, the daemon's forced refresh and
  `wisp update` now ask the GitHub API for the tap's current commit and read
  the channel at that commit. Any failure of that lookup, including GitHub's
  limit of 60 unauthenticated requests an hour, falls back silently to the
  old URL. Routine checks are unchanged.
- **Desktop checks again while it stays open** (#583). With automatic checks
  on, Desktop checks every six hours plus up to 30 minutes of jitter, not
  only once after launch. It skips a check while another check or an install
  runs, once an update was found, or while an installed update waits for
  relaunch. The setting now reads **Check Desktop automatically**; an
  existing opt-out carries over.
- **"Up to date" says when it was checked** (#583). The Wisp Desktop row, the
  Local daemon row and the browser's daemon update popover show "Checked 5
  min ago", with the exact time on hover.
- **Updates install without a supervisor** (#585). A daemon nothing will
  restart now installs the release, does not restart, and says how to finish:
  `brew services start wisp` for Homebrew, `systemctl --user restart
  wisp.service` for a managed Linux install with the unit, or restarting
  `wisp serve` however you started it. Such an install interrupts nothing, so
  it does not ask about running tasks. A second install before the restart is
  refused until you restart. `GET/POST /api/update` adds `canInstall`,
  `restartsAutomatically` and the state `restart-required`; `canAutoUpdate`
  keeps its meaning, so older clients still offer only updates that restart.
- **Custom Linux install roots update** (#585). A daemon installed with a
  custom `WISP_INSTALL_ROOT` and run by `wisp.service` reported "Wisp does not
  recognize this installation", because the unit does not carry that
  variable. The daemon now finds its root from its own executable;
  `WISP_INSTALL_ROOT` still wins when it names this installation.

**Codex**

- **New Codex tasks default to `gpt-6.2-sol`** (#587). Codex's catalog added
  `gpt-6.2-sol` and `gpt-6.2-astra`, and both appear in the picker without a
  Wisp change because Codex models are discovered from the installed CLI.
  Wisp's own Codex default moves from `gpt-6.1-sol` to `gpt-6.2-sol`. It still
  applies only when the installed Codex lists it; an older Codex keeps its own
  default. A `harnessDefaults` pin is unaffected.
- **Codex pins re-verified against 0.170.0** (#587, #588). Codex's zero-token
  surfaces were re-read against codex-cli 0.168.0 and then 0.170.0. The only
  other change is a new `codex exec --trust` flag, which Wisp does not use:
  its Codex turns run on `codex app-server`, which has no such flag.

**Desktop**

- **A glassy sidebar over macOS vibrancy** (#581). The sidebar and the top
  bar's left end show the macOS sidebar material through a tint that is
  still mostly the sidebar's own colour, and grey out when the window is in
  the background. The material follows Wisp's theme rather than the Mac's.
  The browser, the PWA and a narrow window's drawer look as before.

**Project**

- **Release gate:** every release candidate now proves that the release the
  tap currently promotes can update itself to the candidate through its real,
  unmodified Linux update path (#584).
- **Docs:** 0.9.0's publication was recorded (#582).

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
channel URL remains compatible and advertises the regular 0.9.1 version.
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
  https://raw.githubusercontent.com/Pepewitch/wisp/v0.9.1/scripts/install.sh | sh
```

Back up task state **and the original Git repositories** before upgrading.
Follow [backup and restore](https://github.com/Pepewitch/wisp/blob/v0.9.1/docs/INSTALL.md#back-up-and-restore-a-wisp-home); copying `.wisp`
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
preparation, the 0.9.1 artifact gates are pending; the [qualification ledger](https://github.com/Pepewitch/wisp/blob/main/docs/v0.9/QUALIFICATION.md)
records the final outcome separately from these immutable release notes.

Check now's commit lookup is unauthenticated, so past GitHub's limit of 60
requests an hour from one address it falls back to the cached channel and can
again miss a release for a few minutes. An update installed without a
supervisor runs only after you restart the daemon yourself. The glassy
sidebar is macOS Desktop only. Wisp's `gpt-6.2-sol` default applies only once
the daemon's model probe shows the installed Codex offers it; until then the
Codex default runs.
Native dependency advisories still include upstream maintenance notices and a
locked Linux-only glib warning. Full clean-machine provider journeys, a
human-observed Desktop upgrade across this version, broad OS coverage, and
cross-machine restore remain incomplete. Task export excludes repositories and
provider sessions; it is not a complete backup or an import format. Permanent
deletion is logical, not forensic erasure. This release is not a security
certification.

## Release assets

The release contains these ten immutable assets:

- `wisp-v0.9.1-linux-x86_64`
- `release-manifest.json`
- `SHA256SUMS`
- `wisp-v0.9.1-darwin-arm64.tar.gz`
- `release-manifest-darwin-arm64.json`
- `SHA256SUMS-darwin-arm64`
- `wisp-desktop-v0.9.1-darwin-arm64.tar.gz`
- `wisp-desktop-v0.9.1-darwin-arm64.tar.gz.sig`
- `release-manifest-desktop-darwin-arm64.json`
- `SHA256SUMS-desktop-darwin-arm64`
