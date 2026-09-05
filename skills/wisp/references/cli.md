# Wisp CLI reference

Every command the CLI owns. The CLI is a thin HTTP client of the daemon; task
ids are short strings like `tq2szu`. `wisp --help` prints the same list.

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
per-harness (`--raw` for the harness's own stream, `-f` to tail live).

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

`send` starts the next turn in the same harness session (and re-arms a done
task). `interrupt` kills the running turn; the session survives, steer
afterwards with `send`. `fresh` clears the stored session id so the NEXT turn
starts cold (the web palette's `/fresh`).

```
wisp push <task>
wisp archive <task> [-f|--force]
wisp attach <task>
```

`push` pushes the task branch to origin. `archive` removes the worktree and
the task's attachment bytes, always keeping the branch; it refuses (exit
nonzero, named reason) while a turn is running, the tree is dirty, or the
branch holds commits nothing else holds — a merged or pushed branch archives
clean. `-f` overrides: kills the turn, commits leftovers onto the branch as
`wisp: uncommitted work at archive`. Teardown runs in the background after the
response; watch for a `note` line naming anything left behind, and for
failures in `state_detail`. Archiving a `--local` task is bookkeeping only —
nothing is removed. `attach` opens the harness's own interactive UI on the
task's session (claude/codex/cursor; droid declares no attach command).

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
(teardown hook; its failure never blocks an archive), and copy globs (files
copied from the repo into each new worktree, e.g. `.env`). `--copy` repeats
and the flags REPLACE the stored list. Task history survives `project rm`.
Scripts never run for `--local` tasks.

## Daemon & diagnostics

```
wisp init [--port <port>]
wisp serve          run the daemon (foreground; supervise it — see setup.md)
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
