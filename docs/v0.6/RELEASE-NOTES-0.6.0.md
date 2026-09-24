# Wisp 0.6.0

Wisp 0.6.0 adds auto-merge and auto-fix: two switches on a task, set up when
you create it, from its `…` menu, or with `wisp pr`.
- **Auto-merge** merges the task's pull request under your GitHub account once
  its checks pass (only the required ones, when the base branch has any), its
  reviewers allow it, and the task is idle.
- **Auto-fix** sends the idle agent a red check that counts, a merge conflict,
  or review feedback it has not seen yet, with the failing logs, as a round.

The release also keeps the end of long turns whose transcript overflows, and
gives long turns five times more room. The PR CI and PR review watch workflows
are removed; auto-fix replaces them.

## What changed since 0.5.18

- **Auto-merge** (#267, #269, #276) binds to the task's own pull request: one
  you opened from this repository after the task was created, onto the
  default branch or the project's configured base (preferring one onto the
  base when there are several). It squash-merges when the
  repository allows it (otherwise its one allowed method, or your default),
  with `--match-head-commit`, so whatever it checked is exactly what merges.
  - Before merging it re-reads everything:
    - the required checks, which alone decide when the base branch has any;
    - a two-minute floor after every new head, or a draft marked ready;
    - each blocking reviewer's pass on the current head;
    - GitHub's merge state;
    - that the worktree holds no unpushed commits or tracked edits the PR
      lacks (untracked files are ignored).
  - It never merges mid-turn. Stop holds it until your next turn finishes.
  - After a merge both switches stay on for the task's next PR (#278): one
    numbered above the merged one (the task's next change, or a PR stacked on
    it), never an older open PR. The next PR starts with a fresh round budget.
  - Closing the PR switches both switches off.
  - Every turn is told to push and open the PR and to leave the merge to Wisp
    (a slash-command turn, which cannot carry the note, is the exception).
- **Auto-fix for CI and conflicts** (#272, #276). A round points the agent at a
  `PR-FEEDBACK.md` beside the task's data (never in the worktree). The file
  lists the red check and the jobs that failed beside it, with each job's log
  from the step that failed, so an aggregator check's failing shard is read.
  - Rounds wait until every check that counts on the head, and every job in a
    failing run, has finished; wait two minutes after the task's latest turn
    (Send now / Skip in the menu); and are never repeated for the same
    evidence.
  - Three rounds per PR, then it pauses; each Resume allows three more.
  - A cancelled run (or, when the base branch has no required checks, a failed
    one) is rerun once without spending a turn: ordinary `pull_request` runs
    only, never one with a deployment job. A red that is also red on the base
    branch is not the PR's to fix.
- **Auto-fix for review feedback** (#275): review threads, reviews with a body,
  and conversation comments.
  - Only from you, from bots, and from people who can push to the repository.
  - Never the agent's own words, which it signs with a marker.
  - Never thank-yous, approvals, or a bot's status board.
  - A reviewer's burst goes as one round.
  - The agent may resolve threads that you or a bot started, once it has
    pushed a fix. It answers everyone else's and leaves them for their
    author.
  - An open thread holds the merge only where the repository requires
    conversations resolved (#279). Wisp reads that rule from a ruleset
    (always readable) or classic protection (readable only by an admin,
    though anyone can see whether there is any). Where it cannot read the
    rule, a PR GitHub reports blocked, with threads open and no missing
    approval or change request, is taken to be blocked on them. Otherwise a
    PR GitHub calls mergeable is merged with threads open. With both switches
    on, a round carrying review feedback tells the agent to convert the PR to
    a draft if it must not merge as it is.
  - The agent replies to and resolves threads under your GitHub account.
- **Where you see it** (#269, #272, #276, #279):
  - The PR line names the switch and its reason (`Auto-fix will send: test
    failing`, `Auto-merge: Waiting for checks (2 running)`).
  - The menu offers Resume, Continue now, Send now and Skip.
  - The new-task dialog has a PR picker.
  - The sidebar PR icon turns red when either switch needs you.
  - A task with either switch on carries a thin rail on its sidebar row, so
    one left on is never out of sight: blue while it works, violet once it is
    done for now (its PR merged; or, under auto-fix alone, CI green and quiet
    for 15 minutes), red when it needs you. Its hover card says which switch
    is on and why.
  - Desktop banners report a merge by Wisp, a needs-you, or a pause.
  - Archiving a task whose PR is still being watched asks first.
  - Under auto-merge, a branch rule that needs an approving review turns red
    after the head has waited 15 minutes for one (30 if a reviewer app has
    approved the PR before). [When it needs you](https://github.com/Pepewitch/wisp/blob/v0.6.0/docs/PR-AUTOPILOT.md#when-it-needs-you)
    lists every reason.
- **Long turns keep their end** (#270, #271, #273).
  - Once a turn overflows its transcript budget, the most recent activity is
    kept after a gap note, instead of only the beginning.
  - For Claude turns, the encrypted signature on empty thinking blocks and the
    running thinking-token estimates are no longer written to the turn's
    transcript (the diagnostic archive still has them), so they stop filling
    the budget.
  - A capped turn is no longer reported as stuck.
  - The default per-turn budget is 25 MB, up from 5 MB. A stored `5000000`
    from an earlier first run reads as the new default.
- **Desktop connection tabs show live status** (#274). A dot beside each
  connection turns green only when its API and event stream are healthy, and
  clicking it reconnects without switching tabs.
- **The mobile header shows the session's context size** (`… · 142.6k ctx`),
  and the metadata line no longer slides over its separators (#268).
- **A pending steer image can be previewed before sending** (#280): its
  thumbnail and filename open the attachment preview.
- **The PR CI and PR review watch workflows are removed** (#265), with their
  `wisp workflow` types and flags (`--pr`, `--on-red`, `--on-green`, …), so a
  script that starts them fails. Rows already armed complete with a reason
  saying so; auto-fix replaces both. The same change fixes Schedule Steer's
  `--at`.
- Release and CI hygiene:
  - asset inventory now reads GitHub's dedicated release-assets endpoint
    (#263);
  - the test suites run as parallel shards, in about 75–95 seconds (#266).

## Install or upgrade

Apple Silicon macOS (12.3 configured minimum):

```sh
brew install Pepewitch/tap/wisp Pepewitch/tap/wisp-desktop
open -a Wisp
```

The Cask installs the separate daemon Formula as a dependency. Name both:
Homebrew trusts only the fully qualified names you install from a non-official
tap, so the Cask alone refuses to load that Formula. Existing updater-capable
Desktop builds can use **Updates → Check now**, then **Update Desktop and
relaunch**. Update **Local daemon** separately. The legacy alpha
channel URL remains compatible and advertises the regular 0.6.0 version.
For Homebrew recovery or older builds without an updater:

```sh
brew update
brew upgrade Pepewitch/tap/wisp
brew upgrade --cask --greedy Pepewitch/tap/wisp-desktop
brew services restart wisp
open -a Wisp
```

Linux (Ubuntu 24.04 LTS, x86_64, glibc):

```sh
curl --proto '=https' --tlsv1.2 -fsSL \
  https://raw.githubusercontent.com/Pepewitch/wisp/v0.6.0/scripts/install.sh | sh
```

Back up task state **and the original Git repositories** before upgrading.
Follow [backup and restore](https://github.com/Pepewitch/wisp/blob/v0.6.0/docs/INSTALL.md#back-up-and-restore-a-wisp-home); copying `.wisp`
alone does not preserve linked worktrees or unpublished Git objects.
This release adds no database migration.

## Scope and known limits

This release is for a trusted single OS user. Worktrees separate checkouts;
they do not sandbox agents or their credentials. There is no multi-user
permission boundary. Closing Desktop leaves daemons and agents running.
Intel macOS and non-Apple-Silicon Desktop builds are unsupported.

Desktop publication requires Developer ID signing, notarization, a stapled
ticket, and a verified updater signature. The public macOS daemon application
also requires Developer ID signing, notarization, and a stapled ticket.
Automated release gates verify immutable downloads and promote the Formula,
Cask, daemon channel, and Desktop channel together. At source
preparation, the 0.6.0 artifact gates are pending; the [qualification ledger](https://github.com/Pepewitch/wisp/blob/main/docs/v0.6/QUALIFICATION.md)
records the final outcome separately from these immutable release notes.

Auto-merge merges under your GitHub account, through the daemon host's
authenticated `gh`. Arm it for work you would merge yourself once CI is green;
leave it off for critical changes. Auto-fix spends agent turns: three rounds
per bound PR before it pauses (each Resume allows three more), each a full
turn with the model the task runs. Both need a GitHub repository and a
worktree task.
- Pull requests from forks are not supported.
- A PR onto a branch other than the default or the configured base (a stacked
  PR) needs you; auto-merge only merges into those. Wisp never deletes a
  merged branch, so a PR stacked on it is retargeted only where the
  repository deletes head branches automatically; otherwise retarget it
  yourself.
- While auto-merge is on, every later turn on the task is told to push and
  open a PR, and that PR is merged too: switch auto-merge off once the task's
  work is done. After a merge, a PR you open by hand may take up to an hour to
  be picked up.
- A branch behind its base, where the repository requires up-to-date branches,
  needs you: auto-fix handles conflicts, not updates.
- Wisp reads only the newest 100 review threads (30 comments each), the
  newest 50 reviews and the newest 100 conversation comments; older ones are
  not seen.

Native dependency advisories still include upstream maintenance notices and a
locked Linux-only glib warning. Full clean-machine provider journeys, a
human-observed Desktop upgrade across this version, broad OS coverage, and
cross-machine restore remain incomplete. Task export excludes repositories and
provider sessions; it is not a complete backup or an import format. Permanent
deletion is logical, not forensic erasure. This release is not a security
certification.

## Release assets

The release contains these ten immutable assets:

- `wisp-v0.6.0-linux-x86_64`
- `release-manifest.json`
- `SHA256SUMS`
- `wisp-v0.6.0-darwin-arm64.tar.gz`
- `release-manifest-darwin-arm64.json`
- `SHA256SUMS-darwin-arm64`
- `wisp-desktop-v0.6.0-darwin-arm64.tar.gz`
- `wisp-desktop-v0.6.0-darwin-arm64.tar.gz.sig`
- `release-manifest-desktop-darwin-arm64.json`
- `SHA256SUMS-desktop-darwin-arm64`
