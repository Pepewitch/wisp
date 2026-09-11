# Wisp 0.5.5

Wisp 0.5.5 is a regular pre-1.0 release of both the daemon and Desktop app. It
lets a turn attach PDF, text, and video as well as images, makes the phone
terminal scroll, copy, and paste, and relaunches Desktop cleanly after an
in-app update.

## What changed since 0.5.4

- **Turns can attach PDF, text, and video, not just images.** A turn still
  accepts up to 10 files, now under one 50 MB budget: images stay at 5 MB each,
  PDF and text at 20 MB, and video at 50 MB. Images keep their native harness
  channels; everything else is delivered by naming its absolute path in the
  prompt, which works on every harness and never copies the file into the
  worktree. `wisp new` and `wisp send` gain `--attach`; `--image` still works.
  A paste over 8,000 characters becomes a text file instead of composer
  content, with a way to insert it inline. Type comes from magic bytes, not
  the filename. (#158)
- **The phone terminal can scroll, copy, and paste.** A finger swipe now
  scrolls the buffer. Copy takes a drawn selection when there is one, and the
  whole buffer when there is not; paste uses the terminal engine's own API.
  Controls disable themselves when the browser will not grant clipboard
  access. A long-press on a coarse pointer hands the visible rows to the
  platform so the OS selection handles can appear. (#156)
- **The steer composer fits a phone.** Unchosen optional controls collapse to
  glyphs, the model chip is the one item that may truncate, and every remaining
  control stays a 44px target. The draft box grows with its text up to the
  existing cap. On a soft keyboard, Return breaks a line and the send button
  submits. Pointer layouts keep Return-to-send. (#150)
- **Desktop relaunches after an in-app update.** Updating Desktop and
  relaunching now queues the restart through the app's run loop instead of
  exiting immediately, so macOS can launch the replacement. (#152)
- **A refused terminal origin is diagnosable.** When a reverse proxy rewrites
  `Host` and the terminal socket never opens, the pane now shows the daemon's
  refusal sentence instead of a silent retry. The daemon logs the rejected
  origin, prints accepted origins at startup, and `wisp doctor` reports the
  running daemon's terminal origins rather than the invoking shell's. (#157)
- **Switching tasks no longer waits on Git.** The browser and Desktop load a
  conversation from SQLite instead of a Git-aware task detail call. An older
  protocol-1 daemon still falls back to the previous route. (#151)
- **Creating a task keeps focus on the new row.** The sidebar and conversation
  follow the created task instead of snapping back to the previous selection.
  (#154)
- **Standalone PWA fills the bottom safe area.** The installed phone app
  extends into the home-indicator inset, and yields that space while the
  software keyboard is open. Regular mobile browser tabs are unchanged. (#153)
- **Tailscale Serve no longer assumes it owns `/`.** The remote-access recipe
  now checks `tailscale serve status` first and documents a non-colliding
  HTTPS port when `/` is already mapped. Serving Wisp under a subpath is not
  supported. (#155)

## Install or upgrade

Apple Silicon macOS (12.3 configured minimum):

```sh
brew install --cask Pepewitch/tap/wisp-desktop
open -a Wisp
```

The Cask installs the separate daemon Formula as a dependency. Existing
updater-capable Desktop builds can use **Updates → Check now**, then **Update
Desktop and relaunch**. Update **Local daemon** separately. The legacy alpha
channel URL remains compatible and advertises the regular 0.5.5 version.
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
  https://raw.githubusercontent.com/Pepewitch/wisp/v0.5.5/scripts/install.sh | sh
```

Back up task state **and the original Git repositories** before upgrading.
Follow [backup and restore](https://github.com/Pepewitch/wisp/blob/v0.5.5/docs/INSTALL.md#back-up-and-restore-a-wisp-home); copying `.wisp`
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
preparation, the 0.5.5 artifact gates are pending; the [qualification ledger](https://github.com/Pepewitch/wisp/blob/main/docs/v0.5/QUALIFICATION.md)
records the final outcome separately from these immutable release notes.

Phone long-press selection is experimental: only currently visible rows exist
in the DOM, and new output can destroy an in-progress selection. Clipboard
buttons need a secure context; Firefox may offer copy without paste. No
harness can watch an attached video — the file is there to sample frames from,
and a 50 MB video consumes the whole turn budget. Large pastes become files
rather than composer text. Terminal origin diagnosis applies to the browser
path; Desktop strips Origin and authenticates upstream. Ubuntu 24.04 is still
the only qualified Linux distribution; other x86_64 glibc systems at or above
the stated floor remain untested.
Native dependency advisories still include upstream maintenance notices and a
locked Linux-only glib warning. Full clean-machine provider journeys, a
human-observed Desktop upgrade across this version, broad OS coverage, and
cross-machine restore remain incomplete. Task export excludes repositories and
provider sessions; it is not a complete backup or an import format. Permanent
deletion is logical, not forensic erasure. This release is not a security
certification.

## Release assets

The release contains these ten immutable assets:

- `wisp-v0.5.5-linux-x86_64`
- `release-manifest.json`
- `SHA256SUMS`
- `wisp-v0.5.5-darwin-arm64.tar.gz`
- `release-manifest-darwin-arm64.json`
- `SHA256SUMS-darwin-arm64`
- `wisp-desktop-v0.5.5-darwin-arm64.tar.gz`
- `wisp-desktop-v0.5.5-darwin-arm64.tar.gz.sig`
- `release-manifest-desktop-darwin-arm64.json`
- `SHA256SUMS-desktop-darwin-arm64`
