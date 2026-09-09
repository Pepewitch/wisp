# Wisp 0.5.0

Wisp 0.5.0 promotes the 0.4 alpha series into a regular pre-1.0 release of both
the daemon and Desktop app. Desktop is now a usable interface for daily local
and remote task work. A substantial engineering and security review produced
concrete reliability, privacy, and recovery improvements across both products.

## What changed since 0.4

- Desktop brings saved local/remote connections, native credential storage,
  a real sized PTY terminal, file and diff viewing, notifications, zoom, and
  separate signed Desktop and Local daemon updates into one interface.
- Stop waits for tracked descendant and background process groups, including
  groups from older turns and daemon restarts. Normal steering continues
  without interrupting the agent. Blue means background work remains; green
  means no tracked work remains, and amber identifies stopping or uncertainty.
- Short-lived commands bound descendant cleanup and inherited output pipes.
  Startup owns the profile before touching its database; migration and lock
  failures explain recovery without silently discarding task data.
- Archive cleanup checkpoints each step, retries safe failures, and pauses
  uncertain cleanup scripts for an explicit decision. Archives retain new
  attachments. Export retained task data as JSON, or permanently delete an
  archived task with confirmation. Older deleted attachments cannot be restored.
- Markdown images require per-URL consent before contacting another server.
  Authenticated media caches are revoked when credentials or task data change.
  Browser checks exercise actual terminal output and media decoding.
- Simultaneous harness work has a configurable admission cap, defaulting to
  100. There is no cap on the number of turns a task can accumulate; normal
  steering reuses its current workload slot.
- The review also tightened ownership, durable delivery and shutdown behavior,
  added recovery coverage, clarified complete backups, and removed 247
  dependencies by vendoring an unchanged licensed stylesheet.

## Install or upgrade

Apple Silicon macOS (12.3 configured minimum):

```sh
brew install --cask Pepewitch/tap/wisp-desktop
open -a Wisp
```

The Cask installs the separate daemon Formula as a dependency. Existing
updater-capable Desktop builds can use **Updates → Check now**, then **Update
Desktop and relaunch**. Update **Local daemon** separately. The legacy alpha
channel URL remains compatible and advertises the regular 0.5.0 version.
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
  https://raw.githubusercontent.com/Pepewitch/wisp/v0.5.0/scripts/install.sh | sh
```

Back up task state **and the original Git repositories** before upgrading.
Follow [backup and restore](https://github.com/Pepewitch/wisp/blob/v0.5.0/docs/INSTALL.md#back-up-and-restore-a-wisp-home); copying `.wisp`
alone does not preserve linked worktrees or unpublished Git objects.
A newer database schema may prevent an older daemon from reopening the profile.

## Scope and known limits

This release is for a trusted single OS user. Worktrees separate checkouts;
they do not sandbox agents or their credentials. There is no multi-user
permission boundary. Closing Desktop leaves daemons and agents running.
Intel macOS and non-Apple-Silicon Desktop builds are unsupported.

Desktop publication requires Developer ID signing, notarization, a stapled
ticket, and a verified updater signature. The macOS daemon remains ad-hoc
signed. Automated release gates verify immutable downloads and promote the
Formula, Cask, and Desktop channel together. At source preparation, the 0.5.0
artifact gates are pending; the [qualification ledger](https://github.com/Pepewitch/wisp/blob/main/docs/v0.5/QUALIFICATION.md)
records the final outcome separately from these immutable release notes.

The review is not a security certification. Native dependency advisories still
include upstream maintenance notices and a locked Linux-only glib warning.
Full clean-machine provider journeys, the 0.4-to-0.5 human-observed Desktop
upgrade, broad OS coverage, and cross-machine restore remain incomplete.
Task export excludes repositories and provider sessions; it is not a complete
backup or an import format. Permanent deletion is logical, not forensic erasure.

## Release assets

The release contains these ten immutable assets:

- `wisp-v0.5.0-linux-x86_64`
- `release-manifest.json`
- `SHA256SUMS`
- `wisp-v0.5.0-darwin-arm64.tar.gz`
- `release-manifest-darwin-arm64.json`
- `SHA256SUMS-darwin-arm64`
- `wisp-desktop-v0.5.0-darwin-arm64.tar.gz`
- `wisp-desktop-v0.5.0-darwin-arm64.tar.gz.sig`
- `release-manifest-desktop-darwin-arm64.json`
- `SHA256SUMS-desktop-darwin-arm64`
