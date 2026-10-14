# Auto-review

Auto-review is the third switch on a task, beside auto-merge and auto-fix.
With it on, nothing merges on the author's word, a green CI run or a passing
unit test alone. Each head of the task's pull request gets its own review
round. Fresh reviewer agents, each in its own worktree at that head, check two
things: that the change works when you run it, and that its code is good
enough to merge.

```sh
wisp new . "Add a dark mode toggle, open a PR" --harness claude --auto-merge --auto-fix --auto-review
wisp pr <task> review on          # or: review off
wisp review show <task>           # the rounds for the task's current PR, newest first (--pr <n> or --all for others)
wisp review show <task> --round 2 # one round in full: each reviewer's verdict, findings, evidence
wisp review rubric                # the rubric reviewers judge by, with this project's own rules
```

In the app, **Auto-review** is a switch in the task's Autopilot tab, its `…`
menu, and the new-task dialog's PR picker. The tab lists the rounds under the
switches: each round's depth, and one line per reviewer that opens its task.

## The panel

| Reviewer | Does | Runs on |
| --- | --- | --- |
| **A** | Verifies the change by running it (launch, drive, screenshots) **and** reviews its code | the project's reviewer agent (Project settings → Verification), else the author task's own agent |
| **B** | Reviews the code only: reads the diff, runs targeted tests; never launches the app | the project's second reviewer; by default the same agent as A in its own session, or **Off** |

A round passes only when **every reviewer on its panel passes**. Two good
models agreeing that nothing blocks is the bar; pick a different agent for B
in Project settings → Verification to get a real second opinion. **Off** makes
every round single-reviewer.

**Depth, measured by Wisp.** Before a round starts, Wisp measures the diff (it
fetches the PR's head and base first) and picks a tier. Reviewers are told the
tier, and never to ask anyone how deep to go:

| Tier | When | Panel |
| --- | --- | --- |
| light | docs only (`docs/**`, top-level `*.md`, or the recipe's `docs:`), or ≤ 40 changed lines in ≤ 3 files inside one area (anywhere, in a project whose recipe maps no areas) | A only; A may **escalate** to add B to the same round |
| standard | everything else | A and B |
| deep | a sensitive path (migrations, auth, security, secrets, CI, Dockerfiles, dependency manifests, infra, agent instructions such as `AGENTS.md` and `SKILL.md`, or the recipe's `sensitive:`), > 600 lines, > 25 files, ≥ 3 areas, or a diff Wisp could not read | A and B |

Lockfile lines are not counted (their manifest is what is sensitive). A rename
is matched by both its old and its new path. Within one PR a tier only goes up.

## How a round goes

1. **The author opens a PR.** While auto-review is on, every turn of the task
   tells its agent that reviewers will check the head, that the project's
   verification recipe and Wisp's rubric are the bar (`wisp verify show`,
   `wisp review rubric`), and to open a pull request when the work is ready.
2. **The head goes green.** Auto-review waits for the PR's checks the way the
   merge gate does: no reviewer is spent on a red or running head. With
   auto-fix on, a red check goes back to the author first.
3. **The round is written with its whole panel**, then each reviewer starts
   when a task slot is free: `Auto-review A · PR #7 · round 1 · abc1234`, then
   `Auto-review B …`. A reviewer that cannot start yet waits on the round; the
   panel never shrinks to pass sooner. Nothing a reviewer does reaches the
   author's branch, and it never commits, pushes or comments on the PR.
4. **Each reviewer submits its verdict** with `wisp review submit`. Images A
   published with `wisp output add` are attached as evidence. While the round
   is open, neither reviewer can read the other's verdict.
5. **Wisp settles the round** once every reviewer has ended, and archives each
   reviewer once its turn ends, or five minutes after its verdict if the turn
   has not (its transcript stays readable under archived tasks). A reviewer whose round no longer matters (auto-review switched off,
   the PR closed, the task archived) is stopped and archived the same way.

A push while a round runs makes it moot: its reviewers are stopped at once,
even while the author is still working, and the new head gets a fresh round.
A pass belongs to the base it was reviewed against: retarget the PR to another
base and the same head is reviewed again before anything merges. A PR from a
fork is not supported by autopilot at all, so it never gets a reviewer.

## The rubric

Both reviewers judge by the same rubric, given to the author too:
correctness, architecture, slop, security, performance (hot paths only),
tests and docs, plus verification for reviewer A. Each lens says what
**blocks** a merge and what is only a **note**. The rules that keep two
reviewers from becoming two vetoes on taste:

- Only an issue this diff introduces or makes reachable can block.
  Pre-existing problems are notes. Style, naming, verbosity and requests
  beyond the PR's goal never block.
- A blocker names its lens, says what goes wrong and how it is reached, and on
  code names its file (and line).
- A failing test blocks only if it does not fail on the base too.
- From round 2 on, a new blocker must be on code changed since the last
  reviewed head, or be a correctness, data-loss or security problem.

A project adds its own rules in its recipe (below); they add to the rubric and
cannot turn the panel or these rules off.

## Verdicts and the round's outcome

Each reviewer says `pass` (nothing blocks; notes are fine), `fail` (at least
one blocking finding), or `inconclusive` with cause `change` (the change kept
it from being judged) or, for A only, cause `recipe` (the recipe failed it).
The round's outcome, in this order:

1. **Any blocking finding** from either reviewer → rejected. If A also could
   not follow the recipe, Wisp starts fixing the recipe alongside.
2. **A could not follow the recipe** → the PR is held. See
   [A broken recipe](#a-broken-recipe).
3. **A reviewer gave no verdict** → the task needs you; **Resume** re-runs only
   that reviewer.
4. **An inconclusive change** → rejected.
5. **Every reviewer passed** → passed. Auto-merge merges once its own gate
   allows; with auto-review alone, the task is done for this head.

Passing CI, passing unit tests, or a PR description that says it works is
never enough for a pass. A change to a screen needs screenshots of that screen.

**Back to the author.** A rejection is sent once per round as
`[Wisp auto-review · PR #7 · round 1 of 3 · head abc1234]`, pointing at a
`REVIEW-FEEDBACK.md` beside the task's data (never in its worktree): both
reviewers' findings grouped by file, blockers first, each saying which
reviewer found it. Up to six screenshots are attached when the author's agent
can take images. If the author's turn ends with no new push, the task needs
you ("Still rejected after review round 1, with no new push"). The author's
final message goes to the next round's reviewers, who must address each
earlier blocker.

**Three rounds per PR.** After three counted rounds that did not pass, auto-review
pauses. **Resume** gives it three more, and the numbering goes on ("round 4 of 6").
A new PR after a merge starts at round 1 again. Expect up to two reviewer tasks
a round.

**Ask again without a push.** When a rejection needs you, **Resume** (in the
Autopilot tab, or `wisp pr <task> resume`) re-runs the reviewers that did not
pass, on the same head, without spending a round; a reviewer that passed is
kept.

**A reviewer never waits on a person.** A reviewer that asks a question, or
ends a turn without a verdict, gets one answer from Wisp: decide, note what you
assumed, and submit. A question goes back through the harness's own question
channel where it has one, so the same turn carries on; otherwise as a message. The second time, or past its tier's time limit (30, 60 or
120 minutes for light, standard and deep), its part ends as an error.

Only a reviewer can submit its own verdict. Each reviewer has a token that only
its own turns carry (`WISP_REVIEW_TOKEN`), and it dies with that verdict. That
stops an agent from passing its own work by mistake or as a shortcut. It is not
a security boundary against a hostile agent on the same machine, which already
holds the daemon's token.

Rounds from before the panel stay as they were: one reviewer, no tier, shown as
such.

## The verification recipe

The recipe is how a reviewer builds, launches and drives the project, and what
proves a change works there. The author's turns are pointed at the same recipe,
so both sides work to one bar.

**It lives in Wisp, never in the repository.** The people you share a repository
with have their own workflow and tools, so Wisp keeps the recipe in its own home:

```
~/.wisp/projects/<project>-<hash>/
  verify/                 the active recipe (Wisp commits each activation to a local git history)
    RECIPE.md             the project: its areas, the checks every change must pass, what to know first
    areas/<name>/AREA.md  one runnable surface (a web app, an API, a CLI); frontmatter names the paths it covers
    areas/<name>/features/*.md   one user-facing feature each: how to reach it, drive it, and what proves it works
    areas/<name>/helpers/*       scripts the area calls
  drafts/<task>/          a recipe task's proposal, waiting for you to activate it
```

An area starts with frontmatter naming the repository paths it covers and
whether its recipe was proven end to end:

```markdown
---
paths: apps/web/**, packages/ui/**
status: proven
---
```

Then come its sections: Launch, Health check, Drive, Evidence and Cleanup.

`RECIPE.md` may carry a `## Review rules` section: this project's own
conventions reviewers hold a change to (from its AGENTS.md, CONTRIBUTING, lint
config), at most 8 KiB. An `AREA.md` may have its own, given to reviewers only
when the diff touches that area. `RECIPE.md` may also start with frontmatter
naming paths that always need a deep review and paths that are documentation:

```markdown
---
sensitive: billing/**, auth/**
docs: docs/**, *.md
---
```
A monorepo usually has one area per app or service. A reviewer is handed
`RECIPE.md` and only the areas the PR's changed files fall in, so a one-line
API fix does not pull in the whole recipe. Changed files no area covers are
verified on the reviewer's judgment, and its verdict says which area should
cover them.

A project with no recipe still gets reviews: the reviewer works out how to run
the app from the repository and reports what it learned.

The recipe's shape follows the verification skills in
[pstack](https://github.com/cursor/plugins/tree/main/pstack), with one more
layer for monorepos.

### Set up, improve, fix

A recipe is written by a **recipe task**: an ordinary task you can watch and
steer, started for the project. It explores the repository, writes the recipe in
a scratch directory outside the worktree, and proves each area by following its
own instructions once: launch, health check, drive one feature, capture
evidence, clean up. It saves the result as a draft with `wisp verify draft save`.
It never commits, pushes or opens a pull request.

```sh
wisp verify status                     # the recipe, its areas, a draft, the recipe task at work
wisp verify setup --harness claude     # a task that writes the first recipe
wisp verify improve --note "also check dark mode"
wisp verify fix --area web             # a task that repairs one area a reviewer could not follow
wisp verify activate                   # make the newest draft the active recipe
wisp verify show [file]                # list the recipe's files, or print one
```

In the app, a project's **Verification** button in the sidebar opens its
settings at the Verification section. There you can start a recipe task, choose
the reviewer agent, read the areas, and activate a draft. The button's dot says
when a draft is waiting, a recipe task is working, or a reviewer reported a
problem with the recipe.

**Every change is a draft you activate.** The recipe decides what merges, so
lowering the bar is never an agent's call alone: an agent can propose a draft,
and `wisp verify activate` run from an agent's turn is refused. A draft is saved
only from its own recipe task's turn. Like the round token, these checks rest on
who the CLI says is calling: they stop an agent's mistake or shortcut, not a
hostile process on the same machine, which already holds the daemon's token. Activation replaces the whole
recipe with the draft in one commit, and every verdict records the version it
was judged against.

### A broken recipe

When a reviewer returns `inconclusive` with cause `recipe`, it is not the
author's to fix, and it spends no round:

1. The PR is held: "Waiting on the verification recipe (web): …".
2. Wisp starts a recipe task in fix mode for that area, seeded with what the
   reviewer reported.
3. When its draft is saved, the task needs you: "Verification recipe (web) has
   a fixed draft — activate it to review abc1234 again".
4. Once you activate it, a fresh reviewer checks the same head again, under the
   same round number. That holds even when the draft changed nothing (the recipe
   task found the instructions already right and the problem was passing): your
   activation is the go-ahead. **Resume** also has the held head reviewed again.

## With the other switches

- **Auto-fix acts first.** A red check or a conflict goes back to the author
  before any reviewer starts.
- **The reviewer's words stay data.** Its summary and findings reach the author
  in `REVIEW-FEEDBACK.md`, and earlier reviewers' words reach the next one,
  quoted and labelled as another agent's: evidence to weigh, never instructions.
- **Then auto-review.** The merge gate only runs once the current head has a
  pass. The `merging` history entry says "auto-review passed (round N)".
- **Auto-review alone** reviews each head and needs you for a rejection. With a
  pass it is done for now.

Reviewers and recipe tasks are tasks, so they take task slots. With every slot
full, a round waits for a free one. A reviewer or recipe task can never turn
autopilot on itself.

## History

`wisp pr <task> history` and the Autopilot tab record each round as `review`
entries (started, a reviewer gave its verdict, the round's outcome with what
the reviewers said, superseded, no verdict; a reviewer's words reach history
only once the round settles) and a held recipe as
`review-hold`, beside auto-merge's and auto-fix's own entries.
