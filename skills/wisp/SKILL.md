---
name: wisp
description: Delegate coding tasks to coding-agent harnesses (droid, claude, codex, cursor) on this machine through the Wisp daemon — isolated worktree per task, honest states, image attachments. Load whenever you want to hand off, parallelize, or supervise implementation work instead of doing it inline.
---

# Wisp — driving the task daemon

Wisp runs coding agents in isolated git worktrees (one per task) behind a
local daemon, wispd. Drive everything through the `wisp` CLI; the daemon owns
all state. Never edit a task worktree yourself except to review and merge.

## The core loop

    wisp doctor                                   # 0. daemon + harnesses healthy?
    wisp new <repo> "prompt" --harness droid      # 1. create (repo defaults to cwd)
    wisp wait <id> --timeout 900                  # 2. block until it settles
    wisp result <id>                              # 3. read the agent's answer
    wisp send <id> "message"                      # 4. steer (optional, repeatable)
    wisp archive <id>                             # 5. cleanup, after the work lands

## 1. Prerequisites

wispd must be running. `wisp doctor` checks harness CLIs, auth, git, config,
and daemon reachability, exiting nonzero and naming what failed. Daemon down →
start it under the host's supervisor, never a bare `wisp serve &` (recipes:
[references/setup.md](references/setup.md)).

## 2. Creating tasks

    wisp new <repo> "prompt" --harness <droid|claude|codex|cursor>
        [--model <m>] [--effort <level>] [--local] [--image <path>]…

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
  removes anything). More harnesses: `~/.wisp/adapters.json`.

## 3. Waiting for a task

    wisp wait <id> [--timeout <sec>]

Exit codes: 0 done · 2 needs-input · 1 failed · 3 timeout. This is THE way to
await a task: it blocks, burns no tokens, and waits through `stuck` (a quiet
task often comes back). NEVER tail logs or poll `wisp ls` to wait. Push-based
alternative: `webhooks` in `~/.wisp/config.json` POSTs every done /
needs-input / stuck / failed transition at-least-once (dedup on task_id+seq).

## 4. Reading results

- `wisp result <id> [turn]` — the agent's full answer (default: latest turn).
  Read this first.
- `wisp show <id>` — state, state_detail, per-turn model/usage/attachments,
  worktree + branch, diffstat.
- `wisp log <id> [turn] [-f] [--raw]` — the activity feed. Only when debugging
  the agent's behavior, never for waiting or for the final answer.

## 5. Steering

- `wisp send <id> "message" [--image <path>]…` — a follow-up turn in the same
  session (the harness remembers prior turns; send also re-arms a done task).
- `wisp interrupt <id>` — stop a runaway turn. The session survives.
- `wisp fresh <id>` — the next turn starts a fresh harness session.

## 6. Image attachments

    wisp new <repo> "fix the layout bug in this screenshot" --harness codex --image ./shot.png
    wisp send <id> "now compare against this mock" --image ./mock.png

`--image` repeats — up to 10 files per turn, 5 MB each, png/jpeg/gif/webp
(detected by magic bytes, not the extension). All four builtin harnesses
accept images; droid/cursor receive them as file paths to read (png/jpeg
only), claude/codex get them natively. Images are stored outside the worktree
and never appear in the task's diff. Delivery, limits, and lifecycle:
[references/images.md](references/images.md).

## 7. Integrating work

Each task works on branch `wisp/<id>-<slug>` (`wisp show` prints worktree and
branch).

1. Review the diff: `git -C <repo> diff main...<branch>`.
2. Merge the branch locally into main yourself, or `wisp push <id>` to push
   it to origin.
3. `wisp archive <id>` — cleanup + remove the worktree. It REFUSES on unsaved
   work (dirty tree or unpushed commits): resolve the refusal and retry.
   `-f` kills a running turn and commits leftovers onto the branch as
   `wisp: uncommitted work at archive` (the branch is always kept). Teardown
   finishes in the background after the response; a failure lands in
   `state_detail`. Archived tasks are read-only; the conversation still reads.

## 8. Failure literacy

States: `creating`, `running`, `done`, `needs-input`, `stuck` (reversible),
`failed`. `state_detail` names the cause; a `limit: ` prefix means a
quota/usage limit — switch harness or model, or wait for the quota window.
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

## Reference files

- [references/cli.md](references/cli.md) — every command, flag, and output
- [references/images.md](references/images.md) — image attachments in full
- [references/setup.md](references/setup.md) — daemon ops, config files,
  projects, models/effort, the HTTP API
