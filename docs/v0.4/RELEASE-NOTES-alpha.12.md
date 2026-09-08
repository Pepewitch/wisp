# Wisp 0.4.0-alpha.12

This is an **experimental feature prerelease**, not a production-ready
release. It is the first Wisp Desktop prerelease to ship with Developer ID
signing, Apple notarization, and cryptographically signed in-app updates.

The desktop app targets Apple Silicon macOS 12.3 or newer. Intel macOS remains
unsupported, and the configured deployment minimum is not evidence that every
macOS version in that range has been qualified.

Alpha.9 and alpha.10 failed closed during Desktop release preparation. Alpha.11
reached Apple notarization, but its CI runner lost network connectivity while
polling and no GitHub release or Homebrew update was published. Alpha.12 keeps
the same trust gates and deliberately replaces the unshipped updater trust
root before any released client can depend on it.

Alpha.12 passed Developer ID signing, notarization, stapling, public-download
verification, Homebrew installation, and installed-app qualification before
closeout. It remains an alpha after those gates.

## Install or upgrade

The Desktop Cask installs the Wisp CLI/daemon Formula as a required dependency
when it is not already present:

```sh
brew install --cask Pepewitch/tap/wisp-desktop
open -a Wisp
```

The public alpha.8 app predates the Desktop updater. Existing users must
bootstrap alpha.12 through Homebrew, including `--greedy` because the new Cask
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
  https://raw.githubusercontent.com/Pepewitch/wisp/v0.4.0-alpha.12/scripts/install.sh |
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
- Hardened the release process so the Desktop archive cannot publish without a
  Developer ID signature, hardened runtime, trusted timestamp, notarization,
  stapled ticket, independent updater-signature verification, anonymous
  public-byte verification, and strict Homebrew audits.
- Established a replacement updater keypair before the first updater-capable
  release. The committed public key identifies the release trust root; the
  encrypted private key remains outside the repository and release artifacts.
- Made `web/ui-dist` a derived, ignored build output. Pull requests validate a
  fresh UI build without committing generated bundle churn, while release
  artifacts still embed that exact shared browser/Desktop UI.
- Added Desktop zoom controls and copy actions for user messages.
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

- Alpha.12 is the updater bootstrap release. Alpha.8 cannot discover it, and a
  single alpha.12 installation did not prove self-update. Alpha.13 later
  completed that two-version qualification through **Updates** on one Apple
  Silicon Mac.
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

The release must publish exactly these ten immutable assets:

- `wisp-v0.4.0-alpha.12-linux-x86_64`
- `release-manifest.json`
- `SHA256SUMS`
- `wisp-v0.4.0-alpha.12-darwin-arm64.tar.gz`
- `release-manifest-darwin-arm64.json`
- `SHA256SUMS-darwin-arm64`
- `wisp-desktop-v0.4.0-alpha.12-darwin-arm64.tar.gz`
- `wisp-desktop-v0.4.0-alpha.12-darwin-arm64.tar.gz.sig`
- `release-manifest-desktop-darwin-arm64.json`
- `SHA256SUMS-desktop-darwin-arm64`

All ten assets were published from clean commit
`b486dea2fdcf6c57306ef1aef6af7f9b541fa1ac`. Anonymous downloads, checksum and
updater-signature verification, Developer ID, notarization, staple, Gatekeeper,
strict Homebrew audit, installed upgrade, and state-preservation checks passed.
Homebrew tap commit `f838aef032147618a5b372107fc21a97b82ff7e5`
advanced the Formula, Cask, and Desktop channel together.
