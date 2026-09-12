# Wisp 0.5.7

Wisp 0.5.7 is a regular pre-1.0 release of both the daemon and Desktop app.
Installer-managed Linux daemons can now opt into automatic updates under
Supervisor, workflows move out of a modal into the task's right column, and
the file viewer gains a full-file diff mode.

## What changed since 0.5.6

- **Workflows live beside the diff.** An armed workflow is standing state
  belonging to one task, so it now renders as a pane in the task's right
  column beside Changes, instead of a button that opened a modal over the
  whole task. What is armed is visible without opening anything, and
  configuration no longer scrolls a two-column modal. (#183)
- **Linux daemons under Supervisor can self-update.** An installer-managed
  daemon running under Supervisor may opt into automatic updates. Updates stay
  disabled unless Supervisor's injected process and group names both equal
  `wisp`, `supervisorctl pid wisp` matches the daemon's exact PID, and the
  environment names `supervisord`; the existing verified activation and
  supervised restart flow is unchanged. (#187)
- **A blocked update says why, and what to do.** A daemon managed by systemd
  or Homebrew services cannot self-update in place; the update status now
  explains that, walks through the recovery steps for each supported service,
  and warns that the active terminal may disconnect. (#186)
- **The file viewer can show a full-file diff.** Opening a file from Changes
  offers a File/Diff toggle: Diff renders editor-style inline additions and
  deletions across the whole current file, File keeps the syntax-highlighted
  read. Rich previews and diff rows stay bounded by the daemon's existing
  512 KiB caps, and a capped patch is presented conservatively rather than as
  a complete change. (#181)
- **A finished turn names its resume command.** When a task holds a stored
  session, the right edge above the steer composer shows the command that
  continues that session outside Wisp — built from each harness's own attach
  template — with a copy button carrying the whole working line. (#178) The
  hint displays as `session: <id>` with the copy button, small enough to never
  need truncating; the copy always carries the full command. (#184)
- **Mermaid diagrams wear Wisp's palette.** Rendered diagrams use the app's
  own theme variables instead of mermaid's near-black stock dark theme, so a
  node is drawn by its violet border over the page's own surfaces, in both
  light and dark. (#182) Dragging no longer lurches behind the cursor — the
  eased transition and per-event re-renders are gone — and a diagram may grow
  past its container. (#180)
- **Desktop's top bar loses the mark.** The traffic lights and connection tabs
  own the 36px bar; the mark stays in the browser. (#177)
- Internal hygiene: the release gates now enforce the pinned install URLs in
  README and the Linux guide, the release playbook records its escape hatches,
  the Desktop build treats the embedded UI bundle as a build input and names
  the missing-bundle error, and the qualification ledger records 0.5.6.
  (#179, #176, #185)

## Install or upgrade

Apple Silicon macOS (12.3 configured minimum):

```sh
brew install --cask Pepewitch/tap/wisp-desktop
open -a Wisp
```

The Cask installs the separate daemon Formula as a dependency. Existing
updater-capable Desktop builds can use **Updates → Check now**, then **Update
Desktop and relaunch**. Update **Local daemon** separately. The legacy alpha
channel URL remains compatible and advertises the regular 0.5.7 version.
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
  https://raw.githubusercontent.com/Pepewitch/wisp/v0.5.7/scripts/install.sh | sh
```

Back up task state **and the original Git repositories** before upgrading.
Follow [backup and restore](https://github.com/Pepewitch/wisp/blob/v0.5.7/docs/INSTALL.md#back-up-and-restore-a-wisp-home); copying `.wisp`
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
preparation, the 0.5.7 artifact gates are pending; the [qualification ledger](https://github.com/Pepewitch/wisp/blob/main/docs/v0.5/QUALIFICATION.md)
records the final outcome separately from these immutable release notes.

Supervisor updates cover installer-managed `supervisord` services only, and
stay off until the operator opts in; custom supervisors and bare daemons
remain manual upgrades. The full-file diff and rich previews stay bounded by
the daemon's 512 KiB file and diff caps, so a very large change shows its cap
rather than an unlimited page. A resume command is offered only where the
harness's adapter declares a verified attach template.
Native dependency advisories still include upstream maintenance notices and a
locked Linux-only glib warning. Full clean-machine provider journeys, a
human-observed Desktop upgrade across this version, broad OS coverage, and
cross-machine restore remain incomplete. Task export excludes repositories and
provider sessions; it is not a complete backup or an import format. Permanent
deletion is logical, not forensic erasure. This release is not a security
certification.

## Release assets

The release contains these ten immutable assets:

- `wisp-v0.5.7-linux-x86_64`
- `release-manifest.json`
- `SHA256SUMS`
- `wisp-v0.5.7-darwin-arm64.tar.gz`
- `release-manifest-darwin-arm64.json`
- `SHA256SUMS-darwin-arm64`
- `wisp-desktop-v0.5.7-darwin-arm64.tar.gz`
- `wisp-desktop-v0.5.7-darwin-arm64.tar.gz.sig`
- `release-manifest-desktop-darwin-arm64.json`
- `SHA256SUMS-desktop-darwin-arm64`
