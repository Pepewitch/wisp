# Wisp 0.9.0

Wisp 0.9.0 is a speed release for long, busy tasks. It was profiled on a real
Engineering Manager task of about a thousand turns orchestrating dozens of
subtasks: less data now crosses from the daemon to the app and the CLI, less
work is redone on every event, and each Claude turn starts sooner. It also
lets you answer Claude's questions inside the turn. You would notice five
things:

- **Long tasks stay fast.** A busy transcript redraws only what changed,
  images stop re-downloading and flickering on every event, and an event
  refetches only what it concerns.
- **Claude's next turn starts sooner.** An idle Claude process stays warm for
  the task's next turn, cutting harness start from about 310 ms to 17 ms and
  roughly 0.9 s off each turn.
- **Claude can ask, and you can answer on the card.** Claude's
  `AskUserQuestion` shows as the question card, the task waits for you, and
  your answer goes back into the same turn.
- **An orchestrating task takes fewer turns.** Routine subtask reports that
  finish close together arrive as one parent turn instead of one each.
- **Search and the CLI are much lighter.** A search miss falls from about
  58 ms to under 1 ms, and a `wisp wait` poll on a long task reads about 1 KB
  instead of 3.5 MB.

## What changed since 0.8.8

**Transfer from the daemon**

- **Task log streams are gzipped frame by frame** (#549). An activity or log
  stream compresses each event as it is sent, so a long history and a live
  feed both arrive about three times smaller (a real Claude turn: 118 KB to
  40 KB), with no delay added to any event.
- **Slimmer task lists** (#559, #565). The live list no longer carries each
  task's skill catalog, which was most of its bytes (about 40 KB to 14 KB on
  the profiled home). The archived list is read in one pass rather than one
  query per task (5.8 MB to 2.2 MB, 591 statements to 6), and queued subtasks
  are numbered once per list.
- **A turn's history stream ends at its turn-end** (#556), and the changed-file
  count is read without fetching the whole diff, which on the profiled task
  was a 525 KB diff on every event.
- **The CLI reads only what a command needs** (#560). `wisp wait` and
  `wisp send` read the task row alone, with no git, and `wisp result` pages
  back only to the turn it prints, instead of each reading the full task
  detail. `wisp show` lists a parent's unarchived subtasks and counts the
  archived ones; `--all` lists every child. Both commands still work against
  an older daemon.

**Web and Desktop app**

- **Long transcripts redraw only what changed** (#558). Activity rows and
  sidebar rows are memoized, settled turns off screen are skipped by the
  browser's layout, and leaving a task trims its cached history.
- **Events refetch only what they concern** (#561). A task event no longer
  invalidates every query, and settled turns' activity is cached rather than
  read again.
- **Transcript images stay put** (#555). An output image is fetched once, only
  when it nears the viewport, and is not reloaded on each event; a failed one
  is asked for again after a reconnect (#568).
- **Panels keep up** (#566, #572). Workflow panels refresh on the selected
  task's events, including after `/fresh` and archiving, and the selected
  task's git state is renewed when you return to the app.

**Claude turns**

- **Warm Claude processes** (#563, #575, #576). When a Claude turn ends, its
  process waits for the task's next turn instead of exiting, so the next turn
  skips session resume. At most four idle processes are kept, each for up to
  10 minutes idle and 60 minutes in all, so `CLAUDE.md` and settings changes
  are picked up within the hour. Set `"warmHarnessProcesses": 0` in
  `config.json` to turn this off. Codex and Droid are unchanged.
- **Questions are answered inside the turn** (#546, #547). Live Claude turns
  now run with `--permission-prompt-tool stdio`, which is what makes Claude
  offer `AskUserQuestion` at all in print mode. The question renders as the
  same card Droid's questions use; the task reads "turn N is asking you"; the
  card's answer is written back to Claude and the turn carries on. A message
  sent instead, or Stop, releases the question with a reason.
- **Less repeated input per turn** (#557, #570). Standing notes are sent once
  per conversation rather than every turn (sent again after a new context,
  a compaction, a slash command or a failed turn), and a heartbeat wake
  carries its objective inline instead of a file the agent had to read back.
  The task preamble now opens every new context, not only turn 1, so the first
  turn after `/fresh` or a harness switch knows its task and worktree; that
  includes a context that starts with only a slash command.

**Subtasks and orchestration**

- **Routine reports are batched** (#554, #571). A finished subtask's report
  waits up to two minutes while its siblings are still working, so a fan-out's
  results reach the parent as one turn. Questions, stalls, setup failures and
  failed or input-blocked turns are never held.
- **`wisp report ack` works** (#577). Its `--through-turn` number was read as a
  stray argument, so every ack since 0.8.7 printed the usage line and a
  parent could never mark a subtask's reports handled.
- **A task with background work reads correctly** (#573, #575). A Claude task
  whose background shell just ended no longer reads settled before the
  follow-up turn starts, and a task whose next turn is waiting for its old
  process to exit reads running.
- **Same-millisecond queued subtasks keep creation order** (#548), both in
  their queue position and in which one starts first.

**Git and search**

- **Base refs are fetched while you compose** (#550, #551, #574). The New task
  box fetches the project's base refs in the background, so creating the task
  usually skips the fetch. Only the composer's create reuses that fetch; an
  agent's create fetches again, so a merge made outside Wisp is not missed.
- **Search uses full-text indexes** (#562, #569). Titles, prompts, results and
  queued messages are searched through SQLite FTS5 trigram indexes (migration
  34) with the same exact-substring results as before. A query holding a NUL
  character no longer fails with a server error.

**Codex**

- **Codex's skill list loads again** (#578). codex-cli 0.168 wraps
  `skills/list` in a `data` envelope, which Wisp refused, so the `/` skill
  picker was empty for every Codex task.

**Project**

- **A heavy-use bench and a usage profiler** (#552, #553).
  `bun run bench:scale` seeds a thousand-turn orchestrator and measures the
  daemon's endpoints against it; `bun run profile:usage` reads a real Wisp
  home, read-only, and reports where time and bytes go per harness, per
  cohort and per report pipeline, without prompts or paths.
- **Desktop dependency hygiene** (#545). `rustix` and `tokio` move to patched
  releases, clearing two unsound notices that were not reachable in the
  shipped app.
- **Tests and docs:** the turn-log quota test counts only its own logs (#567),
  and 0.8.8's publication was recorded (#544).

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
channel URL remains compatible and advertises the regular 0.9.0 version.
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
  https://raw.githubusercontent.com/Pepewitch/wisp/v0.9.0/scripts/install.sh | sh
```

Back up task state **and the original Git repositories** before upgrading.
Follow [backup and restore](https://github.com/Pepewitch/wisp/blob/v0.9.0/docs/INSTALL.md#back-up-and-restore-a-wisp-home); copying `.wisp`
alone does not preserve linked worktrees or unpublished Git objects.
This release adds database migration 34, so a 0.8.8 daemon cannot reopen a profile that 0.9.0 has opened.

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
preparation, the 0.9.0 artifact gates are pending; the [qualification ledger](https://github.com/Pepewitch/wisp/blob/main/docs/v0.9/QUALIFICATION.md)
records the final outcome separately from these immutable release notes.

Warm Claude processes cost memory: each idle one holds about 270 MB until it
is reused, ages out after 10 minutes idle or 60 minutes in all, or is evicted
past the cap of four. Set `"warmHarnessProcesses": 0` to turn them off. A
routine subtask report can reach its parent up to two minutes later than
before while siblings are still working. Answering Claude's questions on the
card needs a live Claude turn; a one-shot image turn, which closes stdin after
its prompt, still asks in prose. The FTS5 search indexes are built at upgrade
only when the SQLite in use has the trigram tokenizer; without it search falls
back to the previous scan, with the same results, and the index is not built
later. `/clear` does not re-send the task preamble. Desktop's scrolling back
through long transcripts, whose off-screen settled turns are now skipped, was
not observed by a person in the macOS webview for this release. Droid was not
run live for this release: its own CLI returned a provider 404 on the release
machine, outside Wisp. Its live driver is unchanged since 0.8.8; what it
shares with this release (the question card's bookkeeping, standing notes,
report batching) is covered by tests only.
Native dependency advisories still include upstream maintenance notices and a
locked Linux-only glib warning. Full clean-machine provider journeys, a
human-observed Desktop upgrade across this version, broad OS coverage, and
cross-machine restore remain incomplete. Task export excludes repositories and
provider sessions; it is not a complete backup or an import format. Permanent
deletion is logical, not forensic erasure. This release is not a security
certification.

## Release assets

The release contains these ten immutable assets:

- `wisp-v0.9.0-linux-x86_64`
- `release-manifest.json`
- `SHA256SUMS`
- `wisp-v0.9.0-darwin-arm64.tar.gz`
- `release-manifest-darwin-arm64.json`
- `SHA256SUMS-darwin-arm64`
- `wisp-desktop-v0.9.0-darwin-arm64.tar.gz`
- `wisp-desktop-v0.9.0-darwin-arm64.tar.gz.sig`
- `release-manifest-desktop-darwin-arm64.json`
- `SHA256SUMS-desktop-darwin-arm64`
