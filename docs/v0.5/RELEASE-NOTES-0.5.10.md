# Wisp 0.5.10

Wisp 0.5.10 is a regular pre-1.0 release of both the daemon and Desktop
app. It shows live session context in the task header, preserves discovered
model catalogs across daemon restarts, and reports pull requests waiting in
GitHub's merge queue.

## What changed since 0.5.9

- **Supported harnesses show their live session context in the task header.**
  Claude, Codex, and OpenCode tasks report the conversation tokens carried by
  the model as of its last call without running an extra probe. The reading
  persists with each session context. (#227)
- **Discovered model catalogs survive daemon restarts.** The daemon loads the
  last successful model discovery immediately, refreshes it in the background,
  and keeps the usable list when a later probe fails. (#229)
- **Pull requests in GitHub's merge queue are identified correctly.** Task
  headers, rows, and detail cards now say `Queued to merge` instead of showing
  an approved queued pull request as merely open. (#228)
- **Context probes no longer reuse an answer after the session changes.**
  A turn, compaction, session replacement, or agent switch retires the old
  reading while unchanged duplicate requests still share their result. (#225)
- **Long Codex sessions resume without replaying historical turns to Wisp.**
  Codex still restores the full provider thread, but omits its old turns from
  the JSON-RPC response used to start the next turn or compaction. (#230)
- **Fresh Homebrew installs name both trusted packages.** The install command
  passes the Formula and Cask explicitly, avoiding Homebrew's refusal to load
  a Formula dependency that was not named from the non-official tap. (#224)
- Internal release hygiene: Desktop CI serializes Tauri's multi-target asset
  generation so concurrent builds cannot embed a partial compressed frontend,
  and the 0.5.9 qualification record is current. (#223, #226)

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
channel URL remains compatible and advertises the regular 0.5.10 version.
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
  https://raw.githubusercontent.com/Pepewitch/wisp/v0.5.10/scripts/install.sh | sh
```

Back up task state **and the original Git repositories** before upgrading.
Follow [backup and restore](https://github.com/Pepewitch/wisp/blob/v0.5.10/docs/INSTALL.md#back-up-and-restore-a-wisp-home); copying `.wisp`
alone does not preserve linked worktrees or unpublished Git objects.
This release adds database migration 12, so a 0.5.9 daemon cannot reopen a profile that 0.5.10 has opened.

## Scope and known limits

This release is for a trusted single OS user. Worktrees separate checkouts;
they do not sandbox agents or their credentials. There is no multi-user
permission boundary. Closing Desktop leaves daemons and agents running.
Intel macOS and non-Apple-Silicon Desktop builds are unsupported.

Desktop publication requires Developer ID signing, notarization, a stapled
ticket, and a verified updater signature. The macOS daemon remains ad-hoc
signed. Automated release gates verify immutable downloads and promote the
Formula, Cask, daemon channel, and Desktop channel together. At source
preparation, the 0.5.10 artifact gates are pending; the [qualification ledger](https://github.com/Pepewitch/wisp/blob/main/docs/v0.5/QUALIFICATION.md)
records the final outcome separately from these immutable release notes.

Automatic context readings are unavailable for Droid and Cursor because their
terminal usage totals combine many model calls; those harnesses still support
the explicit `/context` probe. Merge-queue status depends on GitHub's reported
queue entry. Persisted model catalogs remain last-known-good snapshots until a
background refresh succeeds.
Native dependency advisories still include upstream maintenance notices and a
locked Linux-only glib warning. Full clean-machine provider journeys, a
human-observed Desktop upgrade across this version, broad OS coverage, and
cross-machine restore remain incomplete. Task export excludes repositories and
provider sessions; it is not a complete backup or an import format. Permanent
deletion is logical, not forensic erasure. This release is not a security
certification.

## Release assets

The release contains these ten immutable assets:

- `wisp-v0.5.10-linux-x86_64`
- `release-manifest.json`
- `SHA256SUMS`
- `wisp-v0.5.10-darwin-arm64.tar.gz`
- `release-manifest-darwin-arm64.json`
- `SHA256SUMS-darwin-arm64`
- `wisp-desktop-v0.5.10-darwin-arm64.tar.gz`
- `wisp-desktop-v0.5.10-darwin-arm64.tar.gz.sig`
- `release-manifest-desktop-darwin-arm64.json`
- `SHA256SUMS-desktop-darwin-arm64`
