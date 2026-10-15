# Wisp 0.7.0

Wisp 0.7.0 adds auto-review: independent reviewer agents check every pull
request head before it can merge, and they verify the change by running it.
- **Auto-review.** A third autopilot switch beside auto-merge and auto-fix.
  Reviewer A runs the app and reviews the code; reviewer B reviews the code.
  A rejection goes back to the task as an auto-fix round with the findings.
- **Verification recipes.** Each project can have a recipe, kept in Wisp and
  never in the repository, that tells reviewers how to build, launch and drive
  the app. A task sets it up and proves it; you activate it.
- **`wisp capture`.** Wisp takes screenshots itself, in its own headless
  Chrome, and records where each page came from. A recipe can require a
  screenshot before a UI change passes.

## What changed since 0.6.9

### Auto-review

- **An independent review of every PR head** (#382). Turn on Auto-review for
  a task (the Autopilot tab, `wisp new --auto-review`, or `wisp pr <task>
  review on`) and Wisp starts a fresh reviewer task, in its own worktree, each
  time the task's PR gets a new head. With auto-merge on, a merge needs that
  head to pass. With auto-fix on, a rejection is sent back to the task as a
  round of its own, with the findings in a file and the reviewers' screenshots
  attached. After three rounds that do not pass, it waits for you; **Resume**
  gives it three more.
- **Two reviewers, an engineering rubric, and a depth Wisp measures** (#383).
  Reviewer A runs the app and reviews the code; reviewer B, on the project's
  second reviewer agent (Project settings → Verification, or off), reviews
  the code only. Both work from one rubric: correctness, architecture, slop,
  security, performance, tests and docs, plus verification for A. Only an
  issue the change introduces can block a merge. Wisp measures each diff as
  light (A only), standard or deep from its size, the paths it touches and the
  recipe areas it falls in, and the reviewers never ask how deep to go. While
  a round is open, neither reviewer can see the other's verdict.
- **`wisp review`** shows a task's rounds, `wisp review rubric` prints the
  rubric for a project, and a reviewer submits with `wisp review submit`.

### Verification recipes

- **A recipe per project, kept in Wisp** (#382) under the Wisp home, never in
  the repository. Project settings → Verification → **Set up** starts a task
  that writes the recipe, proves each area by running it, and saves a draft.
  A person activates a draft; an agent cannot. When a reviewer cannot follow
  the recipe, the PR is held and a task repairs the recipe instead of
  bouncing the author. `wisp verify` reads and manages recipes from the CLI.
- **Review rules and depth hints** (#383). A recipe can carry the project's
  own review rules, and name paths that always need a deep review or that are
  documentation.

### Screenshots Wisp takes itself

- **`wisp capture <url>`** (#385) screenshots a page an agent launched on this
  machine (`localhost`, `127.0.0.1`), in Wisp's own headless Chrome, and
  stores it in the running turn. It prints a file every agent can open, the
  page's final address and status, and whether the page was served from the
  task's own worktree. It works the same from Claude, Codex, Droid and
  OpenCode tasks. `--script` reaches a state behind a click; `--viewport
  mobile`, `--dark`, `--selector` and `--full-page` change the shot.
- **A recipe can require a screenshot** (#385). An area marked
  `evidence: screenshot` makes reviewer A's pass on a change there carry a
  capture of it from A's own worktree. When Wisp could not take one (no
  Chrome, for example), A can waive it with a reason and an image of its own.
- **The Autopilot tab shows each reviewer's images** (#385), each marked
  "Captured by Wisp" with its page and viewport, or "Published by the
  reviewer".
- **Reviewer and recipe tasks get `PORT`** (#385): ten ports of their own, so
  reviewers running side by side never collide. `wisp doctor` reports which
  Chrome capture uses.

### Browser and Desktop

- **iOS no longer pastes copied prompts percent-encoded** (#381).
- **Desktop locks `quinn-proto` 0.11.19** (#387), the fix for two remotely
  triggerable panics (RUSTSEC-2026-0340 and RUSTSEC-2026-0343).

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
channel URL remains compatible and advertises the regular 0.7.0 version.
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
  https://raw.githubusercontent.com/Pepewitch/wisp/v0.7.0/scripts/install.sh | sh
```

Back up task state **and the original Git repositories** before upgrading.
Follow [backup and restore](https://github.com/Pepewitch/wisp/blob/v0.7.0/docs/INSTALL.md#back-up-and-restore-a-wisp-home); copying `.wisp`
alone does not preserve linked worktrees or unpublished Git objects.
This release adds database migrations 23, 24, and 25, so a 0.6.9 daemon cannot reopen a profile that 0.7.0 has opened.

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
preparation, the 0.7.0 artifact gates are pending; the [qualification ledger](https://github.com/Pepewitch/wisp/blob/main/docs/v0.7/QUALIFICATION.md)
records the final outcome separately from these immutable release notes.

Specific to this release:
- Auto-review has been exercised end to end only by tests with stand-in
  reviewers; its first real use is this release. Each round runs one or two
  extra agent tasks, which use task slots and your agents' quotas.
- A reviewer works from a rubric and its own judgement; Wisp checks the shape
  of a verdict and any required screenshot, not how carefully each part of
  the rubric was applied.
- `wisp capture` opens only `http(s)` pages on this machine's loopback. It
  cannot capture native or Desktop windows, terminal apps, apps inside a
  container, or `file://` pages, and keeps no login between captures. It
  needs Chrome, Chromium, Edge or Brave (not a snap build), and refuses to
  run as root. A capture proves that Wisp saw a page, not that it works.
- OpenCode tasks were seen to run `wisp capture`; whether their models can
  read the image back was not confirmed.
- Against an older daemon, the Autopilot tab shows no Auto-review switch,
  and the reviewer panel, tiers and capture labels are not drawn.
- Desktop still locks `rustls` 0.23.45, as 0.6.9 does. Advisories published
  on 2026-10-14 (RUSTSEC-2026-0338, -0346, -0347, -0348 and -0349) name
  0.23.46 as their fix, which was not yet on crates.io when this release was
  cut. None of the paths they describe was found in Desktop's use: it enables
  no ECH, builds rustls without its Brotli feature, uses the `ring` provider
  without post-quantum key exchange, and never formats a TLS session for
  debugging. A later release locks 0.23.46.

The per-model default and `ultracode` limits listed for
[0.6.9](https://github.com/Pepewitch/wisp/blob/v0.6.9/docs/v0.6/RELEASE-NOTES-0.6.9.md#scope-and-known-limits),
the image-output and attachment-preview limits listed for
[0.6.8](https://github.com/Pepewitch/wisp/blob/v0.6.8/docs/v0.6/RELEASE-NOTES-0.6.8.md#scope-and-known-limits),
the icon-cache and tooltip limits listed for
[0.6.7](https://github.com/Pepewitch/wisp/blob/v0.6.7/docs/v0.6/RELEASE-NOTES-0.6.7.md#scope-and-known-limits),
the Autopilot-tab, background-process, `wisp audit` and GitHub-use limits
listed for
[0.6.6](https://github.com/Pepewitch/wisp/blob/v0.6.6/docs/v0.6/RELEASE-NOTES-0.6.6.md#scope-and-known-limits),
the updater-signing, Linux update manifest, error-boundary and older-daemon
composer limits listed for
[0.6.5](https://github.com/Pepewitch/wisp/blob/v0.6.5/docs/v0.6/RELEASE-NOTES-0.6.5.md#scope-and-known-limits),
the task-brief limits listed for
[0.6.4](https://github.com/Pepewitch/wisp/blob/v0.6.4/docs/v0.6/RELEASE-NOTES-0.6.4.md#scope-and-known-limits),
the shell-tab, plan-limit, and Desktop first-launch limits listed for
[0.6.3](https://github.com/Pepewitch/wisp/blob/v0.6.3/docs/v0.6/RELEASE-NOTES-0.6.3.md#scope-and-known-limits),
and the auto-merge, auto-fix, review judge and draft limits listed for
[0.6.2](https://github.com/Pepewitch/wisp/blob/v0.6.2/docs/v0.6/RELEASE-NOTES-0.6.2.md#scope-and-known-limits),
still apply.
Native dependency advisories still include upstream maintenance notices and a
locked Linux-only glib warning. Full clean-machine provider journeys, a
human-observed Desktop upgrade across this version, broad OS coverage, and
cross-machine restore remain incomplete. Task export excludes repositories and
provider sessions; it is not a complete backup or an import format. Permanent
deletion is logical, not forensic erasure. This release is not a security
certification.

## Release assets

The release contains these ten immutable assets:

- `wisp-v0.7.0-linux-x86_64`
- `release-manifest.json`
- `SHA256SUMS`
- `wisp-v0.7.0-darwin-arm64.tar.gz`
- `release-manifest-darwin-arm64.json`
- `SHA256SUMS-darwin-arm64`
- `wisp-desktop-v0.7.0-darwin-arm64.tar.gz`
- `wisp-desktop-v0.7.0-darwin-arm64.tar.gz.sig`
- `release-manifest-desktop-darwin-arm64.json`
- `SHA256SUMS-desktop-darwin-arm64`
