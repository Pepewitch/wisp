# Wisp 0.8.4

Wisp 0.8.4 makes auto-review usable on repositories with slow CI and a review
bot, lets the CLI switch a task's model, and makes the Claude usage gauge
reliable again.

- **Review on ready (new default).** Auto-review now starts a round once a
  head is ready and settled, alongside CI, instead of after green checks.
  Merging still waits for green required checks. To keep the old order for a
  project, set Project settings → Auto-review starts to "checks"
  (`repos[].reviewStart: "checks"`).
- **No more cancelled reviews.** While a round runs, auto-fix holds red CI and
  review comments. A rejection reaches the author in one combined message for
  one push.
- **Switch a task's model from the CLI.** `wisp send <id> "continue" --model
  <m>` moves a task to another model and keeps its id, session and PR.
- **Claude limits in about a second.** The usage popover reads Claude's plan
  limits with a lighter request and no longer times out on a busy machine.

## What changed since 0.8.3

- **Auto-review starts on ready, holds auto-fix, and sends one round** (#475).
  - **Start.** A round starts once a head is out of draft, has settled for a
    couple of minutes and the author is idle, while CI runs. If auto-fix is
    about to send a CI fix, that goes first. `reviewStart: "checks"` in a
    project's settings restores the old wait for green checks.
  - **Hold.** While the round runs, auto-fix holds red CI, bot and human
    comments and conflicts, so a push no longer cuts the review short. The
    status says "Auto-fix will send after the review", and Send now still
    overrides it.
  - **Combined message.** A rejection goes to the author together with what
    auto-fix held, as one message.
  - **Budget.** Only rejections spend it: three per PR, and Resume grants
    three more. A pass is free. Rounds that end without a verdict (pushed
    over, an error, a recipe hold) are free for the PR's first six; after
    that, the PR waits for its checks and each further one counts.
- **Claude usage limits read with `get_usage`** (#479). claude-code's
  `/usage` now scans every local session transcript of the past week, which
  made the limits read take up to ~19s under load and trip its 20s limit.
  Wisp now asks claude's `get_usage` control request with the transcript scan
  skipped, on a session that never sees a prompt, so it costs no model
  tokens. It answers in about a second, and the popover shows Claude's plan
  type. An older claude falls back to `/usage`.
- **`wisp send` switches the model, effort or harness** (#482, closes #481).
  `--model <m>` and `--effort <level>` change a task's agent with the message
  that continues it, keeping its session; `--harness <h> --model <m>
  --fresh-context` changes the harness. `--when next-turn` queues the switch
  without touching a running turn, and `--when now` stops it. A model or
  effort the harness does not offer is refused with the offered list. Useful
  when a provider reports a model at capacity.
- **Homebrew Cask style** (#480). The Desktop Cask lists its `depends_on`
  stanzas in the order current Homebrew's `brew style` requires; the old
  order failed the publication audit.
- **Skill and docs** (#478). The bundled `wisp` skill now covers auto-review,
  the PR autopilot flow, and following up with subtasks.

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
channel URL remains compatible and advertises the regular 0.8.4 version.
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
  https://raw.githubusercontent.com/Pepewitch/wisp/v0.8.4/scripts/install.sh | sh
```

Back up task state **and the original Git repositories** before upgrading.
Follow [backup and restore](https://github.com/Pepewitch/wisp/blob/v0.8.4/docs/INSTALL.md#back-up-and-restore-a-wisp-home); copying `.wisp`
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
preparation, the 0.8.4 artifact gates are pending; the [qualification ledger](https://github.com/Pepewitch/wisp/blob/main/docs/v0.8/QUALIFICATION.md)
records the final outcome separately from these immutable release notes.

In this release: the default auto-review start changes for every project
(see above). Repeated reworded bot findings are not yet deduplicated (#476). A
parent's `wisp send` to a subtask still does not report back (#477). droid and
opencode pins were not refreshed.
Native dependency advisories still include upstream maintenance notices and a
locked Linux-only glib warning. Full clean-machine provider journeys, a
human-observed Desktop upgrade across this version, broad OS coverage, and
cross-machine restore remain incomplete. Task export excludes repositories and
provider sessions; it is not a complete backup or an import format. Permanent
deletion is logical, not forensic erasure. This release is not a security
certification.

## Release assets

The release contains these ten immutable assets:

- `wisp-v0.8.4-linux-x86_64`
- `release-manifest.json`
- `SHA256SUMS`
- `wisp-v0.8.4-darwin-arm64.tar.gz`
- `release-manifest-darwin-arm64.json`
- `SHA256SUMS-darwin-arm64`
- `wisp-desktop-v0.8.4-darwin-arm64.tar.gz`
- `wisp-desktop-v0.8.4-darwin-arm64.tar.gz.sig`
- `release-manifest-desktop-darwin-arm64.json`
- `SHA256SUMS-desktop-darwin-arm64`
