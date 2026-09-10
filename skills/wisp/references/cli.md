# Wisp CLI reference

Every command the CLI owns. Task, project, and lifecycle operations are thin
HTTP clients of the daemon. Setup and diagnostic commands such as `init`,
`token`, `version`, and `doctor` also inspect the active local profile or
installation. Task ids are short strings like `tq2szu`; `wisp --help` prints
the same list.

## Tasks

```
wisp new [repo] "prompt" --harness <h> [--model <m>] [--effort <level>] [--local] [--image <path>]…
```

Create and start a task. `repo` defaults to the current directory.
`--model`/`--effort` fall back to `harnessDefaults` in `~/.wisp/config.json`,
then to the harness's own default. `--local` runs in the repo checkout itself
instead of a worktree. `--image` repeats (see images.md). Prints
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
wisp log <task> [turn] [-f|--follow] [--raw]
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
separately from the agent outcome. Normal sending leaves that work running.
`interrupt` explicitly stops the active turn and all tracked task groups and waits
for completion, escalating if needed. Sending and archiving are refused while
Stop is pending or incomplete; retry Stop after resolving the reported failure.
The session survives, so a later `send` can continue the conversation.
`fresh` clears the stored session id so the NEXT turn
starts cold (the web palette's `/fresh`).

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

`push` pushes the task branch to origin. `archive` removes the worktree and
the task's attachment bytes, always keeping the branch; it refuses (exit
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
wisp project set <path> [--name <n>] [--setup <cmd>] [--archive <cmd>]
                 [--copy <glob>]… [--clear-setup] [--clear-archive] [--clear-copy]
```

The project registry feeds the web UI's pickers and per-project automation.
`set` edits the same fields as the web gear dialog: a setup script (runs at
task creation, after the repo's own `.wisp/setup.sh`), an archive script
(teardown hook; failure pauses workspace deletion for review), and copy globs (files
copied from the repo into each new worktree, e.g. `.env`). `--copy` repeats
and the flags REPLACE the stored list. Task history survives `project rm`. An
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
wisp token          print the API URL + bearer token (also what the web page needs)
wisp models         per harness: the effective model for new tasks and the list
                    the installed CLI exposes
wisp version        print the Wisp version
```

`init` creates or validates private state and selects a first loopback port.
It does not start the daemon. A persisted port never changes silently.

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
