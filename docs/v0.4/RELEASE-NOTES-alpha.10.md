# Wisp 0.4.0-alpha.10

This is an **experimental feature prerelease**, not a production-ready
release. It is the first Wisp Desktop build prepared for Developer ID signing,
Apple notarization, and cryptographically signed in-app updates.

The desktop app targets Apple Silicon macOS 12.3 or newer. Intel macOS remains
unsupported, and the configured deployment minimum is not evidence that every
macOS version in that range has been qualified.

Alpha.9 failed its Desktop reproducibility gate before signing or publication;
no alpha.9 GitHub release or Homebrew update was created. Alpha.10 retains that
fail-closed posture and clean-rebuilds the Desktop payload at one stable Cargo
target path so Apple's required Mach-O UUID remains reproducible.

At release preparation time, Developer ID signing, notarization, stapling,
public-download verification, and installed-app qualification are pending. The
tag workflow fails closed before publication unless every signing and trust
gate passes. The release remains an alpha even after those gates succeed.

## Install or upgrade

The Desktop Cask installs the Wisp CLI/daemon Formula as a required dependency
when it is not already present:

```sh
brew install --cask Pepewitch/tap/wisp-desktop
open -a Wisp
```

The public alpha.8 app predates the Desktop updater. Existing users must
bootstrap alpha.10 through Homebrew, including `--greedy` because the new Cask
declares that the application can update itself:

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
  https://raw.githubusercontent.com/Pepewitch/wisp/v0.4.0-alpha.10/scripts/install.sh |
  sh
```

## What changed

- Added a native Desktop updater with a fixed release channel, signed archive
  verification, bounded discovery, explicit download progress, install
  preflight, and relaunch only after successful replacement.
- Replaced the ambiguous update action with an **Updates** popover containing
  separate **Wisp Desktop** and selected-daemon rows. Desktop and daemon
  updates are mutually exclusive, remain bound to their original scope, and
  refuse unknown daemon protocol versions.
- Hardened the tag workflow so the Desktop archive cannot publish without a
  Developer ID signature, hardened runtime, trusted timestamp, notarization,
  stapled ticket, independent updater-signature verification, anonymous
  public-byte verification, and strict Homebrew audits.
- Made the Desktop clean-rebuild proof use one stable Cargo target path while
  still deleting every cached artifact between passes. This keeps Apple's
  required Mach-O UUID deterministic instead of weakening the launch contract.
- Added macOS task notifications for tasks that finish, need input, fail, or
  become stuck. Activating a notification focuses the relevant connection and
  task.
- Added a shared browser/Desktop viewer for safe worktree-file links in agent
  prose, plus Local-only Finder reveal for files that cannot be rendered.
- Added per-message relative timestamps with an exact UTC reading on click.
- Fixed packaged Desktop terminal styling and external links, and made a
  displaced terminal client report that another client took the shell.
- Clarified project removal, made pull-request discovery prefer the latest
  open pull request, and reduced the task overflow menu to Rename and Archive;
  `/fresh` remains available from the composer.

## Known limits

- Alpha.10 is the updater bootstrap release. Alpha.8 cannot discover it, and a
  single alpha.10 installation does not prove self-update. The first complete
  updater qualification requires leaving alpha.10 installed, publishing a
  second signed version, and updating to it through **Updates**.
- Apple Silicon support has limited single-machine qualification; Intel Macs
  are unsupported.
- Closing Wisp Desktop does not stop daemons or agents. The app is an
  interface, not the owner of daemon task data.
- Uninstalling the Cask quits and removes `Wisp.app` but preserves Desktop
  metadata and remote Keychain credentials. Remove remotes or use **Reset
  Desktop Data** first if those credentials should be deleted.
- A remote URL and token identify and authenticate a daemon; they do not create
  network reachability. The daemon must already be reachable through trusted
  HTTPS or an exact-loopback user-managed tunnel.

## Release assets

The tag workflow must publish exactly these ten immutable assets:

- `wisp-v0.4.0-alpha.10-linux-x86_64`
- `release-manifest.json`
- `SHA256SUMS`
- `wisp-v0.4.0-alpha.10-darwin-arm64.tar.gz`
- `release-manifest-darwin-arm64.json`
- `SHA256SUMS-darwin-arm64`
- `wisp-desktop-v0.4.0-alpha.10-darwin-arm64.tar.gz`
- `wisp-desktop-v0.4.0-alpha.10-darwin-arm64.tar.gz.sig`
- `release-manifest-desktop-darwin-arm64.json`
- `SHA256SUMS-desktop-darwin-arm64`

Publication, anonymous-download verification, Homebrew online audits, and
installed upgrade qualification remain pending until the tag workflow and
post-release checks complete.
