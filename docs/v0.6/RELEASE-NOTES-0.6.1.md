# Wisp 0.6.1

Wisp 0.6.1 refines 0.6.0's auto-merge and auto-fix.
- **An optional review judge.** With a Jev API key from TypeSafe, Wisp asks a
  small classifier two questions GitHub gives no signal for: whether a
  reviewer bot's summary comment or review body asks for changes, and whether
  an approval lists findings.
- **Five auto-fix rounds per PR**, up from three.
- **One last read before merging.** Auto-merge reads the PR once more right
  before it merges, so words posted while it was deciding are read first.

## What changed since 0.6.0

- **An optional review judge** (#286). Some reviewer bots report findings only
  in a summary comment and keep their own check green. With a
  [Jev](https://docs.typesafe.ai/api) key, Wisp classifies only the words it
  could not otherwise read:
  - a bot's conversation comment whose own check is green or running, or that
    has no check and does not say "blocking";
  - a bot's review body with no `Verdict:` line and no change request;
  - with auto-fix on, an approval with a body. It is asked only whether the
    approval lists findings, not whether they are right.

  What the answers do:
  - Under auto-fix, a bot's words judged as asking for changes become review
    feedback.
  - An approval that lists findings goes to the agent once, as notes, before
    the merge. The approval still counts.
  - Under auto-merge, a bot's finding about the current head needs you until
    a push and that bot's next pass, or its approval of the head.
  - A finding about an earlier head waits for the bot to speak on the new one,
    for at most 20 minutes.

  What it sends and where it is set:
  - Only the text (up to 8,000 characters), whether a bot or a person wrote
    it, and whether it is a comment or a review body. Never the diff, the
    repository, the PR number or any login.
  - Every call is logged beside the round evidence (`judge.jsonl`), and a
    monthly count is reported by `GET /api/settings`.
  - Set the key with `PATCH /api/settings` (`{"jevApiKey": "…"}`), or with
    `TYPESAFE_API_KEY` or `JEV_API_KEY` in the daemon's environment.
    `POST /api/settings/review-judge/test` makes one probe call.
  - The key is stored in `config.json` (mode 0600) and is never read back.

  Without a key nothing is judged. Red checks, review threads, change requests
  and `Verdict:` lines work as in 0.6.0.
  [The review judge](https://github.com/Pepewitch/wisp/blob/v0.6.1/docs/PR-AUTOPILOT.md#the-review-judge-optional)
  describes each answer, and what happens when a call fails.
- **Five auto-fix rounds per PR**, up from three (#288). Each Resume allows
  five more, and the next PR after a merge starts with a fresh five.
- **Auto-merge reads the PR once more before merging** (#289).
  - If a comment, review, thread or check changed while it was deciding, it
    does not merge. It looks again a few seconds later, so new words are
    read, and judged, first.
  - With the review judge, a check finishing no longer counts as a pass by
    a bot that keeps a summary comment. Such a bot may finish its check a
    moment before it rewrites the summary.
- **On/off rows in a menu end in a switch** (#283), such as Auto-merge and
  Auto-fix in a task's `…` menu. They used to show a checkmark in a slot that
  looked empty when off.
- **Search indexing no longer stalls on one bad turn** (#287). The background
  pass that indexes turn prose for search stopped at the first turn it could
  not write, and that turn led every later pass, so older turns were never
  indexed. A turn left from a deleted task was one such turn. The pass now
  skips the turn and continues.
- Release and test hygiene:
  - the 0.6.0 publication record (#282);
  - the update test waits for the restart itself (#285);
  - an interim parser for one reviewer's summary format (#284) was replaced
    by the review judge before this release.

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
channel URL remains compatible and advertises the regular 0.6.1 version.
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
  https://raw.githubusercontent.com/Pepewitch/wisp/v0.6.1/scripts/install.sh | sh
```

Back up task state **and the original Git repositories** before upgrading.
Follow [backup and restore](https://github.com/Pepewitch/wisp/blob/v0.6.1/docs/INSTALL.md#back-up-and-restore-a-wisp-home); copying `.wisp`
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
preparation, the 0.6.1 artifact gates are pending; the [qualification ledger](https://github.com/Pepewitch/wisp/blob/main/docs/v0.6/QUALIFICATION.md)
records the final outcome separately from these immutable release notes.

Auto-merge merges under your GitHub account, through the daemon host's
authenticated `gh`. Arm it for work you would merge yourself once CI is green;
leave it off for critical changes. Auto-fix spends agent turns: five rounds
per bound PR before it pauses (each Resume allows five more), each a full
turn with the model the task runs. Both need a GitHub repository and a
worktree task. The limits listed for 0.6.0 still apply: no pull requests from
forks, a stacked PR needs you, and so does a branch behind a base that
requires up-to-date branches. Wisp reads only the newest 100 review threads,
50 reviews and 100 conversation comments. Apart from an approval a branch
rule requires, it waits only for reviewers that have already spoken on the PR. A reviewer bot with no check of its own whose
first review arrives after the checks pass, and after a new head's two
minutes, may arrive after the merge.

The review judge is an outside service:
- With a key set, the review text described above leaves the daemon host for
  TypeSafe's API.
- The Settings page has no field for the key yet; use the settings API or the
  environment.
- Its answers follow the reviewer's wording, since it never sees the code.

Native dependency advisories still include upstream maintenance notices and a
locked Linux-only glib warning. Full clean-machine provider journeys, a
human-observed Desktop upgrade across this version, broad OS coverage, and
cross-machine restore remain incomplete. Task export excludes repositories and
provider sessions; it is not a complete backup or an import format. Permanent
deletion is logical, not forensic erasure. This release is not a security
certification.

## Release assets

The release contains these ten immutable assets:

- `wisp-v0.6.1-linux-x86_64`
- `release-manifest.json`
- `SHA256SUMS`
- `wisp-v0.6.1-darwin-arm64.tar.gz`
- `release-manifest-darwin-arm64.json`
- `SHA256SUMS-darwin-arm64`
- `wisp-desktop-v0.6.1-darwin-arm64.tar.gz`
- `wisp-desktop-v0.6.1-darwin-arm64.tar.gz.sig`
- `release-manifest-desktop-darwin-arm64.json`
- `SHA256SUMS-desktop-darwin-arm64`
