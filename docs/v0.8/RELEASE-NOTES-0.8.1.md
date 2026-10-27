# Wisp 0.8.1

Wisp 0.8.1 is a feedback release on top of 0.8.0's task screen. The tool
panel now opens and closes in one smooth motion, the composer can mention
projects and their files with `@`, and you can set a default effort per model
and put your projects in the order you want.

- **`@` mentions in the composer.** Type `@` to pick a Wisp project or a file
  or folder inside one; Wisp inserts its absolute path.
- **Your order, your defaults.** Drag projects in the sidebar to reorder them,
  and star an effort level next to a model to make it the default for new
  tasks.
- **A steadier task screen.** Opening or closing a tool no longer makes the
  conversation jump, and Wisp's own messages no longer look like yours.

## What changed since 0.8.0

### New

- **`@` mentions** (#451). In the new-task and message composers, `@` lists
  your Wisp projects; Enter (or a click) inserts the project's absolute path,
  and Tab, → or typing `/` after an exact name opens it to list its folders
  and files. Paths with spaces are quoted. `.git` and git-ignored entries are
  left out, and a project whose ignore rules git cannot read says so instead
  of listing everything. Two projects with the same name are both offered.
- **Reorder projects** (#454). Drag a project's header in the sidebar, use
  **Move up** / **Move down** in its new `⋯` menu, or press Alt+↑ / Alt+↓ on a
  focused header. The order is saved by the daemon, so every client shows the
  same one. A daemon older than 0.8.1 shows no reorder controls.
- **A default effort per model** (#453). Each level in the Effort menu has a
  star, like the model rows. A star belongs to one harness and model; a model
  without one starts at the harness's default as before. Starring never
  changes the level already picked in an open dialog.
- **The PR number opens the PR** (#443). In the summary card, the pull request
  row's number is a link; the chevron still expands the row.

### Fixed and improved

- **Tool panel motion** (#449). Opening or closing a tool glides the panel and
  re-centres the conversation in one motion; the summary card folds with it
  instead of jumping. Dragging the divider moves things directly, with no
  bounce. The state dot stays before the title.
- **System messages** (#444). Wisp's notices (auto-fix, auto-review,
  auto-merge, heartbeats) and the harness's own turns render as labelled
  system blocks rather than as your messages; `wisp show` labels them too.
  Existing transcripts are relabelled by database migration 28.
- **Improve builds on a waiting draft** (#452). When a verification recipe
  draft is waiting, **Improve**, **Fix** and **Set up** start from that draft
  instead of the active recipe, and project settings show the recipe's (or
  draft's) age. `wisp verify checkout` returns the newest draft by default
  (`--active` for the active recipe).
- **Scrollbar at the edge** (#450). The conversation's scrollbar sits at the
  centre pane's outer edge, past the summary card, instead of beside the
  reading column.
- **Sidebar divider** (#447). Dragging the sidebar's divider resizes it again.
- **Desktop connection picker** (#445). One connection picker keeps the top
  bar on the sidebar's line.

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
channel URL remains compatible and advertises the regular 0.8.1 version.
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
  https://raw.githubusercontent.com/Pepewitch/wisp/v0.8.1/scripts/install.sh | sh
```

Back up task state **and the original Git repositories** before upgrading.
Follow [backup and restore](https://github.com/Pepewitch/wisp/blob/v0.8.1/docs/INSTALL.md#back-up-and-restore-a-wisp-home); copying `.wisp`
alone does not preserve linked worktrees or unpublished Git objects.
This release adds database migration 28, so a 0.8.0 daemon cannot reopen a profile that 0.8.1 has opened.

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
preparation, the 0.8.1 artifact gates are pending; the [qualification ledger](https://github.com/Pepewitch/wisp/blob/main/docs/v0.8/QUALIFICATION.md)
records the final outcome separately from these immutable release notes.

In this release: the Desktop drag region and the ⌘\\ and ⌃\` chords have
been verified in the browser runtime and by tests, not yet by a person on the
native app. `@` mentions list names only, never file contents; a few edge
cases are tracked in #457, and two project-reorder follow-ups in #456. Codex
turns recorded before 0.8.0 keep their partial usage (#428).
Native dependency advisories still include upstream maintenance notices and a
locked Linux-only glib warning. Full clean-machine provider journeys, a
human-observed Desktop upgrade across this version, broad OS coverage, and
cross-machine restore remain incomplete. Task export excludes repositories and
provider sessions; it is not a complete backup or an import format. Permanent
deletion is logical, not forensic erasure. This release is not a security
certification.

## Release assets

The release contains these ten immutable assets:

- `wisp-v0.8.1-linux-x86_64`
- `release-manifest.json`
- `SHA256SUMS`
- `wisp-v0.8.1-darwin-arm64.tar.gz`
- `release-manifest-darwin-arm64.json`
- `SHA256SUMS-darwin-arm64`
- `wisp-desktop-v0.8.1-darwin-arm64.tar.gz`
- `wisp-desktop-v0.8.1-darwin-arm64.tar.gz.sig`
- `release-manifest-desktop-darwin-arm64.json`
- `SHA256SUMS-desktop-darwin-arm64`
