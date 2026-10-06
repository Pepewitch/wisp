---
name: wisp
description: Delegate coding tasks to coding-agent harnesses (droid, claude, codex, cursor, opencode) through a Wisp daemon — a separate worktree per task (checkout separation, not a sandbox), honest states, attachments. Load whenever you want to hand off, parallelize, or supervise implementation work instead of doing it inline, including checking on, answering, steering, or landing tasks that already exist; also covers the optional browser and desktop operator interfaces. Not for changing Wisp's own code; use wisp-dev for that.
---

# Wisp — driving the task daemon

Wisp runs each task's coding agent in its own git worktree behind a daemon,
wispd, which owns all state; drive it through the `wisp` CLI. Never edit a
task's worktree: review it, and land its branch from your own checkout.

A worktree is checkout separation, **not a sandbox**: the agent runs as the
daemon's user, with its credentials and network, and can write outside the
worktree; a prompt saying "work only here" enforces nothing. Use a separate
OS account or a disposable VM for untrusted repos.

## Prompts

Prompts must be self-contained: the task's agent sees only the repository,
and no conversation carries over. Restate the goal, the relevant paths, and
the constraints; name the exact test or build that proves the change; and say
"commit your changes to the task branch when done". When tasks run in
parallel, name in each prompt the files the others will change. Inside double
quotes the shell runs backticks and expands `$`, so put a long prompt in a
file outside the repository and pass it as `"$(cat <file>)"`.

## Delegate: you start the task and need its outcome

    wisp doctor                                 # daemon and harnesses healthy?
    wisp new <repo> "prompt" --harness droid    # prints the task id
    wisp wait <id> --timeout 300                # 0 done · 2 needs-input · 1 failed or error · 3 timed out
    wisp result <id>                            # the agent's answer
    wisp send <id> "message"                    # steer or continue (optional)
    wisp archive <id>                           # only after the work has landed

## Supervise: the tasks already exist, or you watch several

    wisp ls                                     # every task: state, turn, state_detail
    wisp show <id>                              # turns, branch, diffstat, background work
    wisp result <id> [turn]                     # check which turn it printed
    wisp send <id> "message"                    # answer or steer; never stops work
    wisp interrupt <id>                         # stop a runaway turn; the session survives

Take one snapshot, act on what needs you, and stop; the next check starts
again from `wisp ls`. Inside a Wisp task, `$WISP_TASK_ID` is your own task:
leave it alone. Never poll `wisp ls` or tail `wisp log` to wait: `wisp wait`
blocks without spending tokens. Give it a `--timeout` shorter than your own
command time limit (without one it waits about a day). Exit 3 means the wait
timed out, not that the task failed; on exit 1 the printed line says whether
the task failed or the CLI hit an error, such as an unreachable daemon.
Report what you found or do other work rather than re-waiting in a loop.

## States

- `creating`, `running`: nothing needs you yet.
- [`done`](references/integrating.md): read the result. Land and archive only tasks you started or were asked to land; report the rest.
- [`needs-input`](references/needs-input.md): waiting on you, even when no question shows.
- [`stuck`](references/failures.md#stuck): quiet for a while, or a Stop that did not finish.
- [`failed`](references/failures.md#failed): `state_detail` names the cause.
- [`exited N`](references/failures.md#exited-n): `failed`, but with a result; review it before redoing.

## Flags and references

`wisp help <command>` prints the installed version's exact usage, even with
the daemon down. It is authoritative for flags: trust it over any copied list,
this file's included. Read a reference only when its trigger applies:

- [supervise.md](references/supervise.md): tasks you did not just start, or
  several at once; steering, switching harness or model, briefs, webhooks
- [needs-input.md](references/needs-input.md): a task is `needs-input`,
  especially when no question shows
- [failures.md](references/failures.md): a task is `stuck`, `failed`, or
  `exited N`
- [integrating.md](references/integrating.md): a task is `done` and its work
  should land; auto-merge, auto-fix, archive refusals, purge, merge conflicts
- [cli.md](references/cli.md): what a command or flag does beyond its help
  text, such as `--base`, `--fast`, `--brief`, `--local`, or `wisp workflow`
- [images.md](references/images.md): attaching files with `--attach`
- [setup.md](references/setup.md): `wisp doctor` fails or the daemon is down;
  install, config, models and effort, browser and Desktop, the HTTP API
