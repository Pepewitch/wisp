# Supervising tasks

For tasks that already exist (yours, another agent's, or a person's) and for
watching several at once. The loop itself, and the rule against waiting by
polling, are in [SKILL.md](../SKILL.md).

## Reading a task

`wisp result <id>` prints the newest turn that has a result. When a later turn
has none yet (it is still running, or it ended without one), that is an older
answer, so check the turn number in the `── you (turn N) ──` header before
acting on it. Open `wisp log` only when the result is not enough.

Cheaper views, each answering one question:

- `wisp brief show <id>`: the agent's own short report, when briefs are on;
  check it against the result and the diff ([briefs](cli.md#task-briefs)).
- `wisp pr <id>`: what auto-merge or auto-fix is waiting for.
- `wisp audit <id>`: who did what to the task, and when.
- `wisp search <text>`: find a task by exact text (`-a` includes archived).

## Steering

`wisp send`, `wisp interrupt`, and `wisp fresh` steer from the CLI;
[cli.md](cli.md#tasks) says how a message reaches a running turn and what
each command leaves running. Switching an existing task's harness, model, or
effort happens in the browser or Desktop composer, or through the API
([cli.md](cli.md#tasks)). From the CLI alone, ask the user to switch it, or
start a new task from the old task's branch with
`wisp new <repo> "<prompt>" --harness <h> --base <branch>`; only committed
work carries over. After a harness switch the new agent starts without the
old context, so restate the goal in the next message as you would in a new
prompt.

## Being told instead of checking

- `webhooks` in `~/.wisp/config.json` POST task state changes to your URLs
  ([setup.md](setup.md) lists which).
- `wisp workflow` attaches durable follow-up to a task: `schedule-steer`
  sends one message at a set time, and `heartbeat` wakes the agent on a
  timer, which can spend tokens on every wake ([workflows](cli.md#workflows)).
