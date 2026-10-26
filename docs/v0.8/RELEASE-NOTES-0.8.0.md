# Wisp 0.8.0

Wisp 0.8.0 redesigns the task screen, in the browser and in Desktop, around
the conversation: one centred reading column, the task's title and status in
the top bar, tools that open only when you ask for them, and a small summary
card in place of the always-open right column.
- **A calmer task screen.** The header above the conversation is gone, and the
  right column with its tab strip is replaced by top-bar icons that open one
  tool at a time. A summary card beside the conversation holds the task's
  state, pull request, autopilot, subtasks and context.
- **A phone layout to match.** A title and one status line replace the banded
  header, and a task sheet replaces the six tabs.
- **Auto-review can fall back to another reviewer** when a reviewer's
  provider, network or setup fails, instead of ending the round as an error.

## What changed since 0.7.2

### The task screen (#430–#435)

- **One reading column** (#430). The transcript and the composer share a
  centred column about 680 px wide; the whole centre still scrolls, so the
  wheel works over the margins. Long code blocks, tables and diagrams scroll
  inside the column.
- **The top bar carries the task** (#431). The title, its state dot and a
  subtask's parent crumb sit in the top bar. The title opens a menu with the
  task's id, branch and agent, and every action the old `⋯` menu had, plus
  **Copy task id** and **Copy branch name**. The header above the
  conversation is gone; the cleanup and worktree notices remain, in the
  column, only when they ask for something. The Updates control is an icon;
  its popover names the daemon's version. In Desktop, the whole empty stretch
  of the top bar now drags the window, and the connection tabs scroll inside
  a capped strip instead of crowding out the title.
- **Tools on demand** (#432). Terminal, Changes, Autopilot, Subtasks and
  Workflows open from icons in the top bar into one panel, closed by default.
  Each task remembers what it had open. The Terminal can dock below another
  tool. ⌃\` toggles the Terminal, ⌘\\ (Ctrl+\\ elsewhere) toggles the panel,
  and `/terminal`, `/changes` and the other tool names work in the `/`
  palette. Closing a tool only hides it: shells keep running. Your saved
  split from 0.7.x is carried over once: the old right column's width becomes
  the panel's open width.
- **The summary card** (#433). Beside the column, one row each for the
  task's state, pull request (CI, review and merge state), autopilot (with
  its three switches), subtasks and context; each row opens in place. Below
  about 1000 px of pane width, or when you fold it, the card becomes a chip
  after the title that opens the same card. The task menu's autopilot
  checkboxes and the top bar's PR link moved here.
- **Phone** (#434). A title over one status line (state, pull request, CI),
  which turns amber when a question waits for you. The task button opens a
  sheet with the summary card, the five tools and Find, Rename, Subtask and
  Archive; a tool opens full screen with a back row.
- **Live updates connect at once** (#435). The events stream now says it is
  open as soon as it is. Before, a browser waited for the first event or the
  15-second heartbeat after every page load and reconnect, and a phone showed
  "Live updates delayed" or "disconnected" in the meantime. The same PR fixes
  ten smaller layout, focus and accessibility details from the redesign's
  reviews.

### Auto-review and subtasks

- **Fallback reviewers** (#427). A project can name a fallback agent for each
  reviewer (`wisp verify fallback a|b <harness> …`, the API, or project
  settings). When a reviewer's task fails on the network, on its provider
  (a 5xx, an overload, "unavailable") or in setup before its prompt, the same
  review is handed to the fallback once, for the same round and head. A
  verdict, a malformed verdict, the time limit and a usage limit never fall
  back. The substitution is recorded in the round's history, `wisp review
  show` and the round panel. Off until you set one.
- **A subtask's first prompt is its own** (#429). It no longer ends with its
  parent's first prompt, which in a long-lived parent was often about
  something else; a renamed parent's title still follows, quoted.

### Usage

- **Codex turns record their whole usage** (#426). A codex turn's stored
  usage is now the sum of its model calls, not the last call alone, so token
  totals for codex tasks are comparable with other harnesses. Turns stored
  before 0.8.0 keep their old figure.

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
channel URL remains compatible and advertises the regular 0.8.0 version.
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
  https://raw.githubusercontent.com/Pepewitch/wisp/v0.8.0/scripts/install.sh | sh
```

Back up task state **and the original Git repositories** before upgrading.
Follow [backup and restore](https://github.com/Pepewitch/wisp/blob/v0.8.0/docs/INSTALL.md#back-up-and-restore-a-wisp-home); copying `.wisp`
alone does not preserve linked worktrees or unpublished Git objects.
This release adds database migration 27, so a 0.7.2 daemon cannot reopen a profile that 0.8.0 has opened.

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
preparation, the 0.8.0 artifact gates are pending; the [qualification ledger](https://github.com/Pepewitch/wisp/blob/main/docs/v0.8/QUALIFICATION.md)
records the final outcome separately from these immutable release notes.

This release's own limits: the Desktop window drag by the top bar and the
⌘\\ / ⌃\` shortcuts were reviewed in code and in the browser, not yet observed
in the signed Desktop app. On a codex thread created by an older codex, a
turn that follows an interrupted turn can still miscount its first model
call (#428). A fallback reviewer launches at once, so during a machine-wide
network outage it is likely to fail the same way.
Native dependency advisories still include upstream maintenance notices and a
locked Linux-only glib warning. Full clean-machine provider journeys, a
human-observed Desktop upgrade across this version, broad OS coverage, and
cross-machine restore remain incomplete. Task export excludes repositories and
provider sessions; it is not a complete backup or an import format. Permanent
deletion is logical, not forensic erasure. This release is not a security
certification.

## Release assets

The release contains these ten immutable assets:

- `wisp-v0.8.0-linux-x86_64`
- `release-manifest.json`
- `SHA256SUMS`
- `wisp-v0.8.0-darwin-arm64.tar.gz`
- `release-manifest-darwin-arm64.json`
- `SHA256SUMS-darwin-arm64`
- `wisp-desktop-v0.8.0-darwin-arm64.tar.gz`
- `wisp-desktop-v0.8.0-darwin-arm64.tar.gz.sig`
- `release-manifest-desktop-darwin-arm64.json`
- `SHA256SUMS-desktop-darwin-arm64`
