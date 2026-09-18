# Wisp 0.5.11

Wisp 0.5.11 is a regular pre-1.0 release of both the daemon and Desktop
app. It turns Droid's interactive questions into answerable conversation
cards and marks tasks that still have a workflow attached.

## What changed since 0.5.10

- **Answer Droid questions without starting another turn.** When Droid uses
  `AskUser`, Wisp shows all questions and choices in one conversation card.
  Send the selections once and the same agent turn resumes where it paused;
  answered, superseded, expired, and stopped questions remain readable with
  their actual outcome. (#233)
- **Task status dots show attached workflows.** A sky-blue ring now marks a
  task with an active or paused workflow in the sidebar and task cards. A
  running agent keeps the higher-priority purple indicator, and workflow
  events refresh the marker immediately. (#234)
- Internal release hygiene: the 0.5.10 publication and promotion evidence is
  recorded without claiming qualification that did not run. (#232)

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
channel URL remains compatible and advertises the regular 0.5.11 version.
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
  https://raw.githubusercontent.com/Pepewitch/wisp/v0.5.11/scripts/install.sh | sh
```

Back up task state **and the original Git repositories** before upgrading.
Follow [backup and restore](https://github.com/Pepewitch/wisp/blob/v0.5.11/docs/INSTALL.md#back-up-and-restore-a-wisp-home); copying `.wisp`
alone does not preserve linked worktrees or unpublished Git objects.
This release adds no database migration.

## Scope and known limits

This release is for a trusted single OS user. Worktrees separate checkouts;
they do not sandbox agents or their credentials. There is no multi-user
permission boundary. Closing Desktop leaves daemons and agents running.
Intel macOS and non-Apple-Silicon Desktop builds are unsupported.

Desktop publication requires Developer ID signing, notarization, a stapled
ticket, and a verified updater signature. The macOS daemon remains ad-hoc
signed. Automated release gates verify immutable downloads and promote the
Formula, Cask, daemon channel, and Desktop channel together. At source
preparation, the 0.5.11 artifact gates are pending; the [qualification ledger](https://github.com/Pepewitch/wisp/blob/main/docs/v0.5/QUALIFICATION.md)
records the final outcome separately from these immutable release notes.

Interactive questionnaire cards require a Droid version that sends the
structured `droid.ask_user` request; older versions retain the message-based
**Needs input** fallback. Workflow rings show that standing workflow state is
attached, not that the workflow is currently executing.
Native dependency advisories still include upstream maintenance notices and a
locked Linux-only glib warning. Full clean-machine provider journeys, a
human-observed Desktop upgrade across this version, broad OS coverage, and
cross-machine restore remain incomplete. Task export excludes repositories and
provider sessions; it is not a complete backup or an import format. Permanent
deletion is logical, not forensic erasure. This release is not a security
certification.

## Release assets

The release contains these ten immutable assets:

- `wisp-v0.5.11-linux-x86_64`
- `release-manifest.json`
- `SHA256SUMS`
- `wisp-v0.5.11-darwin-arm64.tar.gz`
- `release-manifest-darwin-arm64.json`
- `SHA256SUMS-darwin-arm64`
- `wisp-desktop-v0.5.11-darwin-arm64.tar.gz`
- `wisp-desktop-v0.5.11-darwin-arm64.tar.gz.sig`
- `release-manifest-desktop-darwin-arm64.json`
- `SHA256SUMS-desktop-darwin-arm64`
