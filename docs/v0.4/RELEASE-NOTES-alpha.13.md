# Wisp 0.4.0-alpha.13

This is an **experimental feature prerelease**, not production-ready software.
It is the second Wisp Desktop release intended to ship with Developer ID
signing, Apple notarization, and cryptographically signed in-app updates.

Alpha.12 established the updater trust root and passed signed publication,
anonymous-download, Homebrew upgrade, Gatekeeper, and installed-app checks on
one Apple Silicon Mac. Alpha.13 is the first newer signed release that can
qualify the updater itself by replacing an installed alpha.12 application.

The desktop app targets Apple Silicon macOS 12.3 or newer. Intel macOS remains
unsupported, and the configured deployment minimum is not evidence that every
macOS version in that range has been qualified.

Alpha.13 passed signing, notarization, stapling, public-download verification,
Homebrew publication, and the alpha.12-to-alpha.13 in-app update receipt before
closeout. It remains an experimental alpha after those gates.

## Install or upgrade

A new Mac can install the Desktop app and its required CLI/daemon Formula with:

```sh
brew install --cask Pepewitch/tap/wisp-desktop
open -a Wisp
```

An installed alpha.12 Desktop app should use **Updates → Check now**, inspect
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
  https://raw.githubusercontent.com/Pepewitch/wisp/v0.4.0-alpha.13/scripts/install.sh |
  sh
```

## What changed

- Added a Settings dialog with system, light, and dark appearance choices and
  persisted theme selection shared by browser and Desktop UI.
- Rebuilt the small-screen shell around compact banded navigation so connection,
  task, chat, changes, and terminal context remain usable on narrow displays.
- Fixed the signed Desktop packager to recognize Apple's stapled
  `Contents/CodeResources` ticket while continuing to reject unexpected files
  from unsigned or signed bundles.
- Updated the generated Homebrew Cask to the current style and stanza ordering,
  with regression coverage that keeps release output directly auditable.

## Known limits

- The updater path is qualified only by one alpha.12-to-alpha.13 journey on one
  Apple Silicon Mac. This is not broad hardware or macOS qualification, and a
  future trust-root, channel, installer, or updater change must repeat the
  two-version receipt.
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

- `wisp-v0.4.0-alpha.13-linux-x86_64`
- `release-manifest.json`
- `SHA256SUMS`
- `wisp-v0.4.0-alpha.13-darwin-arm64.tar.gz`
- `release-manifest-darwin-arm64.json`
- `SHA256SUMS-darwin-arm64`
- `wisp-desktop-v0.4.0-alpha.13-darwin-arm64.tar.gz`
- `wisp-desktop-v0.4.0-alpha.13-darwin-arm64.tar.gz.sig`
- `release-manifest-desktop-darwin-arm64.json`
- `SHA256SUMS-desktop-darwin-arm64`

All ten assets were published from clean commit
`8fb6065b902b66d88dd3a569989442b8b1296a9a`. Anonymous downloads matched the
qualified bytes; checksum, tampered-signature rejection, Developer ID,
notarization, staple, Gatekeeper, strict Homebrew audit, in-app replacement,
relaunch, and state-preservation checks passed. Homebrew tap commit
`4fbb81e136043605f8b7865fa97fddb15dbc063f` advanced the Formula, Cask, and
Desktop channel together.
