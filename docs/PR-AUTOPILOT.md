# Auto-merge and auto-fix

Two switches on a task, with nothing to configure:

- **Auto-merge**: Wisp merges the task's pull request once it is ready.
- **Auto-fix**: when the PR's CI fails or it conflicts with its base, Wisp
  sends the failure back to the task's agent to fix.

Turn either on when you create the task, from the task's `…` menu, or with
`wisp pr` at any point after:

```sh
wisp new . "Fix the flaky retry test, open a PR" --harness claude --auto-merge --auto-fix
wisp pr <task>               # status and the reason it is waiting
wisp pr <task> merge on      # or: merge off
wisp pr <task> fix on        # or: fix off
wisp pr <task> send-now      # send a waiting auto-fix round at once
wisp pr <task> skip          # never send that round
wisp pr <task> resume        # after a pause, or to release a Stop hold early
```

Auto-merge merges into the branch it targets under your GitHub account.
Arm it for work you would merge yourself once CI is green; leave it off for
critical changes you want to read first.

## What the agent is told

While auto-merge is on, every turn Wisp starts carries one standing note (except
a turn whose message is a slash command, which a harness only recognises at the
very start of its prompt; the note rides the next ordinary turn instead):
push the branch and open a pull request when the work is ready, and leave the
merge to Wisp. The note overrides the default "do not push unless asked",
because turning auto-merge on *is* asking. It is scoped to this task's PR, so an
agent that manages other PRs can still merge them. After a merge, the
agent's next turn is told once that the branch is finished and further work
belongs on a new branch from the base.

## Which PR

Auto-merge binds to one pull request: the task's own, meaning one **you** opened
(the account `gh` is signed in as) **after the task was created**, from this
repository. A worktree can check out anyone's branch, and Wisp never adopts
someone else's PR. It prefers the task's own branch, then the oldest PR onto the
base. `wisp pr <task>` and the task menu name the PR it is bound to.

## When Wisp merges

Wisp re-reads all of these immediately before merging. The first one that does
not hold is the reason shown in `wisp pr` and next to the PR in the app.

- **The PR** is open, not a draft, from this repository, and targets the default
  branch or the project's configured base. A stacked PR waits until its parent
  has merged.
- **Checks.** If the base branch has required checks, only they count, and a red
  check that is not required does not stop the merge. If it has none, every
  check counts, and GitHub reporting the PR as unstable is never read as
  mergeable. A new head — or a draft just marked ready — gets two minutes, and
  every GitHub Actions run on it must finish, before a green (or empty) result
  is believed. More checks than one page of results holds is refused rather
  than half-read.
- **Reviews.** A reviewer who blocked, with a change request or a
  `Verdict: CHANGES REQUESTED` line anywhere in the review, must pass the
  *current* head before it merges; an approval of an older head does not count.
  There is no timer. Only a plain `Verdict: APPROVE` approves: any request for
  changes in the line blocks, even after an approving word, an approval with a
  condition ("…, but fix X first") does not count, and a verdict line Wisp
  cannot read counts as blocking. A verdict quoted from an earlier round
  (`> Verdict: …`) is ignored, and when a review has several, the least
  approving one wins. Only the repository owner,
  collaborators, organization members, and installed apps count as reviewers.
- **GitHub agrees.** Conflicts, an out-of-date branch, and unresolved
  conversations all wait, and the reason names which.
- **The task is idle:** settled `done`, with nothing queued, stopping, or still
  running in the background. Wisp never merges mid-turn.
- **Nothing is left behind.** No local branch, and not the worktree's HEAD, holds
  commits built on the PR that exist on no remote; there are no uncommitted
  changes to tracked files and no rebase or merge in progress. A stacked child
  you pushed for its own PR does not count, and untracked files are ignored.
  Anything Wisp cannot verify counts as not ready.

Wisp merges with squash when the repository allows it, and otherwise with the
only method it allows. It runs `gh pr merge --match-head-commit <sha>`, so a
push in the last moment makes the merge refuse instead of merging something
unchecked. It never uses `--admin` and never deletes the branch (the task's
worktree is on it). New turns wait while the merge runs, and the first one
after it hears how the merge ended.

## Stop, agent changes, archive

- **Stop** holds auto-merge until your next turn has finished; then it carries
  on by itself. `wisp pr <task> resume` releases the hold at once.
- **Changing the agent, model, or effort, or starting a fresh session**, does
  not switch it off.
- **Archiving** the task switches it off.
- **Closing the PR** switches it off. Wisp never moves on to another PR.
- **Pauses**, which need `resume`: a merge that failed three times on the same
  head, and GitHub's own auto-merge found switched on for the PR. A paused
  task still notices when its PR is merged or closed.

## Auto-fix

When a check that counts is red on the PR's current head — or the PR conflicts
with its base — and the task is idle, Wisp sends the agent one **round**: a
short message pointing at a `PR-FEEDBACK.md` file beside the task's data (never
in the worktree). The file lists the failing checks and ends with the logs
that explain them: the end of each failing GitHub Actions job's log, cut where
it errors, or a non-Actions check's own report. It holds every failing job on
the head, so when the required check is an aggregator (a `test` job that needs
six shards) the agent still reads the shard that failed.

- **Only counting checks decide.** With required checks on the base, only they
  do; with none, every check does. A red that is also red on the base branch
  is not the PR's to fix.
- **All results at once.** A round waits until every counting check on the
  head has finished, so the agent gets the whole picture in one turn.
- **Token-free retries first.** A cancelled job is rerun once before anyone
  spends a turn on it; without required checks, so is a failed one (a flake
  gets one free retry). Wisp only reruns ordinary `pull_request` jobs, never a
  deployment. A job held for an environment's approval needs you.
- **A short delay.** A round waits two minutes after the task goes idle, so you
  can read what it did and steer it yourself first. **Send now** skips the
  wait; **Skip** means that evidence is never sent (a later push brings new
  evidence, and a round again). Cancelling a queued round from the message list
  is the same as Skip.
- **Never twice, and never forever.** The same evidence is sent once: if the
  agent's turn ends without a push and the check is still red, Wisp says so
  and waits for you instead of repeating itself. After three rounds on one PR
  it pauses; **Resume** gives it three more.
- **Never mid-turn**, and a user message queued first still goes first.

With both switches on, auto-fix acts first: nothing merges while a check is
red, and once the agent's fix is green, auto-merge takes over. Auto-fix for
review feedback is planned.

## How often it checks

Wisp checks an armed task's PR about once a minute while something is
moving: checks running, a fresh head, a merge queue. It checks every five
minutes when it is waiting on a person, and every twenty while the task is
busy. A task that settles is checked at once. It reads GitHub through the
daemon host's authenticated `gh`, and a failed read backs off without an
agent turn.

