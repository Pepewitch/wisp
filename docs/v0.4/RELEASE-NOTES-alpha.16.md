# Wisp 0.4.0-alpha.16

This is an **experimental feature prerelease**, not production-ready software.
It is the third Wisp Desktop release intended to ship with Developer ID
signing, Apple notarization, and cryptographically signed in-app updates.

Alpha.13 established the public Desktop update path by replacing an installed
alpha.12 application while preserving Desktop state. Alpha.16 carries the next
shared-interface fixes through that same channel and is intended to exercise a
second real in-app update, from alpha.13 to alpha.16.

Alpha.14 and alpha.15 were never published. Their fail-closed release workflows
stopped before signing or publication while two Linux fixtures used startup
windows that were too short for the hosted runner. Alpha.16 waits for actual
daemon readiness within bounded time; no alpha.14 or alpha.15 release assets or
Homebrew metadata exist.

The desktop app targets Apple Silicon macOS 12.3 or newer. Intel macOS remains
unsupported, and the configured deployment minimum is not evidence that every
macOS version in that range has been qualified.

Alpha.16 remains a release candidate until signing, notarization, stapling,
public-download verification, Homebrew publication, and the human-observed
alpha.13-to-alpha.16 updater journey have completed.

## Install or upgrade

A new Mac can install the Desktop app and its required CLI/daemon Formula with:

```sh
brew install --cask Pepewitch/tap/wisp-desktop
open -a Wisp
```

An installed alpha.13 Desktop app should use **Updates → Check now**, inspect
the old/new versions and notes, then choose **Update Desktop and relaunch**.
The Wisp daemon remains a separate update row and a separate Homebrew-managed
process.

Alpha.8 predates the updater. Move directly from that older build through
Homebrew instead:

```sh
brew update
brew upgrade Pepewitch/tap/wisp
brew upgrade --cask --greedy Pepewitch/tap/wisp-desktop
brew services restart wisp
open -a Wisp
```

Linux installation remains:

```sh
curl --proto '=https' --tlsv1.2 -fsSL \
  https://raw.githubusercontent.com/Pepewitch/wisp/v0.4.0-alpha.16/scripts/install.sh |
  sh
```

## What changed

- Moved message times and delivery facts into compact captions beside person
  bubbles, with pointer and keyboard-accessible controls that do not crowd the
  message text.
- Unified prompt, steer, and queued-message presentation while preserving clear
  mid-turn and queued delivery status across wide, narrow, touch, and zoomed
  layouts.
- Ranked slash commands by exact name, name prefix, and then alias relevance so
  pressing Enter runs the command the person actually typed.
- Closed the Desktop release-channel audit loop so publication waits for the
  public fixed-version metadata before performing the final Homebrew Cask
  audit.
- Made the Linux release fixtures wait for actual daemon readiness within a
  bounded window before testing port fallback or activation.

## Known limits

- The alpha.13-to-alpha.16 updater path is not qualified until the published
  build is installed through the app and the relaunch and state-preservation
  receipt is recorded.
- Apple Silicon support has limited single-machine qualification; Intel Macs
  are unsupported.
- Closing Wisp Desktop does not stop daemons or agents. The app is an interface,
  not the owner of daemon task data.
- Uninstalling the Cask quits and removes `Wisp.app` but preserves Desktop
  metadata and remote Keychain credentials. Remove remotes or use **Reset
  desktop data** first if those credentials should be deleted.
- A remote URL and token identify and authenticate a daemon; they do not create
  network reachability. The daemon must already be reachable through trusted
  HTTPS or an exact-loopback user-managed tunnel.

## Release assets

The release must publish exactly these ten immutable assets:

- `wisp-v0.4.0-alpha.16-linux-x86_64`
- `release-manifest.json`
- `SHA256SUMS`
- `wisp-v0.4.0-alpha.16-darwin-arm64.tar.gz`
- `release-manifest-darwin-arm64.json`
- `SHA256SUMS-darwin-arm64`
- `wisp-desktop-v0.4.0-alpha.16-darwin-arm64.tar.gz`
- `wisp-desktop-v0.4.0-alpha.16-darwin-arm64.tar.gz.sig`
- `release-manifest-desktop-darwin-arm64.json`
- `SHA256SUMS-desktop-darwin-arm64`

The exact release commit, public-download evidence, Homebrew tap commit, and
alpha.13-to-alpha.16 updater receipt remain pending until publication and
qualification complete.
