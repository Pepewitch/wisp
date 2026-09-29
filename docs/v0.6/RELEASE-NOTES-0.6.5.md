# Wisp 0.6.5

Wisp 0.6.5 is a reliability and security release. It fixes several ways the
daemon could freeze, crash, or lose work, closes gaps that agent output or
unauthenticated input could use, and makes finished tasks and search cheaper.
- **The daemon stays up.** Idle shells, a malformed harness line, or a client
  disconnecting no longer freeze or crash it, and it stops gracefully when
  asked to.
- **Updates ask first.** Updating while tasks are running asks before it
  interrupts them, in the app and in `wisp update`.
- **Steering says what it will do.** While a turn runs, the composer says
  whether a send steers the turn, starts the next one, or stops the turn.

## What changed since 0.6.4

### Reliability

- **Idle terminal shells no longer freeze the daemon** (#319). Shell tabs
  read and write without holding the daemon's file worker threads, so idle
  shells can no longer block everything else.
- **One malformed harness line no longer crashes the daemon** (#317). Route
  errors and background-loop failures are now logged instead of lost.
- **Turns keep their whole result** (#316). Long final reports are no longer
  cut at 16 KiB, a daemon restart no longer loses a turn's session, and every
  turn now settles instead of staying open.
- **No second harness after a timezone or locale change** (#318). Wisp no
  longer mistakes a live harness for a dead one when the timezone or locale
  changes, so it no longer starts a second copy.
- **Resumed Claude turns keep their background agents** (#313). A resumed
  turn no longer kills the agent's background agents after 10 minutes.
- **Data-safety fixes** (#325).
  - Archive refuses, and deletes nothing, when git cannot read a worktree's
    status, so it never removes uncommitted work.
  - Removing a project no longer undoes changes made at the same time.
  - An out-of-range config value falls back to its default, with a warning.
  - Purge removes every related row.
  - The instance ID is written atomically.
- **Graceful stop and safer updates** (#330). The daemon stops gracefully on
  SIGTERM. Updating while tasks are running asks first: a dialog in the app,
  a y/N prompt in `wisp update`, and `wisp update --yes` for scripts.
- **Bun 1.4.2** (#329). The runtime moves to Bun 1.4.2, which fixes an
  intermittent crash when a client disconnects. The Linux binary is smaller
  and starts faster.

### Security

- **Desktop hardening** (#321). The Local connection's token is never sent
  through an HTTP proxy, external links open in your browser, the app asks
  for narrower permissions, relayed responses are hardened, and Desktop
  recovers from a corrupt connections file.
- **Agent-written diagrams and HTML are contained** (#328). They can no
  longer fetch remote content, navigate the window, or overwrite the page
  around them. A diagram that would load remote content shows as source.
- **Daemon input and probes** (#327). Unauthenticated input is size-bounded,
  the claude usage probe runs from a private directory, prompts that start
  with `-` are passed safely to cursor and opencode, every response sets
  `X-Content-Type-Options: nosniff`, and large JSON responses are gzipped.
- **Tokens and webhooks** (#335). Repeated wrong tokens are throttled,
  webhook URLs are redacted in logs, and webhooks no longer follow redirects.
- **Safe `--help` and terminal output** (#314). `--help` never runs a
  command, and agent-written text can no longer drive your terminal with
  escape sequences.
- **Autopilot merge gate** (#331).
  - A PR with more than 100 reviews is held, not merged.
  - Text a bot relays from someone else can no longer instruct the agent or
    let a merge through.
  - A PR from a fork can no longer hide the task's own PR.
  - Each merge record carries the merged commit SHA and its evidence, and the
    new `wisp pr <task> history` lists a task's auto-merge and auto-fix
    history.
- **Release pipeline** (#322, #323). Release jobs run without caches and
  with signing secrets scoped to the steps that use them, the installer and
  updater accept only https, and undici is pinned past a denial-of-service
  advisory.

### Performance

- **Finished tasks open without streaming their transcript** (#332). Opening
  one sent up to 25 MB to the pane; it now sends under 100 bytes.
  `/api/status` no longer runs git for every task on every event.
- **Search no longer stalls the daemon** (#336). Search runs off the request
  thread, the daemon boots faster, and retention cleanup does less work.
- **Lighter background work** (#309, #311). The daemon-served app loads
  Mermaid only when a diagram needs it, and automatic harness limit probes
  are throttled.
- CI now enforces performance budgets (#337).

### Visibility

- **`wisp doctor` reports more** (#335): crash loops, failing or dead
  webhooks, the last self-update, `gh` authentication, every project, and
  background-loop health. Daemon log lines now have timestamps.

### App

- **One bad render no longer blanks the app** (#333). A rendering error
  degrades only the pane it happened in.
- **Brief tab** (#320). The task brief moves from the band above the
  conversation into a **Brief** tab, first in the task panel and open by
  default, with an on/off switch. The conversation gets its full height back.
- **Steering says what a send will do** (#326). While a turn runs, the note
  above the composer says whether a send steers the turn, starts the next
  turn, or stops the turn and then sends. A toggle beside the send button
  holds one message for the next turn, and a queued message has a
  **send now** action.
- **iOS home-screen app** (#312). Touch headers stay clear of iOS's top blur.

### Docs and hygiene

- Documentation fixes for attachments, versioning, config, and the security
  boundary (#315).
- CI, test, and dependency upkeep (#310, #324, #334), and the 0.6.4
  publication record (#308).

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
channel URL remains compatible and advertises the regular 0.6.5 version.
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
  https://raw.githubusercontent.com/Pepewitch/wisp/v0.6.5/scripts/install.sh | sh
```

Back up task state **and the original Git repositories** before upgrading.
Follow [backup and restore](https://github.com/Pepewitch/wisp/blob/v0.6.5/docs/INSTALL.md#back-up-and-restore-a-wisp-home); copying `.wisp`
alone does not preserve linked worktrees or unpublished Git objects.
This release adds database migration 16, so a 0.6.4 daemon cannot reopen a profile that 0.6.5 has opened.

## Scope and known limits

This release is for a trusted single OS user. Worktrees separate checkouts;
they do not sandbox agents or their credentials. There is no multi-user
permission boundary. Closing Desktop leaves daemons and agents running.
Intel macOS and non-Apple-Silicon Desktop builds are unsupported.

Desktop publication requires Developer ID signing, notarization, a stapled
ticket, and a verified updater signature. The public macOS daemon application
also requires Developer ID signing, notarization, and a stapled ticket.
Automated release gates verify immutable downloads and promote the Formula,
Cask, daemon channel, and Desktop channel together. At source
preparation, the 0.6.5 artifact gates are pending; the [qualification ledger](https://github.com/Pepewitch/wisp/blob/main/docs/v0.6/QUALIFICATION.md)
records the final outcome separately from these immutable release notes.

Specific to this release:
- Updater signing now runs without the build step's environment. That narrows
  the signing key's exposure; it does not fully isolate the key.
- The Linux update manifest is still verified by a hash published in the
  same release, so it is only as trustworthy as that release.
- The app's error boundaries catch rendering errors only. An error thrown in
  asynchronous code is not caught by them.
- Against an older daemon, the composer keeps the old steering note and has
  no hold toggle.

The task-brief limits listed for
[0.6.4](https://github.com/Pepewitch/wisp/blob/v0.6.4/docs/v0.6/RELEASE-NOTES-0.6.4.md#scope-and-known-limits),
the shell-tab, plan-limit, and Desktop first-launch limits listed for
[0.6.3](https://github.com/Pepewitch/wisp/blob/v0.6.3/docs/v0.6/RELEASE-NOTES-0.6.3.md#scope-and-known-limits),
and the auto-merge, auto-fix, review judge and draft limits listed for
[0.6.2](https://github.com/Pepewitch/wisp/blob/v0.6.2/docs/v0.6/RELEASE-NOTES-0.6.2.md#scope-and-known-limits),
still apply.
Native dependency advisories still include upstream maintenance notices and a
locked Linux-only glib warning. Full clean-machine provider journeys, a
human-observed Desktop upgrade across this version, broad OS coverage, and
cross-machine restore remain incomplete. Task export excludes repositories and
provider sessions; it is not a complete backup or an import format. Permanent
deletion is logical, not forensic erasure. This release is not a security
certification.

## Release assets

The release contains these ten immutable assets:

- `wisp-v0.6.5-linux-x86_64`
- `release-manifest.json`
- `SHA256SUMS`
- `wisp-v0.6.5-darwin-arm64.tar.gz`
- `release-manifest-darwin-arm64.json`
- `SHA256SUMS-darwin-arm64`
- `wisp-desktop-v0.6.5-darwin-arm64.tar.gz`
- `wisp-desktop-v0.6.5-darwin-arm64.tar.gz.sig`
- `release-manifest-desktop-darwin-arm64.json`
- `SHA256SUMS-desktop-darwin-arm64`
