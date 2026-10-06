# Landing a task's work

Each task works on branch `wisp/<id>-<words>`; the words are a readable tag
derived from the id, not from the prompt. `wisp show <id>` prints the worktree
and branch.

1. Review the diff: `git -C <repo> diff main...<branch>`.
2. Merge the branch locally into main yourself, or `wisp push <id>` to push it
   to origin.
3. `wisp archive <id>` once the work has landed. It removes the worktree and
   keeps the branch and the conversation.

## Auto-merge and auto-fix

Arm `--auto-merge` (on `wisp new`, or `wisp pr <id> merge on` later) only for
work you would merge yourself on green, because Wisp then merges the PR
without asking. `--auto-fix` (`wisp pr <id> fix on`) hands red CI, merge
conflicts, and review feedback back to the agent. `wisp pr <id>` names what
either is waiting for; what each does and when:
[cli.md](cli.md#auto-merge-and-auto-fix).

## When archive refuses

The refusal names its reason. Resolve it and retry:

- A running turn or background work: let it finish, or `wisp interrupt <id>`.
- A Stop that has not finished: see [stuck](failures.md#stuck); `-f` does not
  override this one.
- Unsaved work (a dirty tree, or commits only the task branch holds): have the
  agent commit, then merge or push the branch.
- Auto-merge or auto-fix bound to a PR that is still open: wait until it
  merges or closes, or switch them off with `wisp pr <id> merge off` and
  `wisp pr <id> fix off`.

`-f` overrides the rest: it kills a running turn and commits leftovers onto
the branch, so use it only when that is what you want. Teardown then finishes
in the background; if a step fails, `wisp cleanup <id>` names the step and its
remedy. Exact behavior: [cli.md](cli.md#tasks).

`wisp purge` permanently deletes archived task data (Git branches stay). Run
it only when the user asks, after `wisp export <id>` to a private file if the
history matters.

## Parallel tasks

Tasks run in parallel worktrees and don't collide on disk, but concurrent
tasks editing the same files will conflict at merge time: when launching them,
say so in each prompt and name the shared files to avoid. When main moves,
rebase task branches by sending a follow-up turn:
`wisp send <id> "rebase your branch onto origin/main and re-run the verification"`.
