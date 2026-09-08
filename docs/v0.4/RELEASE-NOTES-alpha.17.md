# Wisp 0.4.0-alpha.17

This is an **experimental feature prerelease**, not production-ready software.
It is the fourth Wisp Desktop release prepared with Developer ID signing,
Apple notarization, and cryptographically signed in-app updates.

**Release outcome:** immutable publication passed from commit
`0cea1266183fb359636b934a40e860ea6f695b99`. The initial promotion attempt
exposed a trimmed Git-porcelain parsing bug without changing the immutable
release; promotion-only recovery then passed at Homebrew tap commit
`84658e9d7f48f81459fc0276bb6ec71068a759a8`.

Alpha.17 brings the daemon, browser UI, and Desktop app onto one merged release
source. It replaces the embedded terminal's pipe-backed emulation with a real
sized PTY, keeps pull-request status current when a long task creates more than
one branch, settles Droid questionnaire turns cleanly, and makes
Homebrew/Desktop channel promotion independently recoverable.

The desktop app targets Apple Silicon macOS 12.3 or newer. Intel macOS remains
unsupported, and the configured deployment minimum is not evidence that every
macOS version in that range has been qualified.

Alpha.17's signing, notarization, stapling, updater-signature, anonymous public
download, Homebrew, and fixed-channel gates passed. Its human-observed update
journey remains pending.

## Install or upgrade

A new Mac can install the Desktop app and its required
CLI/daemon Formula with:

```sh
brew install --cask Pepewitch/tap/wisp-desktop
open -a Wisp
```

An installed signed Desktop release should use **Updates → Check now**, inspect
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

Linux installation after publication is:

```sh
curl --proto '=https' --tlsv1.2 -fsSL \
  https://raw.githubusercontent.com/Pepewitch/wisp/v0.4.0-alpha.17/scripts/install.sh |
  sh
```

## What changed

- Give every embedded shell a real controlling PTY sized to the visible pane,
  propagate resizes directly, and terminate the shell's process group cleanly.
  Reattaching now receives a bounded terminal-screen snapshot instead of
  replaying cursor-control history from an obsolete width.
- Discover pull requests across every Wisp branch a task created, prefer the
  newest provider result, and show when more pull requests exist without
  presenting an older branch's PR as current.
- End Droid questionnaire turns as **Needs input** when the harness asks the
  person a question, preserving a normal follow-up path instead of leaving the
  turn hanging until interruption.
- Split immutable GitHub asset publication from serialized, idempotent
  Homebrew/Desktop-channel promotion. A promotion failure can be retried for
  the same public tag without rebuilding, re-signing, notarizing, or replacing
  release assets.
- Defer Homebrew's circular Desktop livecheck comparisons until the new fixed
  channel is public, while retaining signing and Gatekeeper checks before
  promotion and restoring the full livecheck audit afterward.

## Known limits

- The alpha.17 updater path is not qualified until a published signed build is
  installed through the app and the relaunch, Apple trust, state-preservation,
  and Homebrew receipt-reconciliation evidence is recorded.
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

The release published exactly these ten immutable assets:

- `wisp-v0.4.0-alpha.17-linux-x86_64`
- `release-manifest.json`
- `SHA256SUMS`
- `wisp-v0.4.0-alpha.17-darwin-arm64.tar.gz`
- `release-manifest-darwin-arm64.json`
- `SHA256SUMS-darwin-arm64`
- `wisp-desktop-v0.4.0-alpha.17-darwin-arm64.tar.gz`
- `wisp-desktop-v0.4.0-alpha.17-darwin-arm64.tar.gz.sig`
- `release-manifest-desktop-darwin-arm64.json`
- `SHA256SUMS-desktop-darwin-arm64`

The clean-tree, public checksum, Developer ID, notarization, staple,
Gatekeeper, updater-signature, tamper-rejection, Formula/Cask audit, and
fixed-channel gates passed through the automated release and recovery
workflows. The human updater receipt remains pending.
