# Landing a task's work

Each task works on branch `wisp/<id>-<words>`; the words are a readable tag
derived from the id, not from the prompt. `wisp show <id>` prints the worktree
and branch.

1. Read `wisp result <id>`. If the agent already pushed, opened, or merged a
   PR, land through that PR, or there is nothing left to land.
2. Review the diff against the base the task forked from (the project's base
   branch, usually `main`, or the `--base` it was created with):
   `git -C <repo> diff <base>...<branch>`.
3. Merge the branch into its base yourself, or `wisp push <id>` to push it to
   origin.
4. `wisp archive <id>` once the work has landed. It removes the worktree and
   keeps the branch and the conversation.

## Auto-merge and auto-fix

Arm `--auto-merge` (on `wisp new`, or `wisp pr <id> merge on` later) only for
work you would merge yourself on green, because Wisp then merges the PR
without asking. `--auto-fix` (`wisp pr <id> fix on`) hands red CI, merge
conflicts, and review feedback back to the agent. `wisp pr <id>` names what
either is waiting for; what each does and when:
[cli.md](cli.md#auto-merge-and-auto-fix).

## When archive refuses

The refusal names its reason, and [cli.md](cli.md#tasks) has the exact rules.
Resolve it and retry:

- A running turn or background work: let it finish, or `wisp interrupt <id>`.
- A Stop that has not finished: see [stuck](failures.md#stuck); `-f` does not
  override this one.
- Unsaved work (a dirty tree, or commits only the task branch holds): have the
  agent commit, then merge or push the branch.
- Auto-merge or auto-fix bound to a PR that is still open: wait until it
  merges or closes, or switch them off with `wisp pr <id> merge off` and
  `wisp pr <id> fix off`.
- Git cannot read the worktree's status: repair the repository first;
  `-f` does not override this one either.

`-f` overrides the others: it kills a running turn and commits leftovers onto
the branch, so use it only when that is what you want, and on a task you did
not start only when the user says so. Teardown then finishes in the
background; if a step fails, `wisp cleanup <id>` names the step and its
remedy.

`wisp purge` permanently deletes archived task data (Git branches stay). Run
it only when the user asks, after `wisp export <id>` to a private file if the
history matters.

## Merge conflicts between parallel tasks

Tasks run in parallel worktrees and don't collide on disk, but concurrent
tasks editing the same files conflict at merge time. When the base moves,
rebase task branches by sending a follow-up turn:
`wisp send <id> "rebase your branch onto origin/main and re-run the verification"`.
