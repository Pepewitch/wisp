# Wisp 0.5.19

Wisp 0.5.19 adds auto-merge and auto-fix: two switches on a task, set up when
you create it, from its `…` menu, or with `wisp pr`.
- **Auto-merge** merges the task's pull request under your GitHub account once
  its required checks pass, its reviewers allow it, and the task is idle.
- **Auto-fix** sends the idle agent a red required check, a merge conflict, or
  review feedback it has not seen yet, with the failing logs, as a round.

The release also keeps the end of long turns whose transcript overflows, and
gives long turns five times more room. The PR CI and PR review watch workflows
are removed; auto-fix replaces them.

## What changed since 0.5.18

- **Auto-merge** (#267, #269, #276) binds to the task's own pull request: one
  you opened from this repository after the task was created. It squash-merges
  (or uses the repository's only allowed method) with `--match-head-commit`,
  so whatever it checked is exactly what merges.
  - Before merging it re-reads everything:
    - the required checks, which alone decide when the base branch has any;
    - a two-minute floor after every new head;
    - each blocking reviewer's pass on the current head;
    - GitHub's merge state;
    - that the worktree holds nothing the PR lacks.
  - It never merges mid-turn. Stop holds it until your next turn finishes.
  - Closing the PR switches it off.
  - Every turn is told to push and open the PR and to leave the merge to Wisp.
- **Auto-fix for CI and conflicts** (#272). A round points the agent at a
  `PR-FEEDBACK.md` beside the task's data (never in the worktree). The file
  lists the red check and the jobs that failed beside it, with each job's log
  from the step that failed, so an aggregator check's failing shard is read.
  - Rounds wait for the whole head to finish, wait two minutes after the
    task's latest turn (Send now / Skip in the menu), and are never repeated
    for the same evidence.
  - At most three rounds per PR, then it pauses until you resume it.
  - A cancelled run is retried once without spending a turn. A red that is
    also red on the base branch is not the PR's to fix.
- **Auto-fix for review feedback** (#275): review threads, reviews with a body,
  and conversation comments.
  - Only from you, from bots, and from people who can push to the repository.
  - Never the agent's own words, which it signs with a marker.
  - Never thank-yous, approvals, or a bot's status board.
  - A reviewer's burst goes as one round.
  - The agent may resolve threads that you or a bot started, once it has
    pushed a fix. It answers everyone else's and leaves them for their
    author, and nothing merges while a thread Wisp sent is still open.
- **Where you see it** (#269, #276):
  - The PR line names the switch and its reason (`Auto-fix: test failing`).
  - The menu offers Resume, Continue now, Send now and Skip.
  - The new-task dialog has a PR picker.
  - The sidebar PR icon turns red when either switch needs you.
  - Desktop banners report a merge, a needs-you, or a pause.
  - Archiving a task whose PR is still being watched asks first.
- **Long turns keep their end** (#270, #271, #273).
  - Once a turn overflows its transcript budget, the most recent activity is
    kept after a gap note, instead of only the beginning.
  - Thinking blocks and other content nothing can show no longer fill the
    budget.
  - A capped turn is no longer reported as stuck.
  - The default per-turn budget is 25 MB, up from 5 MB. A stored `5000000`
    from an earlier first run reads as the new default.
- **Desktop connection tabs show live status** (#274). A dot beside each
  connection turns green only when its API and event stream are healthy, and
  clicking it reconnects without switching tabs.
- **The mobile header shows the session's context size** (`… · 142.6k ctx`),
  and the metadata line no longer slides over its separators.
- **The PR CI and PR review watch workflows are removed** (#265). Rows
  already armed complete with a reason saying so; auto-fix replaces both.
- Release and CI hygiene:
  - asset inventory now reads GitHub's dedicated release-assets endpoint
    (#263);
  - the test suites run as parallel shards, in about 75 seconds (#266).

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
channel URL remains compatible and advertises the regular 0.5.19 version.
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
  https://raw.githubusercontent.com/Pepewitch/wisp/v0.5.19/scripts/install.sh | sh
```

Back up task state **and the original Git repositories** before upgrading.
Follow [backup and restore](https://github.com/Pepewitch/wisp/blob/v0.5.19/docs/INSTALL.md#back-up-and-restore-a-wisp-home); copying `.wisp`
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
preparation, the 0.5.19 artifact gates are pending; the [qualification ledger](https://github.com/Pepewitch/wisp/blob/main/docs/v0.5/QUALIFICATION.md)
records the final outcome separately from these immutable release notes.

Auto-merge merges under your GitHub account, through the daemon host's
authenticated `gh`. Arm it for work you would merge yourself once CI is green;
leave it off for critical changes. Auto-fix spends agent turns: up to three
rounds per bound PR, each a full turn with the model the task runs. Both need a
GitHub repository and a worktree task.
- Pull requests from forks are not supported.
- After a merge, auto-merge stands down; switch it on again for a follow-up
  PR.
- On a PR with more than 100 review threads, only the newest 100 are read.

Native dependency advisories still include upstream maintenance notices and a
locked Linux-only glib warning. Full clean-machine provider journeys, a
human-observed Desktop upgrade across this version, broad OS coverage, and
cross-machine restore remain incomplete. Task export excludes repositories and
provider sessions; it is not a complete backup or an import format. Permanent
deletion is logical, not forensic erasure. This release is not a security
certification.

## Release assets

The release contains these ten immutable assets:

- `wisp-v0.5.19-linux-x86_64`
- `release-manifest.json`
- `SHA256SUMS`
- `wisp-v0.5.19-darwin-arm64.tar.gz`
- `release-manifest-darwin-arm64.json`
- `SHA256SUMS-darwin-arm64`
- `wisp-desktop-v0.5.19-darwin-arm64.tar.gz`
- `wisp-desktop-v0.5.19-darwin-arm64.tar.gz.sig`
- `release-manifest-desktop-darwin-arm64.json`
- `SHA256SUMS-desktop-darwin-arm64`
