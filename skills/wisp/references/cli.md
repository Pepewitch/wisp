# Wisp CLI reference

Every command the CLI owns. Task, project, and lifecycle operations are thin
HTTP clients of the daemon. Setup and diagnostic commands such as `init`,
`token`, `version`, and `doctor` also inspect the active local profile or
installation. Task ids are short strings like `tq2szu`; `wisp --help` prints
the same list.

`wisp doctor --storage [--archived-before <30d|YYYY-MM-DD>]` is strictly
read-only, works without a daemon, and never initializes the local home.
It shows storage by directory, largest and orphan worktrees, live/archived log
bytes, estimated growth, and potential reclaim. Archive age uses last update;
estimates exclude SQLite overhead and do not bypass cleanup safety checks.

`wisp purge --archived-before <30d|YYYY-MM-DD>` lists archived tasks and bytes
without deleting anything. Repeat with `--confirm-count <n>` only after reviewing
the list and exporting what you need. A stale count refuses. Failed deletions
are named while the rest continue; any failure exits nonzero.
`wisp purge <task> --confirm <task>` remains the single-task form.

## Workflows

```sh
wisp workflow types [--json]
wisp workflow start <task> heartbeat --every 5m --prompt "Objective and stop condition"
wisp workflow start <task> pr-ci --pr <url> --every 5m
wisp workflow start <task> pr-review --pr <url> --quiet-for 30m
wisp workflow list <task> [--json]
wisp workflow show <workflow-id> [--json]
wisp workflow set <workflow-id> --every 10m
wisp workflow pause <workflow-id>
wisp workflow resume <workflow-id>
wisp workflow complete <workflow-id>
```

Workflows persist in the daemon and wake settled tasks between turns. Stop
pauses them; archive completes them. Configure prompts, timers, limits, and
explicit push/merge permissions through flags or `--params` JSON. See
[Task workflows](../../../docs/WORKFLOWS.md) for defaults, review quiet-window
semantics, recovery limits, and the trusted executable plugin contract.

## Tasks

```
wisp new [repo] "prompt" --harness <h> [--model <m>] [--effort <level>] [--local]
         [--base <ref>] [--image <path>]…
```

Create and start a task. `repo` defaults to the current directory.
`--model`/`--effort` fall back to `harnessDefaults` in `~/.wisp/config.json`,
then to the harness's own default. `--local` runs in the repo checkout itself
instead of a worktree. `--base` forks this task's worktree from `<ref>`
instead of the project's base branch — any commit-ish (`origin/release-2.1`,
a local branch to stack on, a tag, a SHA), taken literally, and the create
fails if it does not resolve. It is rejected for `--local`, which adopts the
branch the checkout is already on. `--image` repeats (see images.md). Prints
`created <id> (<harness>[, <model>][, local]) — <title>`; the model is shown
when Wisp received an explicit or configured choice, and omitted when the
harness will choose its own default.

```
wisp ls [-a]
```

One line per task (`-a` includes archived): id, state icon
(◌ creating · ● running · ✓ done · ? needs-input · ⏸ stuck · ✗ failed), the
honest word (`exited N` when the turn delivered its result but the harness CLI
exited nonzero), harness, the latest turn's actual model (`(requested)` when
the harness never reported one), turn count, age, title, and `state_detail`.

```
wisp show <task>
wisp result <task> [turn]
wisp log <task> [turn] [-f|--follow] [--raw|--diagnostic]
```

`show`: state + state_detail, harness/model/effort, session id, worktree,
branch, every turn (status, actual model, usage tokens, prompt excerpt, result
excerpt, attached files), diffstat of the worktree. `result`: the full prompt
and the agent's full answer for one turn (default: latest turn with a result)
— the token-cheap way to read an outcome. `log`: the activity feed, rendered
per-harness (`--raw` for the retained harness stream, `-f` to follow live).
Recorder-capable live turns continue beyond the retained transcript budget:
`-f` still receives their current activity, while a settled log clearly marks
any history that was not retained.

Archived transcripts expire by default after 90 days or when archived logs
exceed 1 GiB, oldest whole turns first. Only completely indexed prose permits
eviction; live logs never qualify. `log`, including `--raw`, explicitly says
when a transcript was evicted. Prompt, result and indexed prose remain.
Configure `turnLogRetentionEnabled`, `turnLogRetentionDays`, and
`turnLogMaxBytes` separately from `turnTranscriptBytes`.

```
wisp search <text> [-a] [--json]
```

Search exact text across task titles, turn prompts/results, queued messages,
and indexed agent prose. Results name the matched field and include a snippet.
`-a` includes archived tasks; `--json` returns the daemon's response for scripts.
In the UI, `⌘F` searches the current task and `⌘⇧F` searches across tasks.

```
wisp wait <task> [--timeout <sec>]
```

Blocks until the task settles: exit 0 done, 2 needs-input, 1 failed, 3 on
timeout (default ≈ 1 day). Waits through `stuck`. Client-side 2-second poll,
so a daemon restart mid-wait costs one poll.

```
wisp send <task> "message" [--image <path>]…
wisp interrupt <task>
wisp fresh <task>
```

`send` steers a supported live harness or queues the message for the next turn;
it does not stop current work. On an idle task it starts the next turn in the
same session. Completed turns can retain background work; list/show report it
separately from the agent outcome, and `show` prints a `background:` block
naming each tracked group — its turn, pgid, live process count, program names
and age — which is what to read before deciding whether Stop is safe. A group
appears only once it has outlived its turn by a few seconds, so a straggler
that exits with the turn is not reported. Normal sending leaves that work running.
`interrupt` explicitly stops the active turn and all tracked task groups and waits
for completion, escalating if needed. Sending and archiving are refused while
Stop is pending or incomplete; retry Stop after resolving the reported failure.
The session survives, so a later `send` can continue the conversation.
`fresh` clears the stored session id so the NEXT turn
starts cold (the web palette's `/fresh`).

Messages are persisted before delivery. If native admission cannot be
confirmed durably, Wisp leaves the message queued and reports uncertain
delivery rather than risking loss. Recovery can replay that stable-ID
message at least once.

There is no CLI verb for changing an existing task's harness, model, or
effort. That is a composer control in the browser and Desktop app, and a
`POST /tasks/<id>/send` field set (`harness`, `model`, `effort`,
`startFreshContext`) on the API. Changing harness requires both an explicit
`model` (`400` without it) and `startFreshContext: true` (`409` without it,
because the new harness cannot inherit the previous provider session). A
same-harness model or effort change keeps the session and applies to the next
turn. The `harnesses` route advertises `taskAgentSwitching`, so a newer client
hides the control against an older daemon instead of failing silently.

```
wisp push <task>
wisp archive <task> [-f|--force]
wisp cleanup <task> [--log|--retry|--confirm-complete|--rerun] [--verified-stopped]
wisp attach <task>
```

`push` pushes the task branch to origin. `archive` removes the worktree while
keeping the branch, conversation and attachment bytes; it refuses (exit
nonzero, named reason) while a turn is running, the tree is dirty, or the
branch holds commits nothing else holds — a merged or pushed branch archives
clean. `-f` overrides: kills the turn, commits leftovers onto the branch as
`wisp: uncommitted work at archive`. Teardown runs in the background after the
response; watch for a `note` line naming anything left behind, and for
failures in `state_detail`. `cleanup` shows the current step and remedy. `--retry`
retries safe steps after their cause is fixed. For an uncertain script, inspect
its effects and `--log`, then use `--confirm-complete` to skip that script or
`--rerun` to explicitly repeat it. For a cleanup from an older Wisp, verify both
scripts and their children stopped and add `--verified-stopped`. See
[Archive cleanup](../../../docs/ARCHIVE-CLEANUP.md). Archiving a `--local` task is bookkeeping only —
nothing is removed. `attach` opens the harness's own interactive UI on the
task's session (claude/codex/cursor/opencode; droid declares no attach
command).

The web header observes pull requests separately from pushing. `/push` remains
available in its slash palette. For a worktree task, Wisp can link a
same-repository GitHub pull request whose head is the task's original stored
branch, using read-only access through the daemon user's authenticated `gh`.
The link icon is green when GitHub says the PR is ready, yellow when failed
checks do not block merging, red for a known merge blocker, purple after merge,
and muted while pending or unknown.

Every non-archived sidebar task also gets a non-interactive glance icon when a
PR exists: muted means associated, red means blocked, and purple means merged.
The task title truncates before the fixed-width PR and Git marks. Provider
refresh failures retain the last icon and mark its hover text stale instead of
making known status disappear.

Non-GitHub origins, fork pull requests, no match, and unavailable GitHub CLI or
credentials stay invisible; none of them changes task state.

## Web slash palette

- `/tokens` — Wisp's persisted token totals by settled turn. This is task
  telemetry, not context size or an account quota.
- `/usage` — the harness's own plan and limits report, offered only when its
  adapter declares that read (Claude and Codex).
- `/context` — the harness's own current context report, offered only when its
  adapter declares that read (Claude and Droid).

The harness reads are out-of-turn probes and cost no model turn. They require
an idle task and, except for account-level Codex usage, an existing harness
session. Missing capabilities stay absent rather than falling back to another
report.

## Projects

```
wisp project add <path> [--name <name>]
wisp project rm <path>
wisp project ls
wisp project show <path>
wisp project set <path> [--name <n>] [--setup <cmd>] [--archive <cmd>] [--base <ref>]
                 [--copy <glob>]… [--clear-setup] [--clear-archive] [--clear-base]
                 [--clear-copy]
```

The project registry feeds the web UI's pickers and per-project automation.
`set` edits the same fields as the web gear dialog: a setup script (runs at
task creation, after the repo's own `.wisp/setup.sh`), an archive script
(teardown hook; failure pauses workspace deletion for review), copy globs (files
copied from the repo into each new worktree, e.g. `.env`), and the base branch
new worktrees fork from. `--copy` repeats and the flags REPLACE the stored list.

Leave the base unset (`--clear-base`) unless the project integrates somewhere
other than its default branch: Wisp resolves `origin/HEAD` on its own, having
fetched first. A bare name is read as the integration branch, so `--base
develop` prefers `origin/develop` over a local `develop` that may be stale;
write `refs/heads/develop` to insist on the local one. Task history survives `project rm`. An
unregistered project remains in the Projects list only while it has active
tasks; archived history remains under **Show archived**. The gear dialog's
**Remove from Wisp** can also archive every active task while unregistering.
Scripts never run for `--local` tasks.

## Daemon & diagnostics

```
wisp init [--port <port>]
wisp serve          run the daemon (foreground; supervise it — see setup.md)
wisp doctor --database  read-only database diagnosis; no migrations or harness probes
wisp doctor         self-check: harness CLIs, git, config files, daemon; exit 1 on failure
wisp token [--rotate]
                    print the API URL + bearer token (also what the web page needs);
                    stop the daemon before --rotate replaces it in config.json,
                    then restart and update every client
wisp models         per harness: the effective model for new tasks, and the
                    models on offer — the CLI's own list where it has one, else
                    the adapter's pinned subset
wisp version        print the Wisp version
```

`init` creates or validates private state and selects a first loopback port.
It does not start the daemon. A persisted port never changes silently.

`wisp log <task> [turn] --diagnostic` exports a retained JSONL diagnostic
snapshot, not a live stream. Records are bounded, and oversized protocol
records carry omission markers; this is not a byte-for-byte pipe dump.
Exports can contain sensitive harness output.

Diagnostic archives are private and enabled by default. Settled archives
expire after 7 days and share a 512 MiB quota, evicting oldest whole turns
first. Configure `diagnosticEnabled`, `diagnosticRetentionDays`, and
`diagnosticMaxBytes` in `config.json`, then restart. A turn reports whether
its archive is complete, partial, evicted, disabled, or unavailable.
Diagnostic loss never stops the harness. These settings are separate from
transcript capture and archived turn-log retention.

`maxConcurrentTasks` defaults to 100, including tasks preparing a workspace.
At capacity, finish or stop another task and retry; new tasks are not silently
queued. Set a positive integer in `config.json` and restart to change the
limit. Steering a running task keeps its slot, and the limit does not cap the
number of turns in a task.

## Conventions that apply everywhere

- Archived tasks are read-only: send/interrupt/fresh/push refuse with a named
  409; show/result/log keep working (logs and the attachment manifest outlive
  the worktree).
- Every refusal is a named reason on stderr with a nonzero exit — parse the
  message, don't guess from the exit code alone.
- Short flags are always boolean (`-a`, `-f`); value flags are always long
  (`--timeout 900`, never `-t`).

Archived task conversations and attachments are retained. After cleanup finishes,
`wisp export <task>` writes a portable JSON snapshot to stdout (use a private
output file). `wisp purge <task> --confirm <task>` permanently removes Wisp-owned
task data while retaining the repository and Git branches. Export first if the
history is wanted; a partial deletion can be retried with the same command.
See [retention and export](../../../docs/ARCHIVE-CLEANUP.md#retention-export-and-permanent-deletion)
for limits and full-backup guidance.
