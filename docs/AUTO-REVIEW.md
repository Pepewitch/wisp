# Auto-review

Auto-review is the third switch on a task, beside auto-merge and auto-fix.
With it on, nothing merges on the author's word, a green CI run or a passing
unit test alone. Each head of the task's pull request gets a separate
reviewer: a fresh agent in its own worktree, checked out at that head, that
builds the change, runs it, uses what changed the way a person would, and
says whether it is good enough to merge.

```sh
wisp new . "Add a dark mode toggle, open a PR" --harness claude --auto-merge --auto-fix --auto-review
wisp pr <task> review on          # or: review off
wisp review show <task>           # the rounds for the task's current PR, newest first (--pr <n> or --all for others)
wisp review show <task> --round 2 # one round in full: findings, evidence, reviewer task
```

In the app, **Auto-review** is a switch in the task's Autopilot tab, its `…`
menu, and the new-task dialog's PR picker. The tab lists the rounds under the
switches, and each one opens its reviewer task.

## How a round goes

1. **The author opens a PR.** While auto-review is on, every turn of the task
   tells its agent that a reviewer will check the head, that the project's
   verification recipe is the bar (`wisp verify show`), and to open a pull
   request when the work is ready.
2. **The head goes green.** Auto-review waits for the PR's checks the way the
   merge gate does: no reviewer is spent on a red or running head. With
   auto-fix on, a red check goes back to the author first.
3. **A reviewer starts.** A new task, titled
   `Auto-review · PR #7 · round 1 · abc1234`, in its own worktree at that
   head. It may install, run setup and start servers there; nothing it does
   reaches the author's branch. It never commits, pushes or comments on the PR.
   It runs on the project's reviewer agent (Project settings → Verification), or
   on the author task's own agent, model and effort when none is chosen.
4. **It verifies and submits a verdict** with `wisp review submit`. Images it
   published with `wisp output add` are attached as evidence.
5. **Wisp acts on the verdict**, and archives the reviewer once its turn ends.
   Its transcript stays readable under archived tasks. A reviewer whose round
   no longer matters (auto-review switched off, the PR closed, the task
   archived) is stopped and archived the same way.

A push while a reviewer runs makes its round moot: the reviewer is stopped and
the new head gets a fresh one.

## Verdicts

| Verdict | Means | What happens |
| --- | --- | --- |
| `pass` | Every changed behaviour was seen working, and nothing should block the merge | Auto-merge merges once its own gate allows. With auto-review alone, the task is done for this head |
| `fail` | A defect, a regression, or a broken project rule. At least one finding says what was done, seen and expected | With auto-fix on, the findings go back to the author as a round. Otherwise the task needs you |
| `inconclusive`, cause `change` | The change itself kept it from being verified (it does not build, the feature cannot be reached) | Same as `fail` |
| `inconclusive`, cause `recipe` | The recipe failed the reviewer: a broken launch step, an area the diff touches is missing | The PR is held. See [A broken recipe](#a-broken-recipe) |

Passing CI, passing unit tests, or a PR description that says it works is
never enough for a pass. A change to a screen needs screenshots of that screen.

**Back to the author.** A rejection is sent once per round as
`[Wisp auto-review · PR #7 · round 1 of 3 · head abc1234]`, pointing at a
`REVIEW-FEEDBACK.md` beside the task's data (never in its worktree). Up to six
of the reviewer's screenshots are attached when the author's agent can take
images. If the author's turn ends with no new push, the task needs you
("Still rejected after review round 1, with no new push").

**Three rounds per PR.** After three counted rounds that did not pass, auto-review
pauses. **Resume** gives it three more, and the numbering goes on ("round 4 of 6").
A new PR after a merge starts at round 1 again.

**Ask again without a push.** When a rejection needs you, **Resume** (in the
Autopilot tab, or `wisp pr <task> resume`) has a fresh reviewer look at the same
head once more, without spending a round: for a reviewer that got it wrong, or
an environment that misbehaved.

**Each reviewer is fresh.** It is told its round number and what earlier rounds
found (in full with `wisp review show <task> --round <n>`), so it checks those
findings are fixed. It does not take their word for anything else.

**A reviewer that gives no verdict.** If its turn ends without one, Wisp asks once.
If the next turn also ends without a verdict, the round ends as an error and
the task needs you. **Resume** starts a new reviewer for the same head, without
spending a round. A reviewer that stops to ask a question, or gets stuck, needs
you too: answer or look at it in its own task.

Only the reviewer can submit its round's verdict. Each round has a token that
only the reviewer's turns carry (`WISP_REVIEW_TOKEN`). That stops an agent from
passing its own work by mistake or as a shortcut. It is not a security boundary
against a hostile agent on the same machine, which already holds the daemon's
token.

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
only from its own recipe task's turn. Activation replaces the whole
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
   same round number.

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
entries (started, the verdict, superseded, no verdict) and a held recipe as
`review-hold`, beside auto-merge's and auto-fix's own entries.
