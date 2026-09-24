# Auto-merge and auto-fix

Two switches on a task, with nothing to configure:

- **Auto-merge**: Wisp merges the task's pull request once it is ready.
- **Auto-fix**: when the PR's CI fails, it conflicts with its base, or a
  reviewer leaves feedback, Wisp sends it back to the task's agent to fix.

Turn either on when you create the task (the new-task dialog's PR picker, or
`--auto-merge` / `--auto-fix`), from the task's `…` menu, or with `wisp pr` at
any point after:

```sh
wisp new . "Fix the flaky retry test, open a PR" --harness claude --auto-merge --auto-fix
wisp pr <task>               # status and the reason it is waiting
wisp pr <task> merge on      # or: merge off
wisp pr <task> fix on        # or: fix off
wisp pr <task> send-now      # send a waiting auto-fix round at once
wisp pr <task> skip          # never send that round
wisp pr <task> resume        # after a pause, or to release a Stop hold early
```

While either one needs you (or has paused), the task's PR icon in the sidebar
turns red and its hover says why, and the desktop app posts a banner; it posts
one too when Wisp merges the PR.

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

**After a merge, both switches stay on for the task's next PR.** Wisp then
adopts a PR you open from this task after the merged one was opened — the
task's next change, or a PR that was stacked on the merged one — and never an
older open PR, which is stale or abandoned. Everything about the merged PR
(its rounds, reruns, and the review feedback already sent) is left behind, so
the next PR starts with a fresh three-round budget. The status reads
`#271 merged by Wisp · Waiting for the task's next PR` until it binds.

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
- **Archiving** the task switches it off. While it is watching a PR, archive
  asks first ("Archive anyway", or `wisp archive -f`); anything unsaved in the
  worktree is still checked separately.
- **Closing the PR** switches both off: that is how you abandon an approach,
  so Wisp does not move on to another PR.
- **Pauses**, which need `resume`: a merge that failed three times on the same
  head, and GitHub's own auto-merge found switched on for the PR. A paused
  task still notices when its PR is merged (and carries on with the next PR)
  or closed.

## Auto-fix

When a check that counts is red on the PR's current head — or the PR conflicts
with its base — and the task is idle, Wisp sends the agent one **round**: a
short message pointing at a `PR-FEEDBACK.md` file beside the task's data (never
in the worktree). The file lists what failed and ends with the logs that
explain it: each failing GitHub Actions job's log from the first step that
failed to its last error (runner setup and checkout before it are cut), or a
non-Actions check's own report. A round is about the red check
and the jobs that failed beside it in the same workflow run, so when the
required check is an aggregator (a `test` job that needs six shards) the agent
also reads the shard that failed, not only the aggregator's "a required part
did not succeed". When a run has a real failure, the jobs fail-fast cancelled
are left out. Other red checks, ones that do not count or are red on the base
too, are listed as context, without their logs.

- **Only counting checks decide.** With required checks on the base, only they
  do; with none, every check does. A red whose failed jobs are all red on the
  base branch too is not the PR's to fix.
- **All results at once.** A round waits until every counting check on the
  head has finished, and every job in a failing run, so the agent gets the
  whole picture in one turn. It does not wait for checks that do not count.
  When the comparison with the base depends on a base job that is still
  running, Wisp waits for it.
- **Token-free retries first.** A workflow run whose jobs were cancelled with
  no real failure among them (a lost runner, a superseded run) has them rerun
  once per head before anyone spends a turn on it. Without required checks, a
  run with a real failure gets that one free retry too, in case it was a
  flake. Wisp only reruns ordinary `pull_request` runs, never a run with a
  deployment job in it. A job held for approval, or waiting on an
  environment's reviewers, needs you.
- **Worth a turn.** If GitHub cannot serve any of a round's logs yet, Wisp
  looks again a few times before sending the round with the links only. With
  every task slot taken, a round waits for a free one. A turn that starts
  while a round is being prepared wins, and the round is planned again after
  it.
- **A short delay.** A round waits two minutes after the task's latest turn
  ends, so you can read what it did and steer it yourself first; a turn of
  yours restarts the delay. **Send now** skips the wait for that round;
  **Skip** means that evidence is never sent (a later push brings new
  evidence, and a round again). Cancelling a queued round from the message list
  is the same as Skip. **Stop** withdraws a round that has not started, and
  holds auto-fix like auto-merge.
- **Never twice, and never forever.** The same evidence is sent once: if the
  agent's turn ends without a push and the check is still red, Wisp says so
  and waits for you instead of repeating itself. After three rounds on one PR
  it pauses; **Resume** gives it three more.
- **Never mid-turn**, and a user message queued first still goes first.

With both switches on, auto-fix acts first: nothing merges while a check is
red, and once the agent's fix is green, auto-merge takes over.

### Review feedback

Auto-fix also sends the agent review feedback it has not seen yet. That covers:

- review threads;
- reviews with a body: a blocking or unreadable `Verdict:` line, a change
  request, or plain comments;
- conversation comments.

CI failures and review feedback go out together as one round, and share the
three-round budget. Review feedback is not held back while CI is still
running.

- **Whose words count.**
  - The PR owner's account counts, since reviewer agents post as you.
  - So does any bot except `github-actions`.
  - So does anyone who can push to the repository (write, maintain or admin,
    looked up and cached for an hour). A `MEMBER` association alone does not
    count: it can mean read access.
  - Everyone else's feedback still blocks the merge where GitHub says so, but
    it never instructs the agent. Neither does a bot that is only answering
    them in a thread.
- **Not noise.**
  - An approval is a merge signal, not something to fix.
  - A "LGTM", a "thanks" or a 👍, as a comment, a review or a thread reply,
    asks for nothing.
  - A bot's review body is its overview; its threads are the feedback.
  - Draft review comments you have not submitted, and comments a maintainer
    hid, never count.
  - A bot's conversation comment is usually a status board it edits on every
    push, so it counts only when the same app's check on the head is red
    (then once per head) or when it says "blocking".
- **Never its own words.** While auto-fix is on, every turn is asked to end
  each GitHub comment, review or reply with `— <agent> via Wisp <!--
  wisp:task=<id> -->`, and Wisp never sends signed posts back (a quote of one
  is someone answering it, and counts). A comment from your account written
  during one of the task's turns that was never asked to sign counts as the
  agent's too: turns from before auto-fix was on, and slash-command turns,
  which cannot carry the note.
- **Once.** Each thread, review and comment is sent once. A new reply or an
  edit makes it new again. A thread that was resolved after Wisp sent it
  comes back when a trusted reply arrives on it ("still wrong"). **Skip**, or
  cancelling the queued round, marks the batch as seen.
- **A burst goes as one.** A round waits two minutes after the newest
  feedback as well as after the task's turn, so a reviewer's many comments
  arrive together.
- **Resolving threads.** The agent may resolve a thread started by you or by a
  bot, once it has pushed a fix for it. It replies "Addressed in <sha>" on
  anyone else's thread and never resolves it. It never resolves a thread it
  disagreed with; it says so in its final message instead. What it cannot
  resolve stays for you: while a thread Wisp sent (or you skipped) is still
  open, the status says so and nothing merges, whether or not the repository
  requires conversations to be resolved.
- **Big PRs.** Wisp reads the newest 100 review threads, the newest 30
  comments in each, and the newest 100 conversation comments; the evidence
  says when there were more.

## How often it checks

Wisp checks an armed task's PR about once a minute while something is
moving: checks running, a fresh head, a merge queue. It checks every five
minutes when it is waiting on a person, and every twenty while the task is
busy. A task that settles is checked at once. It reads GitHub through the
daemon host's authenticated `gh`, and a failed read backs off without an
agent turn.

