# Wisp Desktop updates

Wisp Desktop and a Wisp daemon are separate programs with separate release
lifecycles. The Desktop **Updates** popover — the download icon at the right
end of the top bar, grouped with zoom and the settings gear, and on touch in
the drawer footer — therefore has two named rows:

- **Wisp Desktop** is global to the application and installs a signed `.app`
  update through the native Tauri updater;
- **<connection> daemon** belongs to the selected connection and asks that
  daemon to update itself through its existing install method.

There is no unqualified **Update** action. Desktop and daemon update operations
are mutually exclusive: a Desktop relaunch cannot interrupt a daemon update,
and a daemon update cannot start while Desktop is checking, installing, or
waiting to relaunch. Changing connection tabs cannot retarget an operation or
paint its progress onto a different daemon.

## Discovery and installation

```text
launch (one jittered check) or Check now
                  |
                  v
native fixed alpha-channel URL -----> signed release metadata in homebrew-tap
                  |                    version, notes, exact asset URL,
                  |                    size, publication time, signature
                  v
Tauri updater fetches the same document again
                  |
       exact-document and allowlist checks
                  |
       Minisign verification while downloading
                  |
                  v
replace /Applications/Wisp.app -> relaunch only after successful install
```

The alpha endpoint and updater public key are compiled into the native app.
The webview may request a check, confirm the exact displayed version, and ask
for relaunch. It cannot supply an endpoint, URL, signature, key, download path,
or installation path. It receives only status and bounded release notes.

The native layer rejects unknown channel fields, unexpected platforms, build
metadata, future publication times, redirects outside the fixed GitHub
allowlist, oversized channel documents, notes, signatures, and declared
artifacts, non-newer versions, and any change between its bounded discovery
request and Tauri's signed request. A confirmation is stale as soon as the
pending candidate changes.

Checks are opt-out and occur once, two to six seconds after launch. There is no
periodic background polling. **Check now** is available except while an update
operation is active or an installed update is waiting for relaunch. Download
and installation begin only after the person clicks **Update Desktop and
relaunch**.

## Signing and release channel

Homebrew is the bootstrap and recovery installer. Tauri owns normal in-app
Desktop upgrades after the first self-update-capable release:

- GitHub Actions imports a Developer ID Application certificate, signs with a
  trusted timestamp and hardened runtime, notarizes, and staples `Wisp.app`;
- the release script archives that exact app once, signs the archive with the
  dedicated Tauri updater key, independently verifies the signature, then
  re-extracts the archive and repeats Apple trust checks;
- GitHub publishes the archive, updater signature, manifests, checksum sets,
  daemon artifacts, and release notes as immutable assets;
- a separate serialized promotion job downloads and verifies those immutable
  public assets again, renders the Homebrew Formula, Cask, and alpha update
  channel from their manifests, and commits those three files together;
- the channel is advanced only after anonymous downloads and Apple trust checks
  pass for the public bytes, then the job waits for the fixed channel URL and
  requires the full Homebrew livecheck audit.

Separating immutable publication from mutable channel promotion makes the
second stage resumable. A failed promotion can be rerun for the existing tag,
including through the release workflow's manual tag input, without rebuilding,
re-signing, notarizing, or replacing a public asset. Promotion is idempotent:
an already-current tap is verified without another commit. The command runs
Homebrew audits only on a disposable Mac and refuses a host with an installed
Wisp Formula/Cask or an already-registered audit tap.

The Cask and updater reference the same `.tar.gz`, so there is no parallel app
artifact whose behavior can drift. The Cask declares `auto_updates true` and
uses the same channel for livecheck. Use `brew upgrade --cask --greedy
Pepewitch/tap/wisp-desktop` when explicitly repairing or bootstrapping an
auto-updating installation.

The Tauri updater replaces `Wisp.app`; it does not rewrite Homebrew's Caskroom
receipt. After a successful in-app update, Homebrew can temporarily describe
the prior receipt as installed even though the application bundle is newer.
`brew upgrade --cask --greedy Pepewitch/tap/wisp-desktop` reconciles that
bookkeeping from the same immutable archive and must never downgrade the app.

The committed updater public key is not secret. Its encrypted private key and
password are repository secrets. Apple release credentials are also repository
secrets. A signed tag build stops before creating the release when any
credential is missing, when the public key is a placeholder, or when signing,
notarization, stapling, signature verification, reproducibility, or the offline
Homebrew audit fails. Once immutable assets exist, any anonymous-download,
Apple trust, online Homebrew, tap, or channel failure stops promotion without
mutating those assets. Never paste private keys or certificates into an issue,
PR, task prompt, test fixture, command argument captured in logs, or committed
file.

The public alpha.8 app predates this updater and is ad-hoc signed. It cannot
self-update. Alpha.12 is the first published Developer ID signed release
containing the embedded key and must be installed once through Homebrew with
`--greedy`. Alpha.13 completed the first end-to-end public proof by discovering,
verifying, installing, and relaunching from alpha.12. Alpha.16 is the current
published signed release; its alpha.13-to-alpha.16 human updater receipt is
still pending.

Treat the updater key as a long-lived release root. Before any app containing a
new public key is published, rotate the key freely and repeat qualification. An
intentional later rotation needs an intermediate release signed by the old key
that embeds the new public key; only the release after that may use the new
private key. If the active private key is lost or compromised before such a
bridge ships, disable the channel and recover through a Homebrew reinstall.
Never silently replace the public key and strand installed clients.

## Daemon protocol compatibility

The Desktop binary declares the set of daemon API protocols it genuinely
implements. An in-app daemon update is offered only when both the running and
candidate daemon protocols are in that set. Updating Desktop first is the safe
path when a newer daemon needs a newer protocol. Adding a protocol number to
the set without implementing and testing both versions is not compatibility.

## Recovery

An update failure leaves the currently installed app in place and keeps a
retryable error in the Desktop row. If self-update cannot write the application
location, or an installed app is damaged, quit Wisp and run:

```sh
brew update
brew reinstall --cask Pepewitch/tap/wisp-desktop
```

Use `--greedy` with `brew upgrade --cask` when moving to a newer version. The
daemon, task history, repositories, worktrees, connection metadata, and remote
Keychain credentials are not owned by the application bundle and survive this
repair.

## Qualification: prove an updater release works

A successful build is necessary but not sufficient. Qualify with two distinct
signed versions on an Apple Silicon Mac:

1. Install the older self-update-capable version through Homebrew with
   `brew upgrade --cask --greedy Pepewitch/tap/wisp-desktop` and launch it.
2. Verify the installed app with `codesign --verify --deep --strict`, `xcrun
   stapler validate`, and `spctl --assess --type execute`.
3. Publish the next version through the tag workflow. Do not replace either
   version's tag or assets.
4. In the older app, open **Updates** — the download icon at the right end of
   the top bar — and click **Check now**. Confirm the Desktop row shows the old
   and new versions and the expected release notes; the selected-daemon row must
   remain separate.
5. Click **Update Desktop and relaunch**. Confirm download progress, a clean
   relaunch, the new version on the Desktop row, and the same connections and
   tasks.
6. Repeat the three Apple trust checks against the newly installed app. Confirm
   a bad-signature test is rejected and leaves the old app runnable.
7. Run `brew update` and inspect `brew info --cask wisp-desktop`. If its
   Caskroom receipt still names the older version, synchronize it with
   `brew upgrade --cask --greedy Pepewitch/tap/wisp-desktop`; Homebrew must then
   agree with the installed version and must not downgrade the app.

The alpha.12-to-alpha.13 journey passed on one Apple Silicon Mac, including a
tampered-archive rejection that left alpha.12 runnable, public-channel
discovery, signed replacement, relaunch, Apple trust checks, preserved daemon
state, and Homebrew receipt reconciliation. This qualifies the public updater
path on that machine; it is not broad macOS or hardware qualification. Repeat
the two-version receipt for future trust-root, channel, installer, or updater
changes rather than treating this historical pass as permanent coverage.
Alpha.16's publication, public channel, and package audits have passed, but do
not describe alpha.13-to-alpha.16 as qualified until that human-observed
replacement, relaunch, state-preservation, Apple trust, and Homebrew receipt
reconciliation record exists. Record the sanitized result in the
[v0.4 qualification ledger](v0.4/QUALIFICATION.md); keep raw machine evidence
private.
