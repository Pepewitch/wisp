# Wisp 0.5.8

Wisp 0.5.8 is a regular pre-1.0 release of both the daemon and Desktop app.
It hardens the network, credential, workflow, upload, and supply-chain
boundaries found by the latest review, while adding scheduled steering,
automatic task names from pull requests, streamed subagent activity, and
bounded loading for large conversations and attachments.

## What changed since 0.5.7

- **The reviewed trust boundaries now fail closed.** The daemon accepts only
  the literal loopback bind, browser token fields are masked and destroyed
  when their dialog closes, and PR feedback can wake a workflow only when its
  author is explicitly trusted. Update request bodies and every consumed task
  log frame are validated before use. (#197, #202, #205, #206, #207)
- **A leaked daemon token can be rotated safely.** `wisp token --rotate`
  replaces the mode-`0600` credential while the daemon is stopped, preserving
  the rest of the profile and explaining the required restart and
  reauthentication. (#189)
- **Attachments stream instead of expanding into base64 copies.** Browser,
  Desktop, and CLI uploads use authenticated one-shot staging with private
  storage, quotas, expiry, full-stream validation, and cleanup on failure.
  Existing base64 clients remain compatible. (#201)
- **Long conversations load in bounded pages.** Older history is fetched from
  an indexed SQLite cursor as needed without disturbing live messages, search,
  or scroll position. Task-wide token totals remain exact while per-turn
  detail stays bounded. Older protocol clients keep their unpaginated path.
  (#209)
- **Task names can follow their pull requests.** PR discovery updates the task
  title using the same PR the UI links to. The default-on setting can be
  disabled, and a manual task name always wins permanently. (#196)
- **Workflows can steer once at a chosen time and recover settled work.**
  Schedule Steer accepts relative delays or explicit wall times, while
  heartbeat workflows may start a new turn for failed or input-blocked tasks
  without interrupting live work. Workflows are also a first-class mobile
  task tab. (#191, #200, #204)
- **Subagent work appears in the parent activity stream.** Droid child
  sessions are discovered from Factory's live invocation registry and their
  bounded, nested activity is projected into the task log without losing
  human markers. (#192)
- **Harness and daemon failures stay bounded and terminate cleanly.** Probe,
  model, skill, and update subprocesses cap output, enforce deadlines, and
  clean up descendants. RPC probe channels additionally cap frames, honor
  cancellation, and fail fast after EOF. Per-task probe and skill caches now
  expire, have a hard ceiling, and cannot return after task deletion.
  (#199, #203)
- **Large source previews and scrolling behave predictably.** Complete static
  previews can receive syntax highlighting up to 50,000 characters, file
  viewers own their scrolling, and vertical wheel gestures over wide tables
  continue to move the conversation. (#193, #194, #195)
- Internal release and supply-chain hygiene: Cargo audit tooling is exactly
  pinned; all evaluator Python packages are version-and-hash locked; Desktop
  registry and proxy trust boundaries are split into focused modules without
  changing their public API or operation order; cross-platform release
  diagnostics and the 0.5.7 qualification record are current. (#190, #198,
  #208, #210)

## Install or upgrade

Apple Silicon macOS (12.3 configured minimum):

```sh
brew install --cask Pepewitch/tap/wisp-desktop
open -a Wisp
```

The Cask installs the separate daemon Formula as a dependency. Existing
updater-capable Desktop builds can use **Updates → Check now**, then **Update
Desktop and relaunch**. Update **Local daemon** separately. The legacy alpha
channel URL remains compatible and advertises the regular 0.5.8 version.
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
  https://raw.githubusercontent.com/Pepewitch/wisp/v0.5.8/scripts/install.sh | sh
```

Back up task state **and the original Git repositories** before upgrading.
Follow [backup and restore](https://github.com/Pepewitch/wisp/blob/v0.5.8/docs/INSTALL.md#back-up-and-restore-a-wisp-home); copying `.wisp`
alone does not preserve linked worktrees or unpublished Git objects.
This release adds database migration 10 and 11, so a 0.5.7 daemon cannot reopen a profile that 0.5.8 has opened.

## Scope and known limits

This release is for a trusted single OS user. Worktrees separate checkouts;
they do not sandbox agents or their credentials. There is no multi-user
permission boundary. Closing Desktop leaves daemons and agents running.
Intel macOS and non-Apple-Silicon Desktop builds are unsupported.

Desktop publication requires Developer ID signing, notarization, a stapled
ticket, and a verified updater signature. The macOS daemon remains ad-hoc
signed. Automated release gates verify immutable downloads and promote the
Formula, Cask, daemon channel, and Desktop channel together. At source
preparation, the 0.5.8 artifact gates are pending; the [qualification ledger](https://github.com/Pepewitch/wisp/blob/main/docs/v0.5/QUALIFICATION.md)
records the final outcome separately from these immutable release notes.

Automatic PR naming depends on successful PR discovery and stays disabled for
manually named tasks. Scheduled steering uses the daemon's wall clock and
timezone interpretation; it is not an external calendar service. Staged
attachments are intentionally temporary and quota-bound, and conversation
pagination does not remove the standing retention limits.
Native dependency advisories still include upstream maintenance notices and a
locked Linux-only glib warning. Full clean-machine provider journeys, a
human-observed Desktop upgrade across this version, broad OS coverage, and
cross-machine restore remain incomplete. Task export excludes repositories and
provider sessions; it is not a complete backup or an import format. Permanent
deletion is logical, not forensic erasure. This release is not a security
certification.

## Release assets

The release contains these ten immutable assets:

- `wisp-v0.5.8-linux-x86_64`
- `release-manifest.json`
- `SHA256SUMS`
- `wisp-v0.5.8-darwin-arm64.tar.gz`
- `release-manifest-darwin-arm64.json`
- `SHA256SUMS-darwin-arm64`
- `wisp-desktop-v0.5.8-darwin-arm64.tar.gz`
- `wisp-desktop-v0.5.8-darwin-arm64.tar.gz.sig`
- `release-manifest-desktop-darwin-arm64.json`
- `SHA256SUMS-desktop-darwin-arm64`
