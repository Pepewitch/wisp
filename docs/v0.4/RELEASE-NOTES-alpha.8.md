# Wisp 0.4.0-alpha.8

This is an **experimental feature prerelease**, not a production-ready
release. It introduces the first Wisp Desktop alpha for Apple Silicon and
keeps the existing daemon, CLI, and browser UI independently usable.

The desktop app is configured for Apple Silicon macOS 12.3 or newer. That
deployment minimum is enforced in both the application metadata and Mach-O
loader command; it is not a claim that macOS 12.3 has been qualified. Local
release qualification was performed on Apple Silicon macOS 26.6.2, and the
tag workflow rebuilds the app on the repository's pinned Apple Silicon macOS
runner. Intel macOS remains unsupported.

The app is ad-hoc signed and **not Developer ID signed or notarized**. macOS
may require Finder's Open command or approval in Privacy & Security on first
launch. Do not disable Gatekeeper globally.

## Install

The desktop Cask installs the Wisp CLI/daemon Formula as a required dependency
when it is not already present:

```sh
brew install --cask Pepewitch/tap/wisp-desktop
open -a Wisp
```

Wisp Desktop does not silently initialize or start the local daemon. Its Local
setup flow explains the required change and asks before running it. The CLI
equivalent is:

```sh
wisp init
brew services start wisp
```

To install only the daemon, CLI, and browser UI:

```sh
brew install Pepewitch/tap/wisp
```

Existing Homebrew users should upgrade the daemon before installing or
upgrading the desktop app:

```sh
brew update
brew upgrade Pepewitch/tap/wisp
brew upgrade --cask Pepewitch/tap/wisp-desktop
```

Use `brew install --cask Pepewitch/tap/wisp-desktop` instead of the final
command when the Cask is not installed yet.

Linux installation remains:

```sh
curl --proto '=https' --tlsv1.2 -fsSL \
  https://raw.githubusercontent.com/Pepewitch/wisp/v0.4.0-alpha.8/scripts/install.sh |
  sh
```

## What changed

- Added one shared React UI for the browser and Tauri desktop runtimes; the
  browser remains a single-daemon, same-origin client.
- Added a Local-first desktop connection tab strip, remote connection tabs,
  mobile connection switcher, inactive task-attention indicators, overflow,
  and connection-scoped task, navigation, query, stream, terminal, attachment,
  update, preference, and draft state.
- Added rename for Local and remote tabs, authenticated add/edit/reconnect
  previews, daemon identity pinning, and offline-capable Remove connection.
  Removing a remote revokes its desktop route and deletes its saved Keychain
  credential; it never stops the daemon or deletes daemon projects or tasks.
- Added the native macOS folder picker for projects on Local. Remote projects
  accept a path on the remote daemon's machine, and picker completion is bound
  to the connection that opened it.
- Added a loopback-only native proxy for REST, SSE, WebSocket terminals, and
  media. Remote tokens stay in Keychain and never return to the webview;
  routes are immutable per connection generation and are revoked on removal
  or target change.
- Added the Homebrew `wisp-desktop` Cask, deterministic `.app` archive,
  manifest/checksums, exact bundle inventory, loader/version/signature checks,
  and two-clean-build reproducibility gate.

## Known limits

- This is an Apple Silicon-only alpha with ad-hoc signing and no notarization.
- The configured macOS 12.3 deployment target has not been tested across the
  full macOS 12.3-to-current range.
- Desktop updates use Homebrew; there is no in-app Cask updater yet.
- Closing Wisp Desktop does not stop daemons or agents. The app is an interface,
  not the owner of daemon task data.
- Uninstalling the Cask quits and removes `Wisp.app` but preserves desktop
  metadata and remote Keychain credentials. Remove remotes or use **Reset
  Desktop Data** before uninstalling if those credentials should be deleted.
- Because the alpha is only ad-hoc signed, a future Cask upgrade may require a
  remote token to be entered again if Keychain refuses the new build.
- A remote URL and token identify and authenticate a daemon; they do not create
  network reachability. The daemon must already be reachable through a trusted
  HTTPS route or an exact-loopback user-managed tunnel, and remote project
  paths must exist on that daemon's host.

## Release assets

The tag workflow must publish exactly these nine immutable assets:

- `wisp-v0.4.0-alpha.8-linux-x86_64`
- `release-manifest.json`
- `SHA256SUMS`
- `wisp-v0.4.0-alpha.8-darwin-arm64.tar.gz`
- `release-manifest-darwin-arm64.json`
- `SHA256SUMS-darwin-arm64`
- `wisp-desktop-v0.4.0-alpha.8-darwin-arm64.tar.gz`
- `release-manifest-desktop-darwin-arm64.json`
- `SHA256SUMS-desktop-darwin-arm64`

All nine assets were published from clean commit
`f456a543aeab3cdbd5ae39ab406e2a3fa7614a08`. The release and Homebrew install
path completed their public-byte and machine checks; the ad-hoc-signing limits
above remain part of this historical release. Alpha.12 later replaced this
bootstrap path with Developer ID signing, notarization, and a signed updater.
