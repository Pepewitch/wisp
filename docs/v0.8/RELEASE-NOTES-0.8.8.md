# Wisp 0.8.8

Wisp 0.8.8 brings Claude's current model lineup forward, makes starting a task
as expressive as steering one, and fixes three states that told you something
untrue. You would notice five things:

- **Fable 5.2 is offered.** Claude's curated lineup now names Fable 5.2 where
  it named Fable 5.1. It needs a `claude` from 2.1.322 or later.
- **`@` and `/` work in the New task box.** The create composer takes file
  mentions and the command palette, the same way the steer box does.
- **The sidebar keeps up after a login-time start.** A Desktop window that
  opened before its daemon was listening no longer leaves every task dot
  frozen until you restart the app.
- **A finished turn stops claiming it waits for you.** A turn that hit one
  refused command and worked around it now ends as done.
- **A refused attachment upload fails the upload, not the daemon.** An upload
  rejected for size, storage pressure or an unsupported file type could take
  the daemon down with an unhandled stream error.

## What changed since 0.8.7

**Harnesses and models**

- **Claude offers Fable 5.2** (#538). The curated lineup is now
  `claude-fable-5-2`, `claude-opus-5-5`, `claude-sonnet-5-5`,
  `claude-haiku-5-5` — Fable 5.2 replaces Fable 5.1 rather than joining it,
  because that list mirrors claude's own `latest_per_family`, which holds one
  current id per family. Claude Code enumerates no models, so this list is the
  one place a new Claude model can reach Wisp. A model you had pinned in
  `config.json` or set on an existing task keeps working; an `adapters.json`
  default naming Fable 5.1 now warns and falls back to Wisp's default instead
  of failing the daemon's boot.
- **Harness pins re-verified** (#538). Claude's zero-token surfaces were
  re-read against claude-code 2.1.322 and Cursor's against cursor-agent
  2026.11.11, with no change to any flag, effort level or failure marker Wisp
  depends on. Cursor discovers its own catalog, so Cursor users already saw
  Fable 5.2 as `claude-fable-5-2-<effort>` and needed no release.

**Web app**

- **The create composer takes `@` and `/`** (#537). The New task modal, and
  the new-subtask one, now accept `@` mentions and the `/` palette through the
  same hooks the steer box uses, so `/` cannot come to mean two things. There
  is no task yet while you are creating one, so every pick is prompt text: the
  Wisp tier, the harness's out-of-turn reads and the tool panel are absent
  rather than offered and refused. The skill registry is the project's, read
  for the harness picked in the bar below; a harness that can only enumerate
  from a live session says so as the group's footer.
- **The sidebar keeps following task state** (#536). Both Desktop and its
  daemon start at login, and a window that opened first had its event stream
  refused. The one rebuild was refused too, and that ended the chain, so no
  stream opened again: a new task stayed grey, a finished one stayed violet,
  and only restarting the app fixed it. A refused readiness check now retries
  on the same backoff and the reopen resyncs the lists. The log stream had the
  same hole and the same fix. Reads also no longer pause when the browser
  reports itself offline — a loopback proxy or a remote daemon is reachable
  whatever the page thinks, and a paused read stayed silent with no error.

**Claude turns**

- **A denial the agent went past no longer holds the turn** (#534). Claude's
  result lists every tool call a permission check denied during the turn, even
  one the agent then worked around. Wisp read any entry as needs-input, so a
  long turn that hit one refused command and went on to finish showed
  "Waiting for you" — and held its parent's queued subtask reports back. Now
  only a denial of the turn's last batch of main-agent calls holds it; a
  subagent's denial never does, and an entry naming no tool call keeps the
  plain rule.

**Desktop updater**

- **Its dependency tree carries no known vulnerability again** (#541). The
  weekly advisory run had been red since early November, reporting six
  vulnerabilities rather than the maintenance notices it is meant to tolerate.
  One of the six was compiled into the Desktop app Wisp actually publishes:
  `rustls-webpki` 0.103.15, in the TLS path the updater fetches over, where
  certificate verification could accept distrusted intermediates
  (RUSTSEC-2026-0382). It is now 0.103.16. The other five — four `zip`
  extraction issues and `webpki-root-certs` — reach the lockfile for platforms
  this release does not build, the same way Tauri's Linux GTK notices do; they
  are cleared too, by moving `tauri-plugin-updater` to 2.14.1, whose
  requirement is the fixed `zip` line.

**Project**

- **Bun 1.4.4** (#540), up from 1.4.2, with a `toolchain:check` gate holding
  every pin against one source of truth and `release:check` refusing to
  validate a release on an unpinned Bun. Finding that drift also found two
  defects it had been hiding: two migration test fixtures built a schema no
  real profile ever had (SQLite 3.54 re-validates the whole schema on
  `DROP COLUMN` and rejects it), and an aborted attachment upload could emit
  an unhandled stream `'error'` event — a process-level crash rather than a
  failed upload — on the over-cap, storage-full and bad-magic-bytes paths.
  That one is a real fix for anyone whose upload is refused.
- **Releases gate in seconds instead of minutes** (#542). `release:check` was
  spending about five minutes re-running lint, types, every test suite, smoke
  and the build — all of which CI proves on the identical commit, at the same
  moment. It now runs only the three gates no CI job runs and reads CI's
  verdict for the rest, with `--full` keeping the old everything-locally
  behaviour for when you want no network. `--full` is itself down from ~5min
  to ~1min50s, because the daemon suite now shards six ways locally (49s
  against 240s) using the balanced table CI already had.
- **Briefs are fully gone** (#536). Migration 33 drops `task_briefs`,
  `brief_runs`, `task_answer_observations` and the `tasks` columns
  `brief_enabled`, `brief_generation` and `input_rev`. #402 removed the
  feature but kept the tables so a downgrade could still open the profile;
  every migration since makes an older build refuse the profile anyway, so
  they bought nothing.
- **Tests:** the launch policy accepts a stand-in's GNU build (#536), after
  GitHub's `ubuntu-latest` moved to 26.04 where `true` resolves to
  `/usr/bin/gnutrue` and every fake harness spelled `true` was refused.
- **Docs:** 0.8.7's publication was recorded (#533), and the harness refresh
  playbook gained the two files a model change must touch but no gate catches
  (#538).

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
channel URL remains compatible and advertises the regular 0.8.8 version.
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
  https://raw.githubusercontent.com/Pepewitch/wisp/v0.8.8/scripts/install.sh | sh
```

Back up task state **and the original Git repositories** before upgrading.
Follow [backup and restore](https://github.com/Pepewitch/wisp/blob/v0.8.8/docs/INSTALL.md#back-up-and-restore-a-wisp-home); copying `.wisp`
alone does not preserve linked worktrees or unpublished Git objects.
This release adds database migration 33, so a 0.8.7 daemon cannot reopen a profile that 0.8.8 has opened.

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
preparation, the 0.8.8 artifact gates are pending; the [qualification ledger](https://github.com/Pepewitch/wisp/blob/main/docs/v0.8/QUALIFICATION.md)
records the final outcome separately from these immutable release notes.

Fable 5.2 needs a `claude` from 2.1.322 or later. Claude Code validates no
`--model` string, so an older CLI accepts the id and the API refuses it
mid-turn; the task fails with that message rather than being stopped before it
starts. Homebrew's `claude-code` cask can lag the npm release by days — the
`claude-code@latest` cask tracks the faster channel. Wisp's own default stays
Opus 5.5, which older CLIs know, so only a deliberate pick reaches this.
Claude's model list is curated in the adapter because the CLI enumerates none:
an id Wisp does not list but your `claude` accepts still works when you pin it
yourself. The create composer's `/` palette reads the project's skill
registry, not a running session's, so a harness that only enumerates from a
live session offers nothing there. Downgrading to 0.8.7 after this release has
opened a profile is refused, as migration 33 drops the brief tables.
Native dependency advisories no longer include a known vulnerability, but they
still include upstream maintenance notices and unsound-code warnings this
release does not act on: `proc-macro-error` and five `unic-*` crates
unmaintained, and `glib` (Linux-only), `rustix` and `tokio` marked unsound. Full clean-machine provider journeys, a
human-observed Desktop upgrade across this version, broad OS coverage, and
cross-machine restore remain incomplete. Task export excludes repositories and
provider sessions; it is not a complete backup or an import format. Permanent
deletion is logical, not forensic erasure. This release is not a security
certification.

## Release assets

The release contains these ten immutable assets:

- `wisp-v0.8.8-linux-x86_64`
- `release-manifest.json`
- `SHA256SUMS`
- `wisp-v0.8.8-darwin-arm64.tar.gz`
- `release-manifest-darwin-arm64.json`
- `SHA256SUMS-darwin-arm64`
- `wisp-desktop-v0.8.8-darwin-arm64.tar.gz`
- `wisp-desktop-v0.8.8-darwin-arm64.tar.gz.sig`
- `release-manifest-desktop-darwin-arm64.json`
- `SHA256SUMS-desktop-darwin-arm64`
