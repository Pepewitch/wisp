---
name: wisp
description: Delegate coding tasks to coding-agent harnesses (droid, claude, codex, cursor, opencode) through a Wisp daemon — a separate worktree per task (checkout separation, not a sandbox), honest states, attachments. Load whenever you want to hand off, parallelize, or supervise implementation work instead of doing it inline, including checking on, answering, steering, or landing tasks that already exist; also covers the optional browser and desktop operator interfaces.
---

# Wisp — driving the task daemon

Wisp runs coding agents in separate git worktrees (one per task) behind a
daemon, wispd. Drive agent automation through the `wisp` CLI; the daemon owns
all state. The browser and desktop app are operator interfaces over that same
authority, not alternate task stores. Never edit a task worktree yourself
except to review and merge.

A worktree is checkout separation, **not a sandbox**: the harness runs as the
daemon's user with its credentials and its network, and can read and write
outside the worktree. For a repository you do not trust, use a separate OS
account or a disposable VM — a prompt saying "work only here" enforces nothing.

## Two loops: delegate or supervise

**Delegate** when you create the task yourself and cannot continue until it
settles:

    wisp doctor                                   # 0. daemon + harnesses healthy?
    wisp new <repo> "prompt" --harness droid      # 1. create (repo defaults to cwd)
    wisp wait <id> --timeout 900                  # 2. block, bounded, until it settles
    wisp result <id>                              # 3. read the agent's answer
    wisp send <id> "message"                      # 4. steer (optional, repeatable)
    wisp archive <id>                             # 5. cleanup, after the work lands

**Supervise** when the tasks already exist (yours, another agent's, or a
person's) or you are watching several. Do not block: take one snapshot, act
on what needs you, and return; never loop on these commands to wait. The
daemon keeps all state, so the next check starts again from `wisp ls`.

    wisp ls                                       # 1. every task: state, turn, state_detail
    wisp show <id>                                # 2. turns, branch, diffstat, background work
    wisp result <id> [turn]                       # 3. the answer (check which turn it printed)
    wisp log <id> [turn]                          # 4. only when the result is not enough
    wisp send <id> "message"                      # 5. answer, steer, or start the next turn
    wisp interrupt <id>                           # 6. stop a runaway turn (the session survives)

Triage by state: `running` needs nothing yet; `done` needs its result and
diff reviewed (section 7); `needs-input` needs an answer (section 4); `stuck`,
`failed`, and `exited N` need a look (section 8). Also useful while
supervising: `wisp search <text>` finds tasks by exact text in titles,
prompts, and results; `wisp brief show <id>` prints the agent's own short
report when briefs are on; `wisp pr <id>` says what auto-merge / auto-fix is
waiting for; `wisp audit <id>` shows who (a client, an agent, autopilot, a
workflow) did what.

## 1. Prerequisites

wispd must be running. `wisp doctor` checks harness CLIs, auth, git, config,
and daemon reachability, exiting nonzero and naming what failed. Daemon down →
start it under the host's supervisor, never a bare `wisp serve &` (recipes:
[references/setup.md](references/setup.md)).

Wisp Desktop (Apple Silicon) is optional. Install it with both names,
`brew install Pepewitch/tap/wisp Pepewitch/tap/wisp-desktop`: Homebrew's tap
trust covers only the names passed to it, so the Cask alone fails on the
daemon Formula it depends on. Desktop Local uses the standard Wisp profile;
each saved remote tab is a separate reachable daemon. Desktop and daemon
releases update independently, and a saved remote daemon is updated on its
own host. Connections, project picking, the **Updates** popover, the alpha.8
bootstrap, and removal are in the setup reference; release evidence is in
[the qualification ledger](../../docs/v0.6/QUALIFICATION.md).

## 2. Creating tasks

    wisp new <repo> "prompt" --harness <droid|claude|codex|cursor|opencode> [flags]

`wisp help new` prints every flag the installed version accepts; check it
instead of trusting a copied list, including this one.

- Prompts MUST be self-contained: the task worktree sees only the repo, and no
  conversation context carries over. Restate the goal, relevant file paths,
  and constraints in the prompt itself.
- Every prompt must include verification commands (the exact test/build that
  proves the change) and commit instructions ("commit your changes to the task
  branch when done").
- Model and effort come from `harnessDefaults` in `~/.wisp/config.json` unless
  you pass the flags; explicit always wins. The `created …` output shows the
  model when Wisp received one. If it omits the model, the harness will choose
  its own default. Use `wisp models` and pass `--model` when the task requires
  a pinned choice.
- `--local` runs in the repo itself instead of a worktree (archiving it never
  removes anything). `--base <ref>` forks the worktree from another ref, such
  as a branch to stack on. `--fast` runs the same model in the harness's
  faster lane and is refused where there is none. More harnesses:
  `~/.wisp/adapters.json`.
- `--auto-fix` sends red CI, a merge conflict, or review feedback on the
  task's PR back to the agent, at most five rounds per PR. `--auto-merge`
  tells every turn to push and open a PR, then merges it once it is ready
  (checks green, blocking reviews cleared, task idle); arm it only for work
  you would merge yourself on green. Switch either later with
  `wisp pr <id> merge on|off` or `wisp pr <id> fix on|off`.
- `--brief` asks each turn's agent for a short brief, read with
  `wisp brief show <id>`. A brief is the agent's report, not a verified result.

## 3. Waiting for a task

    wisp wait <id> [--timeout <sec>]

Exit codes: 0 done · 2 needs-input · 1 failed · 3 timeout. This is THE way to
await a task: it blocks, burns no tokens, and waits through `stuck` (a quiet
task often comes back). Without `--timeout` it waits about a day, so always
pass a bound you can afford. Exit 3 means the task is still running, not that
it failed: report that or do other work instead of re-waiting in a loop.
NEVER tail logs or poll `wisp ls` to wait.

A supervisor does not wait. To be told instead, `webhooks` in
`~/.wisp/config.json` POST every done / needs-input / stuck / failed
transition at-least-once (dedup on task_id+seq). To act later without
blocking, `wisp workflow` attaches durable follow-up to a task:
`schedule-steer` sends one message at a set time, and `heartbeat` wakes the
task's agent on a timer and can spend tokens on every wake
(`wisp workflow types`, `wisp help workflow`).

## 4. Reading results

- `wisp result <id> [turn]` — the agent's full answer (default: latest turn
  with a result). Read this first, and check the turn in its
  `── you (turn N) ──` header: the default skips a turn that has no result
  yet, so it can print an older turn's answer.
- `wisp show <id>` — state, state_detail, per-turn model/usage/attachments,
  worktree + branch, diffstat.
- `wisp log <id> [turn] [-f] [--raw]` — the activity feed. Only when debugging
  the agent's behavior or recovering a question, never for waiting or for the
  final answer. `-f` follows current activity even after the bounded retained
  transcript is full.

### When `needs-input` shows no question

`needs-input` means the task is waiting on you, and `state_detail` says why.
`turn N is asking you` is a Droid `AskUser` questionnaire that turn is blocked
on. The turn is still running and has no result, so `wisp result` prints
`(turn N is running, no result text)` or an older turn's answer, and the
rendered log cuts the question short. Read it from the raw stream:

    wisp log <id> <N> --raw | grep -E 'AskUser|"questions"'

The `AskUser` tool call's `questionnaire` holds the `[question]` and
`[option]` lines; the `question` event lists the same `questions` with their
`options`. A Droid too old to hold the turn open ends it as `needs-input`
instead; its `AskUser` tool call is still in the raw stream. Answer with
`wisp send <id> "…"` and state your choice for every question: on an open
questionnaire, send releases it and delivers your message into the same turn,
so the agent reads your words, not a selection. The browser and Desktop show
the same questionnaire as an answerable card. A stopped turn also reads
`needs-input` (`turn interrupted — session kept, …`); send the next
instruction.

## 5. Steering

- `wisp send <id> "message" [--attach <path>]…` — a follow-up turn in the same
  session (the harness remembers prior turns; send also re-arms a done task).
  On a running task it steers the live turn or queues for the next one; it
  never stops work.
- `wisp interrupt <id>` — stop a runaway turn. The session survives.
- `wisp fresh <id>` — the next turn starts a fresh harness session.
- Changing the harness, model, or effort of an EXISTING task is a browser and
  Desktop composer control, not a CLI flag. A same-harness model or effort
  change rides the next turn with the provider session intact. Switching
  harness starts a fresh context under the same task id: the old history stays
  readable behind a divider in the timeline, but the new harness sees none of
  it, so the next message must restate the goal like a new prompt. Each turn
  records the harness that actually ran it, so logs and `wisp show` report the
  turn's own harness rather than the task's current one.

## 6. Attachments

    wisp new <repo> "fix the layout bug in this screenshot" --harness codex --attach ./shot.png
    wisp send <id> "now compare against this mock" --attach ./mock.png

`--attach` repeats — up to 10 files per turn, 50 MB total (`--image` is the
old name and still works). Detected by magic bytes, not the extension:
png/jpeg/gif/webp images (5 MB each), pdf (20 MB), utf-8 text (20 MB), and
mp4/mov/webm video (50 MB). All five builtin harnesses accept every kind;
droid/cursor receive images as file paths to read (png/jpeg only, claude/codex/
opencode get images natively), and every harness receives pdf/text/video the
same path-in-the-prompt way. Attachments are stored outside the worktree and
never appear in the task's diff. Delivery, limits, and lifecycle:
[references/images.md](references/images.md).

## 7. Integrating work

Each task works on branch `wisp/<id>-<words>` — the words are a readable tag
derived from the id, not from the prompt (`wisp show` prints worktree and
branch).

1. Review the diff: `git -C <repo> diff main...<branch>`.
2. Merge the branch locally into main yourself, or `wisp push <id>` to push
   it to origin. With auto-merge on, Wisp merges the PR itself; `wisp pr <id>`
   names what it is waiting for.
3. `wisp archive <id>` — cleanup + remove the worktree. It REFUSES on a
   running turn, a Stop still in progress, background work not yet verified
   stopped, unsaved work (dirty tree or unpushed commits), or auto-merge /
   auto-fix still watching an open PR (`wisp pr <id> merge off`, `fix off`):
   resolve the refusal and retry.
   `-f` kills a running turn and commits leftovers onto the branch as
   `wisp: uncommitted work at archive` (the branch is always kept). Teardown
   finishes in the background after the response; a failure lands in
   `state_detail`, and `wisp cleanup <id>` shows the step and its remedy.
   Archived tasks are read-only; the conversation still reads.
4. `wisp purge` permanently deletes archived task data (Git branches stay).
   Run it only when the user asks, after `wisp export <id>` to a private file
   if the history matters.

## 8. Failure literacy

States: `creating`, `running`, `done`, `needs-input`, `stuck` (reversible),
`failed`. `state_detail` names the cause; a `limit: ` prefix means a
quota/usage limit — switch harness or model, or wait for the quota window.
`needs-input` is the task waiting on you (a question, a stopped turn, a denied
permission); section 4 recovers a question `wisp result` does not show.
`wisp ls`/`show` may print `exited N` instead of `failed`: the turn delivered
its result but the harness CLI exited nonzero — check the diff before redoing
anything. Tasks NEVER silently succeed: a bare exit 0 with no parsed result is
recorded as a failure, so trust the state, not hopes.

## 9. Parallelism

Tasks run in parallel worktrees and don't collide on disk, but concurrent
tasks editing the same files will conflict at merge time: when launching them,
say so in each prompt and name the shared files to avoid. When main moves,
rebase task branches by sending a follow-up turn:
`wisp send <id> "rebase your branch onto origin/main and re-run the verification"`.

## 10. When you are the task's agent

`WISP_AGENT_TURN=1` beside `WISP_TASK_ID` in your environment means you are
running one of a Wisp task's turns. Follow the per-turn instructions Wisp
adds: `wisp brief set --stdin` when it asks for a brief (`wisp brief --help`),
and `wisp output add <image> --turn <n>` to show an image in your reply. For
follow-up after this turn ends, use `wisp workflow` rather than sleeping or a
background shell.

## Flags and reference files

`wisp help <command>` (or `wisp <command> --help`) prints the installed
version's exact usage and contacts no daemon; prefer it over any copied flag
list, this file's included. Read a reference only when the task needs it;
none is required up front:

- [references/cli.md](references/cli.md) — behavior and output beyond the
  help text: send and steer semantics, archive, cleanup, purge, retention,
  audit, workflows, briefs, auto-merge / auto-fix
- [references/images.md](references/images.md) — only when attaching files:
  per-harness delivery, limits, lifecycle
- [references/setup.md](references/setup.md) — only for install and daemon
  ops: supervision, config files, browser/Desktop setup, connections,
  projects, models/effort, the HTTP API
