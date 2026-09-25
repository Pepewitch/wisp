# Wisp 0.6.2

Wisp 0.6.2 shows how much of each harness's plan you have used, and keeps
unsent task drafts.
- **A usage ring in the top bar** shows the selected task's harness at its
  most-used plan window. Its panel lists the windows of claude, codex and
  droid, and `wisp limits` prints the same readings.
- **New task keeps your draft.** An unsent prompt, its attachments and its
  choices come back when you reopen New task for the same project.
- **Settings takes the API keys**: the review judge's Jev key, and a Factory
  API key for droid's limits. A daemon run by launchd or systemd never sees a
  key exported in a shell profile.

## What changed since 0.6.1

- **A usage ring for plan limits** (#293). A small ring in the top bar shows
  the selected task's harness at its most-used window, the limit that stops
  its next turn first. It is neutral below 80%, amber from 80%, and red at the
  limit. With no task selected, or a harness with no limits read, the ring is
  empty. Hover over it, or tap it on touch, to open a panel with a section
  for each of claude, codex and droid: each window's share used, and when it
  resets. On touch, the ring sits in the drawer footer beside the settings
  gear.
  - **claude:** the 5-hour and weekly windows, and the per-model week (for
    example Opus). Wisp runs `claude -p /usage`, a local command that uses no
    model tokens and is kept out of session history.
  - **codex:** the rate-limit windows its app-server reports, and the plan
    name.
  - **droid:** the Standard and Core pools, each with 5-hour, weekly and
    monthly windows, read from Factory's billing API with a Factory API key.
    Save one in **Settings → Usage limits**, which has a **Test** button, or
    set `FACTORY_API_KEY` or `DROID_API_KEY` in the daemon's environment. A
    saved key wins. A key that belongs to a different account than the one
    droid is signed in to is flagged instead of shown as yours.
  - A harness with nothing to show says why: not installed, no key, a key for
    another account, or a failed read. Only a failed read is red.
  - `wisp limits` prints the same readings in a terminal. `--refresh` reads
    again now, and `--json` prints the daemon's answer from
    `GET /api/harness-limits`.
  - The daemon keeps each reading for a minute. An open Wisp page asks once a
    minute while it is visible, and **Refresh** in the panel reads again.
  - A daemon older than 0.6.2 reports no limits, so the ring is hidden while
    it is the connection in view.
- **New task keeps an unsent draft for each project** (#294). Closing the
  dialog no longer discards the prompt, the pending attachments, or the
  choices: model, effort, fast mode, worktree or local mode, base branch,
  suffix prompt, auto-merge and auto-fix. Reopening New task for the same
  project on the same connection restores them, and the global New task
  action reopens the project you last picked. A successful create clears only
  that project's draft; a refused one keeps it for a retry.
- **Settings → Review judge** (#292). 0.6.1's optional review judge can now
  get its Jev key from Settings, not only from the settings API or the
  daemon's environment.
  - The section shows the key's last four characters and where it came from,
    **Test** (one probe call, with how fast it answered or why it failed),
    **Replace…**, **Remove** for a saved key, and the month's calls,
    failures, cost and model.
  - A daemon older than 0.6.1 has no judge, so the section is hidden there.
- Both key fields are write-only. Settings never reads a key back and shows
  only its last four characters. A saved key is stored in the daemon's
  `config.json` (mode 0600), and it overrides one in the daemon's
  environment.
- Release hygiene: the 0.6.1 publication record (#291).

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
channel URL remains compatible and advertises the regular 0.6.2 version.
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
  https://raw.githubusercontent.com/Pepewitch/wisp/v0.6.2/scripts/install.sh | sh
```

Back up task state **and the original Git repositories** before upgrading.
Follow [backup and restore](https://github.com/Pepewitch/wisp/blob/v0.6.2/docs/INSTALL.md#back-up-and-restore-a-wisp-home); copying `.wisp`
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
preparation, the 0.6.2 artifact gates are pending; the [qualification ledger](https://github.com/Pepewitch/wisp/blob/main/docs/v0.6/QUALIFICATION.md)
records the final outcome separately from these immutable release notes.

Plan-limit readings:
- Each is read the way that harness's own CLI reads it: claude's `/usage`
  report, codex's app-server, and the Factory endpoint droid's usage panel
  calls. None is a documented API, so a harness update can turn its reading
  into a failed read until Wisp follows it.
- cursor and opencode have no limits read. The ring stays empty for their
  tasks, and the panel has no section for them.
- While a Wisp page is visible, the daemon starts an installed `claude` and
  `codex` about once a minute to read their limits. With a Factory API key
  set, it also calls `api.factory.ai` about once a minute.
- To check a Factory key's account, Wisp reads droid's unencrypted account
  cache in `~/.factory`, never its login files. Without that cache the
  account goes unchecked, and the limits are shown anyway.

Create-task drafts stay in the page's memory. Reloading a browser tab or
quitting Desktop loses them, and tabs do not share them.

The auto-merge and auto-fix limits listed for
[0.6.1](https://github.com/Pepewitch/wisp/blob/v0.6.1/docs/v0.6/RELEASE-NOTES-0.6.1.md#scope-and-known-limits)
still apply. The review judge is still an outside service: with a key set,
the review text it judges leaves the daemon host for TypeSafe's API, and its
answers follow the reviewer's wording, since it never sees the code.

Native dependency advisories still include upstream maintenance notices and a
locked Linux-only glib warning. Full clean-machine provider journeys, a
human-observed Desktop upgrade across this version, broad OS coverage, and
cross-machine restore remain incomplete. Task export excludes repositories and
provider sessions; it is not a complete backup or an import format. Permanent
deletion is logical, not forensic erasure. This release is not a security
certification.

## Release assets

The release contains these ten immutable assets:

- `wisp-v0.6.2-linux-x86_64`
- `release-manifest.json`
- `SHA256SUMS`
- `wisp-v0.6.2-darwin-arm64.tar.gz`
- `release-manifest-darwin-arm64.json`
- `SHA256SUMS-darwin-arm64`
- `wisp-desktop-v0.6.2-darwin-arm64.tar.gz`
- `wisp-desktop-v0.6.2-darwin-arm64.tar.gz.sig`
- `release-manifest-desktop-darwin-arm64.json`
- `SHA256SUMS-desktop-darwin-arm64`
