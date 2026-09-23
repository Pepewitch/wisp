# Auto-merge

Switch on **Auto-merge** for a task, and Wisp merges the task's pull request
once it is ready. There is nothing to configure. Arm it when you create the
task, or at any point after:

```sh
wisp new . "Fix the flaky retry test, open a PR" --harness claude --auto-merge
wisp pr <task>               # status and the reason it is waiting
wisp pr <task> merge on      # or: merge off
wisp pr <task> resume        # after a pause, or to release a Stop hold early
```

Auto-merge merges into the branch it targets under your GitHub account.
Arm it for work you would merge yourself once CI is green; leave it off for
critical changes you want to read first.

## What the agent is told

While auto-merge is on, every turn Wisp starts carries one standing note:
push the branch and open a pull request when the work is ready, and leave the
merge to Wisp. The note overrides the default "do not push unless asked",
because turning auto-merge on *is* asking. It is scoped to this task's PR, so an
agent that manages other PRs can still merge them. After a merge, the
agent's next turn is told once that the branch is finished and further work
belongs on a new branch from the base.

## When Wisp merges

Wisp re-reads all of these immediately before merging. The first one that does
not hold is the reason shown in `wisp pr` and next to the PR in the app.

- **The PR** is open, not a draft, from this repository, and targets the default
  branch or the project's configured base. A stacked PR waits until its parent
  has merged.
- **Checks.** If the base branch has required checks, only they count, and a red
  check that is not required does not stop the merge. If it has none, every
  check counts. A new head gets two minutes, and every GitHub Actions run on
  it must finish, before a green (or empty) result is believed.
- **Reviews.** A reviewer who blocked, with a change request or a
  `Verdict: CHANGES REQUESTED` line, must pass the *current* head before it
  merges; an approval of an older head does not count. There is no timer. A
  verdict line Wisp cannot read counts as blocking. Only the repository owner,
  collaborators, organization members, and installed apps count as reviewers.
- **GitHub agrees.** Conflicts, an out-of-date branch, and unresolved
  conversations all wait, and the reason names which.
- **The task is idle:** settled `done`, with nothing queued, stopping, or still
  running in the background. Wisp never merges mid-turn.
- **Nothing is left behind.** The worktree has no commits the PR lacks and no
  uncommitted changes to tracked files. Untracked files are ignored.

Wisp merges with squash when the repository allows it, and otherwise with the
only method it allows. It runs `gh pr merge --match-head-commit <sha>`, so a
push in the last moment makes the merge refuse instead of merging something
unchecked. It never uses `--admin` and never deletes the branch (the task's
worktree is on it). New turns wait while the merge runs.

## Stop, agent changes, archive

- **Stop** holds auto-merge until your next turn has finished; then it carries
  on by itself. `wisp pr <task> resume` releases the hold at once.
- **Changing the agent, model, or effort, or starting a fresh session**, does
  not switch it off.
- **Archiving** the task switches it off.
- **Closing the PR** switches it off. Wisp never moves on to another PR.
- **Pauses**, which need `resume`: a merge that failed three times on the same
  head, and GitHub's own auto-merge found switched on for the PR.

## How often it checks

Wisp checks an armed task's PR about once a minute while something is
moving: checks running, a fresh head, a merge queue. It checks every five
minutes when it is waiting on a person, and every twenty while the task is
busy. A task that settles is checked at once. It reads GitHub through the
daemon host's authenticated `gh`, and a failed read backs off without an
agent turn.

Auto-fix, which steers an idle task to fix a red check or answer review
feedback, is planned and not available yet.
