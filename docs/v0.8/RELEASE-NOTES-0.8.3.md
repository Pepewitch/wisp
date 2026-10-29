# Wisp 0.8.3

Wisp 0.8.3 lets you start auto-review before CI finishes, and tidies two
things you meet often: what reviewers are told, and the sidebar's project row.

- **Review now.** When auto-review is waiting on a head's checks, or on an
  auto-fix countdown, one click starts its round at once. Merging still waits
  for green checks.
- **Reviewers judge the pull request.** They no longer receive the task's
  first message quoted as the goal; they read the PR and can look the task up.
- **Project rows end with +.** The "⋯" is gone; on touch, long-press a project
  to drag it.

## What changed since 0.8.2

- **Review now** (#471). While auto-review holds a ready head for its checks
  (running or failed) or for an auto-fix countdown, the Auto-review row in the
  autopilot pane and the phone task sheet offers **Review now**, and
  `wisp pr <task> review now` does the same. It starts that head's round
  without waiting, counted against the round budget like any other. The click
  is for the head you saw: a push before the round starts cancels it, and a
  push during the round ends it as usual. Auto-merge still requires green
  checks. The round records that it was started early, so it settles even if
  the look that launched it is interrupted, and the round budget is now
  rebuilt from the stored rounds since auto-review was switched on. The status
  line shows the real budget after a Resume or a switch-on.
- **Reviewer prompt without the first message** (#468). Reviewers used to get
  the author task's first message quoted as "what the author task was asked to
  do", which was often stale for a long task. They now get the PR's own title
  and description, and a command to read the author task if they need more.
  This closes #438.
- **Project row** (#469). Each sidebar project row ends with its **+** button;
  the "⋯" menu is gone. On touch screens, long-press a project to start
  dragging it into a new order.
- **README** (#467). The stale hero video is removed; the hero image stays.

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
channel URL remains compatible and advertises the regular 0.8.3 version.
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
  https://raw.githubusercontent.com/Pepewitch/wisp/v0.8.3/scripts/install.sh | sh
```

Back up task state **and the original Git repositories** before upgrading.
Follow [backup and restore](https://github.com/Pepewitch/wisp/blob/v0.8.3/docs/INSTALL.md#back-up-and-restore-a-wisp-home); copying `.wisp`
alone does not preserve linked worktrees or unpublished Git objects.
This release adds database migration 29, so a 0.8.2 daemon cannot reopen a profile that 0.8.3 has opened.

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
preparation, the 0.8.3 artifact gates are pending; the [qualification ledger](https://github.com/Pepewitch/wisp/blob/main/docs/v0.8/QUALIFICATION.md)
records the final outcome separately from these immutable release notes.

In this release: Review now's follow-ups are open in #472 (a cancelled queued
auto-fix message on a profile upgraded mid-review can give one extra round).
The touch long-press drag was verified with synthetic touches in a browser,
not yet on a device (#470). droid and opencode pins were not refreshed.
Native dependency advisories still include upstream maintenance notices and a
locked Linux-only glib warning. Full clean-machine provider journeys, a
human-observed Desktop upgrade across this version, broad OS coverage, and
cross-machine restore remain incomplete. Task export excludes repositories and
provider sessions; it is not a complete backup or an import format. Permanent
deletion is logical, not forensic erasure. This release is not a security
certification.

## Release assets

The release contains these ten immutable assets:

- `wisp-v0.8.3-linux-x86_64`
- `release-manifest.json`
- `SHA256SUMS`
- `wisp-v0.8.3-darwin-arm64.tar.gz`
- `release-manifest-darwin-arm64.json`
- `SHA256SUMS-darwin-arm64`
- `wisp-desktop-v0.8.3-darwin-arm64.tar.gz`
- `wisp-desktop-v0.8.3-darwin-arm64.tar.gz.sig`
- `release-manifest-desktop-darwin-arm64.json`
- `SHA256SUMS-desktop-darwin-arm64`
