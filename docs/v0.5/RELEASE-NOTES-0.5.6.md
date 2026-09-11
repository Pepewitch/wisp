# Wisp 0.5.6

Wisp 0.5.6 is a regular pre-1.0 release of both the daemon and Desktop app. It
adds configurable task automations that can wake a task on a schedule or watch
a pull request, teaches the harness palette to discover Droid custom commands,
and makes files easier to get in: drag and drop onto the composer, and
double-click a changed file to read it.

## What changed since 0.5.5

- **Tasks can run automations.** A task can attach durable, parameterized
  automations with a daemon scheduler, SQLite recovery, wake-up budgets,
  expiry, pause/resume, and bounded history. The first three are Heartbeat
  (wake the agent on an interval), PR CI watch, and PR review watch. CI and
  review checks poll without consuming agent turns while nothing changed;
  review watching covers comment-only reviews, inline replies, conversation
  comments, and edits, with author filters and a configurable quiet window.
  Automation wakes the task between turns through the existing runner, never
  outranks a user message, pauses when delivery is uncertain, and records
  bounded history. (#168)
- **The slash palette discovers Droid custom commands.** Commands defined in a
  Droid workspace are listed with argument hints, script warnings, and
  review-only prefills; skills remain available when a session cannot support
  command discovery. (#167)
- **Files can be dragged onto the composer.** Dropping files onto the create
  task dialog's prompt field or the steer box attaches them through the same
  path as the paperclip, with a highlight while a file drag is over the
  surface. Dragged links and text selections are untouched. (#172)
- **Mermaid fences render as diagrams on demand.** A ` ```mermaid ` fence keeps
  its code surface and gains a toggle: wheel to zoom, drag to pan, buttons to
  zoom in, out, and reset. A diagram that fails to parse shows the parser's
  message with a Retry button instead of taking the turn down. The library
  loads on demand. (#170)
- **Double-click a changed file to read it.** A click in the Changes pane still
  reads the diff; a double-click opens the file itself in the worktree file
  viewer, which now shows syntax highlighting for recognized source files.
  An archived task without a worktree has no opener. (#169)
- **The empty state is the first-run onboarding.** A fresh install surfaces the
  buttons a new user actually needs — diagnose the local daemon, open the
  per-project task creator — instead of dead ends with hover-only hints. (#164)
- **Interrupted turns explain themselves.** The settled state detail says what
  happened and what to do next in plain language, including whether the
  harness ignored the stop signal, and errors the harness reported during the
  interrupt are kept in the state detail instead of being dropped. (#171)
- **macOS can tell Wisp's processes apart.** The wisp binaries carry labels, so
  System Settings ▸ Privacy & Security ▸ App Management no longer fills with
  identical unlabelled `wisp` rows. (#163)
- **Pull-request discovery follows checked-out branches.** A task whose
  worktree has an arbitrary branch checked out — not just a task-prefixed one —
  still finds its pull requests. (#161)
- **The README and installation guides are simplified.** (#165)
- Internal hygiene: stabilized the attachment-budget test coverage, kept agent
  plans out of pull requests, and recorded the 0.5.5 publication. (#162, #166,
  #160)

## Install or upgrade

Apple Silicon macOS (12.3 configured minimum):

```sh
brew install --cask Pepewitch/tap/wisp-desktop
open -a Wisp
```

The Cask installs the separate daemon Formula as a dependency. Existing
updater-capable Desktop builds can use **Updates → Check now**, then **Update
Desktop and relaunch**. Update **Local daemon** separately. The legacy alpha
channel URL remains compatible and advertises the regular 0.5.6 version.
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
  https://raw.githubusercontent.com/Pepewitch/wisp/v0.5.6/scripts/install.sh | sh
```

Back up task state **and the original Git repositories** before upgrading.
Follow [backup and restore](https://github.com/Pepewitch/wisp/blob/v0.5.6/docs/INSTALL.md#back-up-and-restore-a-wisp-home); copying `.wisp`
alone does not preserve linked worktrees or unpublished Git objects.
This release adds database migration 9, so a 0.5.5 daemon cannot reopen a profile that 0.5.6 has opened.

## Scope and known limits

This release is for a trusted single OS user. Worktrees separate checkouts;
they do not sandbox agents or their credentials. There is no multi-user
permission boundary. Closing Desktop leaves daemons and agents running.
Intel macOS and non-Apple-Silicon Desktop builds are unsupported.

Desktop publication requires Developer ID signing, notarization, a stapled
ticket, and a verified updater signature. The macOS daemon remains ad-hoc
signed. Automated release gates verify immutable downloads and promote the
Formula, Cask, daemon channel, and Desktop channel together. At source
preparation, the 0.5.6 artifact gates are pending; the [qualification ledger](https://github.com/Pepewitch/wisp/blob/main/docs/v0.5/QUALIFICATION.md)
records the final outcome separately from these immutable release notes.

Workflows wake real agent turns: a Heartbeat on a short interval spends real
model quota, so give it a budget and a purpose. Automation plugins are trusted
OS-user processes, not sandboxes, and push and merge permissions default off —
Wisp does not merge directly. CI and review watchers only see what the task's
Git remotes and credentials can see. The workflows PR was developed without a
Rust-toolchain rebuild of the Desktop native core; no Rust code or native
proxy policy changed, and the release workflow builds the native app from the
tag.
Native dependency advisories still include upstream maintenance notices and a
locked Linux-only glib warning. Full clean-machine provider journeys, a
human-observed Desktop upgrade across this version, broad OS coverage, and
cross-machine restore remain incomplete. Task export excludes repositories and
provider sessions; it is not a complete backup or an import format. Permanent
deletion is logical, not forensic erasure. This release is not a security
certification.

## Release assets

The release contains these ten immutable assets:

- `wisp-v0.5.6-linux-x86_64`
- `release-manifest.json`
- `SHA256SUMS`
- `wisp-v0.5.6-darwin-arm64.tar.gz`
- `release-manifest-darwin-arm64.json`
- `SHA256SUMS-darwin-arm64`
- `wisp-desktop-v0.5.6-darwin-arm64.tar.gz`
- `wisp-desktop-v0.5.6-darwin-arm64.tar.gz.sig`
- `release-manifest-desktop-darwin-arm64.json`
- `SHA256SUMS-desktop-darwin-arm64`
