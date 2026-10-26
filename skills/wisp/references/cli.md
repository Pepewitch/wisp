# Wisp CLI reference

Every command the CLI owns. Task, project, and lifecycle operations are thin
HTTP clients of the daemon. Setup and diagnostic commands such as `init`,
`token`, `version`, and `doctor` also inspect the active local profile or
installation. Task ids are short strings like `tq2szu`; `wisp --help` prints
the same list. `wisp <command> --help` (or `-h` anywhere on the line, or
`wisp help <command>`) prints that command's usage, exits 0, and does nothing
else: it never contacts the daemon, starts one, installs an update, or creates
the local home. That includes a flag value that is exactly `-h` or `--help`:
`--prompt -h` is a request for help, not a prompt.

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

## Image outputs

```sh
wisp output add ./plot.png --turn <n> [--task <task>] [--json]
wisp output list <task> --turn <n> [--json]
wisp output save <task> <image-id> --turn <n> --out <new-file>
```

`add` uploads an image for inline preview and download in the task reply.
The task defaults to `WISP_TASK_ID`; use the turn number in Wisp's reminder.
Images are copied into task storage, remain available after archive, and
are included in export. PNG, JPEG, GIF and WebP are supported, up to 8 MiB
per image and 32 images / 64 MiB per turn. `save` refuses to overwrite a file.
See [Image outputs](../../../docs/IMAGE-OUTPUTS.md) for native capture support.

```sh
wisp capture <url> [--area <name>] [--viewport desktop|mobile|<w>x<h>] [--dark] [--selector <css>]
             [--full-page] [--wait-for <css>] [--wait <ms>] [--script <file.js>] [--allow-port <n>]… [--name <label>] [--json]
```

`capture` screenshots a page on this machine's loopback (`localhost`,
`127.0.0.1`, `*.localhost`) in Wisp's own headless Chrome and stores it in the
running turn. It prints a `.png`/`.jpg` file to look at, the final URL and
status, and where the page was served from. `--script` runs after load
(awaited, 10 s). A failure is recorded with its reason and exits 1; with no
Chrome, publish your own image with `output add`. Reviewer and recipe tasks
launch their app on `PORT` (`WISP_PORT_RANGE`). See
[wisp capture](../../../docs/CAPTURE.md).

## Workflows

```sh
wisp workflow types [--json]
wisp workflow start <task> heartbeat --every 5m --prompt "Objective and stop condition"
wisp workflow start <task> schedule-steer --at <ISO-8601 with offset> --prompt "Message to send"
wisp workflow list <task> [--json]
wisp workflow show <workflow-id> [--json]
wisp workflow set <workflow-id> --every 10m
wisp workflow pause <workflow-id>
wisp workflow resume <workflow-id>
wisp workflow complete <workflow-id>
```

A bare `wisp workflow` prints this usage and its parameters; an unknown verb
is refused with exit 1.

Workflows persist in the daemon and wake settled tasks between turns. Stop
pauses them; archive completes them. Configure prompts, timers, limits, and
push/merge instructions through flags or `--params` JSON. See
[Task workflows](../../../docs/WORKFLOWS.md) for defaults, recovery limits,
and the trusted executable plugin contract. Push/merge flags guide the agent; they are not a
process sandbox.

## Auto-merge, auto-fix and auto-review

```
wisp pr <task>                 # status and the reason it is waiting
wisp pr <task> merge on|off    # auto-merge
wisp pr <task> fix on|off      # auto-fix
wisp pr <task> review on|off   # auto-review
wisp pr <task> send-now        # send a waiting auto-fix round at once
wisp pr <task> skip            # never send that round
wisp pr <task> resume          # after a pause, or to release a Stop hold early
wisp pr <task> history         # what it did: when, what, which PR and commit, and why
```

With auto-merge on, Wisp merges the task's open PR once its checks pass, a
reviewer who blocked has passed the current head, the task is idle, and the
worktree holds nothing the PR lacks. Every turn tells the agent to push and open
the PR and to leave the merge to Wisp. With auto-fix on, a red counting check, a
conflict, or review feedback it has not seen (from you, a bot, or anyone who can
push) goes back to the idle agent as a round, at most five per PR; the agent
signs its GitHub posts so Wisp never feeds them back. See
[Auto-merge and auto-fix](../../../docs/PR-AUTOPILOT.md).

With auto-review on, each green head of the PR gets a review round: reviewer A
runs the change (the project's verification recipe) and reviews its code;
on a standard or deep change, reviewer B reviews the code too. Each submits
pass, fail or inconclusive; nothing merges past a head every reviewer on its
panel has not passed. Wisp measures the diff to pick the depth (light, standard,
deep) and reviewers never ask how deep to go. A rejection goes back to the author (with auto-fix) at
most three rounds per PR. See [Auto-review](../../../docs/AUTO-REVIEW.md).

```
wisp review show <task> [--round <n>] [--pr <n> | --all] [--json]   # the current PR's rounds; one in full
wisp review rubric [--project <path>]            # the rubric reviewers judge by, with the project's rules
wisp review submit --stdin                       # a reviewer's verdict (wisp review submit --help)
wisp verify status [project] [--json]            # the project's recipe, a draft, the recipe task
wisp verify setup|improve|fix [project] [--area <name>] [--note "…"] [--harness <h>] [--model <m>]
wisp verify activate [project]                   # make the newest draft the active recipe
wisp verify fallback a|b <harness> [--model <m>] [--effort <e>] | none [--project <path>]
wisp verify show [file] | checkout <dir> | draft save <dir>
```

The recipe lives in the Wisp home, never in the repository. `checkout` and
`draft save` are what a recipe task runs; only a recipe task's own turn may
save a draft, and only a person activates it (an agent's `activate` is refused).
Resume on a task whose reviewer needs you has a fresh reviewer look at the same
head again without spending a round.

`verify fallback` names who reviews in reviewer A's or B's place when its task
fails on the network, on the provider (a 5xx, overloaded, unavailable) or in
setup (before its prompt: worktree, setup script, spawn, or a live session that
never started): once per round, on the same head. A verdict, a missing one, a
usage limit and the time limit never fall back. Unset (`none`, the default)
leaves such a round for you; a harness the daemon does not have is refused. `review show` marks a reviewer that stood
in (`fallback for <agent>: <cause>`), and its `--json` carries `fallback`.

## Tasks

```
wisp new [repo] "prompt" --harness <h> [--model <m>] [--effort <level>] [--fast] [--local]
         [--base <ref>] [--auto-merge] [--auto-fix] [--auto-review] [--attach <path>]…
```

Create and start a task. `repo` defaults to the current directory. A path
inside a linked worktree of a project Wisp knows (a task's own worktree, when
run inside a turn) creates the task for that project's checkout, so the
project's settings and verification recipe apply, and the CLI prints
`repository: <checkout> (<path> is inside a worktree of it)`. Such a task
forks from the project's base like any other (the checkout's HEAD when the
repository has no remote), and a `--base` that depends on the directory
(`HEAD`, `HEAD~1`) is pinned to the commit it names where you ran the
command, and refused if it names nothing there. A `--local` task keeps the
directory given.
`--model`/`--effort` fall back to `harnessDefaults` in `~/.wisp/config.json`,
then to Wisp's default model for that harness (when the installed CLI offers
it), then to the harness's own default. `--fast` runs the same model in the
harness's faster lane; a harness without one refuses it. `--local` runs in
the repo checkout itself instead of a worktree. `--base` forks this task's
worktree from `<ref>` instead of the project's base branch — any commit-ish
(`origin/release-2.1`, a local branch to stack on, a tag, a SHA), taken
literally, and the create fails if it does not resolve. It is rejected for
`--local`, which adopts the branch the checkout is already on. `--auto-merge`
merges the task's PR once it is ready (below); `--auto-review` has an independent
reviewer task verify each of its heads first. `--attach` repeats (see
images.md; `--image` is the old name and still works). Task briefs were
removed, so `--brief` is refused. Prints
`created <id> (<harness>[, <model>][, local][, auto-merge][, auto-fix][, auto-review]) — <title>`;
the model is shown when Wisp received an explicit or configured choice, and
omitted when the harness will choose its own default.

```
wisp new [repo] "prompt" … --subtask | --parent <id> [--report]
         [--kind review|explore|continue] [--base <ref>]
```

Subtasks, on by default (`subtasks: false` in `config.json` turns them off, and
the daemon then reports `features.subtasks` false). A subtask is a task with a
parent, in its own worktree and `wisp/<id>-…` branch. `--subtask` inside a task
makes that task the parent and turns reporting on; `--parent <id>` names one
from anywhere, and reports only with `--report`. A reporting child tells its
parent when a turn ends done, needs input, fails or goes quiet, or its setup
fails; see [supervise.md](supervise.md#subtasks). `repo` defaults to the
parent's, and must be the parent's if given. The CLI checks `features.subtasks` before it uploads any
attachment and refuses on a daemon without it, so it never makes a root task by
mistake. An agent that names a parent that is not its own task gets a warning.

`--kind` picks the base: `review` pins the head of the parent's open PR (no PR,
a fork PR or an unreachable GitHub is refused with "pass --base"), `continue`
pins the parent's committed branch tip, and `explore` (the default) starts from
the project's usual base, as a new task would. An explicit `--base` wins
over the kind. A parent must be a root task: subtasks have one level. A
subtask may not be `--local`. An `explore` child may have auto-fix,
auto-review and auto-merge, at creation (`--auto-fix`, `--auto-review`,
`--auto-merge`) or later with `wisp pr`; `review` and `continue` children none. An agent may turn on
auto-merge only for its own `explore` child, and only while its own task has
merge rights from a person (a person's auto-merge, or a live workflow with
`allowMerge` a person turned on); otherwise it is refused with a 409. At most
`maxSubtasks` (default 10) live children per parent, and at most
`maxRunningSubtasks` (default 3) running at once: past that a new child or a
direct message is refused, and a queued message waits for a slot. Prints `created <id> (…, <kind> subtask of <parent>) — <title>`.

```
wisp ls [-a|--all] [--json]
```

One line per task (`-a` includes archived; `--json` prints the daemon's list
for scripts; a subtask's line is indented under its parent when both are listed): id, state icon
(◌ creating · ● running · ✓ done · ? needs-input · ⏸ stuck · ✗ failed), the
honest word (`exited N` when the turn delivered its result but the harness CLI
exited nonzero), harness, the latest turn's actual model (`(requested)` when
the harness never reported one), turn count, age, title, and `state_detail`.

```
wisp show <task>
wisp result <task> [turn]
wisp log <task> [turn] [-f|--follow] [--raw] [--diagnostic]
```

`show`: state + state_detail, harness/model/effort, session id, worktree,
branch, every turn (status, actual model, usage tokens, prompt excerpt, result
excerpt, attached files), diffstat of the worktree. A prompt excerpt is headed
`you:` for the person's words, or by who wrote it when the person did not:
`Wisp · auto-fix · PR #12 · round 2 of 5:`, `Wisp · workflow · heartbeat:`,
`Claude Code · background update:`. For a subtask it prints
`parent:` (kind, where its base came from) and, for a parent, a `subtasks:`
list (id, state, kind, title). `result`: the full prompt
and the agent's full answer for one turn (default: latest turn with a result)
— the token-cheap way to read an outcome. `log`: the activity feed, rendered
per-harness (`--raw` for the retained harness stream, `-f` to follow live).
Without `-f` it prints only the end of the turn's transcript, its last 16 KiB;
a longer transcript's tail starts partway through a line (`--raw` shows a
leading `…`). `--raw -f` prints the retained stream from its start, follows it
until the turn ends, then prints `— turn N <status> —`. Redirect it to a file
rather than a pipe: when the pipe's reader falls behind, the CLI can exit
after the first 64 KiB without an error.
Recorder-capable live turns continue beyond the retained transcript budget:
`-f` still receives their current activity. Past the budget, a turn keeps its
beginning and its most recent activity, which is appended when the turn ends,
and a settled log marks the gap in the middle that was not retained.

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
timeout (default ≈ 1 day). Waits through `stuck`. It polls every 2 seconds.
Exit 1 also reports a CLI error: a bad `--timeout`, an unknown task, or a poll
that cannot reach the daemon, so run the wait again after a daemon restart.

```
wisp send <task> "message" [--attach <path>]…
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
A Claude agent that starts a long-running background process (a dev server,
a Monitor) finishes its turn when it answers: the task reads `done` with that
process as background work, which `show` names in the harness's own words
under its group. The Claude process stays alive for it, so the next `send`
becomes a new turn in that same process, and a model call the background work
wakes on its own (a monitor event, the process finishing) is recorded as a
turn of its own, which sends no finish notification or webhook. A message for
a different agent or model stops that work first, and so does a daemon
restart, which cannot hand the old process the next message.
`interrupt` explicitly stops the active turn and all tracked task groups and waits
for completion, escalating if needed. Sending and archiving are refused while
Stop is pending or incomplete; retry Stop after resolving the reported failure.
The session survives, so a later `send` can continue the conversation.
`fresh` clears the stored session id so the NEXT turn
starts cold (the web palette's `/fresh`).

The CLI's `send` never stops a turn. The API's `when` field on
`POST /tasks/<id>/send` chooses otherwise, and is what the browser and Desktop
composer send: `now` steers when the running turn can take the message and
otherwise stops that turn so the message starts next, leaving workflows and
background work running; a turn that has already answered and is exiting is
left to finish instead, and a message behind older queued ones keeps its
place without stopping anything. `next-turn` holds the message: it is never steered,
and a later message sent without the hold goes ahead of it. A queued message
can be sent later with `POST /tasks/<id>/messages/<message>/send-now`. Tasks
carry `turn_input` (the running turn's `mode`, `steer`/`wait`/`interrupt`,
and agent), and the `harnesses` route advertises `steerDelivery`.

Messages are persisted before delivery. If native admission cannot be
confirmed durably, Wisp leaves the message queued and reports uncertain
delivery rather than risking loss. Recovery can replay that stable-ID
message at least once.

There is no CLI verb for changing an existing task's harness, model, or
effort. That is a composer control in the browser and Desktop app, and a
`POST /api/tasks/<id>/send` field set (`harness`, `model`, `effort`,
`startFreshContext`) on the API. Changing harness requires both an explicit
`model` (`400` without it) and `startFreshContext: true` (`409` without it,
because the new harness cannot inherit the previous provider session). The
earlier conversation stays visible behind a divider in the timeline, and each
turn keeps the harness and model that ran it: `wisp log` renders a turn in its
own harness's format, and `wisp show` lists each turn's own model. A
same-harness model or effort change keeps the session and applies to the next
turn. The `harnesses` route advertises `taskAgentSwitching`, so a newer client
hides the control against an older daemon instead of failing silently.

```
wisp push <task>
wisp archive <task> [-f|--force] [--subtasks archive|force]
wisp cleanup <task> [--log|--retry|--confirm-complete|--rerun] [--verified-stopped]
wisp attach <task>
```

`push` pushes the task branch to origin. `archive` removes the worktree while
keeping the branch, conversation and attachment bytes; it refuses (exit
nonzero, named reason) while a turn is running, the tree is dirty, the
branch holds commits nothing else holds — a merged or pushed branch archives
clean — or auto-merge / auto-fix is still watching its PR (archiving switches
them off). `-f` overrides: kills the turn, commits leftovers onto the branch as
`wisp: uncommitted work at archive`. When Git cannot read the worktree's status
(a corrupt index, a bad object), archive refuses even with `-f`, because it cannot
tell what would be lost: repair the repository, or move the worktree directory
somewhere else, and archive then clears the task. Teardown runs in the background after the
response; watch for a `note` line naming anything left behind, and for
failures in `state_detail`. `cleanup` shows the current step and remedy. `--retry`
retries safe steps after their cause is fixed. For an uncertain script, inspect
its effects and `--log`, then use `--confirm-complete` to skip that script or
`--rerun` to explicitly repeat it. For a cleanup from an older Wisp, verify both
scripts and their children stopped and add `--verified-stopped`. A task with live
subtasks is refused unless `--subtasks archive` (each must be archivable as it
is) or `--subtasks force` (each is forced) takes them with it, all or nothing
(on when subtasks are on); the CLI lists the
children it takes and prints each child that refused. Auto-review's reviewers
always go with their author. See
[Archive cleanup](../../../docs/ARCHIVE-CLEANUP.md). Archiving a `--local` task is bookkeeping only —
nothing is removed. `attach` opens the harness's own interactive UI on the
task's session (claude/codex/cursor/opencode/droid).

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

```
wisp audit <task> [--limit <1-500>] [--json]
```

Who did what to the task, newest first (the newest 100 unless `--limit` says
otherwise; `GET /api/tasks/<id>/audit?limit=<n>` on the API). One line per
action: when, what, who, and what it was about. The actions are `create`,
`rename`, `send`, `steer`, `send-now`, `edit` and `cancel` (a queued message),
`answer` (an agent's question), `interrupt`, `compact`, `archive`,
`force-archive`, `cleanup` (resolving an archive cleanup), `fresh-session`,
`push`, `autopilot` (a switch turned on or off, including by archiving),
`autopilot-resume`/`-skip`/`-send-now`, `workflow-start`, `-update`, `-pause`,
`-resume` and `-complete`, a `merge` autopilot made, and `fail`.

The actor is `web`, `desktop` or `cli` for the client that asked. It is
`agent:<id>` for `wisp` run by the agent during one of task `<id>`'s turns
(a turn's environment carries `WISP_AGENT_TURN=1` beside `WISP_TASK_ID`); a
person typing in a task's terminal has `WISP_TASK_ID` but not the marker, so
reads as `cli`. `autopilot` or `workflow:<id>` is the daemon acting on a switch
someone armed, including every message they queued that was not cancelled
unsent; `system` is the daemon on its own account; and `api` is a client that
did not name itself. The client name is the caller's own report: it records
which client acted, not who is allowed to. Each task keeps its newest 1000
entries, and `purge` deletes them with the task (the daemon log names who
purged it).

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
wisp doctor         self-check: harness CLIs, git, every project, gh, config files, token
                    length, daemon, unclean restarts, last update, background loops,
                    webhook delivery, GitHub budget; exit 1 on failure
wisp token [--rotate]
                    print the API URL + bearer token (also what the web page needs);
                    stop the daemon before --rotate replaces it in config.json,
                    then restart and update every client
wisp models         per harness: the effective model for new tasks, and the
                    models on offer — the CLI's own list where it has one, else
                    the adapter's pinned subset
wisp limits [--refresh] [--json]
                    plan usage per harness, the same answer as the web top
                    bar's usage popover; --refresh skips the five-minute cache
wisp version        print the Wisp version
wisp update [--yes] check for a newer release and install it when this
                    installation can auto-update, else print how to enable that
```

An update restarts the daemon, and the restart interrupts every running turn.
When any task has one, `wisp update` names how many and asks `Update anyway?
[y/N]` on a terminal. Without a terminal it refuses unless `--yes` (`-y`) is
given. The web update control asks the same question, with Cancel and Update
anyway. Both follow the daemon: `POST /api/update` answers `409` with
`running: N` while turns run, unless the request sets `force: true`. The
check happens once, before the install: a turn that starts while the update
installs is still interrupted by the restart.

On SIGTERM or SIGINT (a service restart, an update, Ctrl-C) the daemon stops
gracefully for up to 5 seconds, then stops its terminal shells and exits. It
does not wait for running turns; the next boot recovers them.

`wisp limits` reads each harness's own plan windows: claude-code through
`claude -p /usage`, codex through its app-server's rate-limit read, droid
through Factory's billing API with the key from Settings → Usage limits (or
`FACTORY_API_KEY` / `DROID_API_KEY` in the daemon's environment). A key that
belongs to a different account than droid's login is refused rather than
shown. Harnesses with no limits read (cursor, opencode) are not listed.

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
- Text that came from an agent, a harness, or a repository (answers, logs,
  search snippets, branch names, script output, refusals) is printed with
  terminal control sequences removed, so it cannot set your clipboard or
  repaint your screen; newlines and tabs are kept. `--json` stays lossless,
  with C1 controls escaped. `log --raw` and `log --diagnostic` keep the exact
  bytes when stdout is a pipe or a file, and are cleaned the same way on a
  terminal.

Archived task conversations and attachments are retained. After cleanup finishes,
`wisp export <task>` writes a portable JSON snapshot to stdout (use a private
output file). `wisp purge <task> --confirm <task>` permanently removes Wisp-owned
task data while retaining the repository and Git branches. Export first if the
history is wanted; a partial deletion can be retried with the same command.
See [retention and export](../../../docs/ARCHIVE-CLEANUP.md#retention-export-and-permanent-deletion)
for limits and full-backup guidance.
