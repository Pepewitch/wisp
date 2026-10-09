# Wisp 0.6.9

Wisp 0.6.9 lets each model choose how a new task starts, and smooths a few
rough edges in Browser and Desktop.
- **Per-model task defaults.** Each model can start new tasks with or without
  a task brief, auto-fix and auto-merge. A brief is now on by default.
- **Ultracode for Claude.** Claude tasks can run at the `ultracode` effort
  level.
- **Desktop keeps `--` as typed.** The composer no longer turns two hyphens
  into an em dash.

## What changed since 0.6.8

### Starting tasks

- **Set brief, auto-fix and auto-merge per model** (#377) in the Models modal
  (Settings → Models → Manage…, or **Manage models…** in the picker). The "…"
  on a model's row opens the three switches, and a muted note on the row names
  any switch that differs from the default. The composer starts a task with
  the chosen model's defaults; you can still change any switch for one task,
  and picking another model resets them to that model's defaults.
- **A task brief is on by default** (#377) for every model. Before, the
  composer started with the brief off. Auto-fix and auto-merge stay off unless
  you turn them on for a model.
- **`ultracode` is a Claude effort level** (#376). It appears in the effort
  menu for Claude, and `wisp new --effort ultracode` works from the CLI.

### Browser and Desktop

- **Previews grow out of what you clicked** (#374). A file, text attachment,
  image or video preview opens from the point you clicked and shrinks back
  toward it when closed. With reduced motion turned on, dialogs no longer
  animate; that setting was previously ignored for dialogs.
- **Long task titles wrap in the hover card** (#373). A title such as a pasted
  URL used to spill past the card's edge.
- **Droid tool calls are titled by their summary** (#372) when the call has no
  description, instead of by the raw command. Expanding a row still shows the
  full command and output.
- **Desktop no longer turns `--` into an em dash** (#371). Typing `--force`
  in the composer now sends `--force`, whatever the macOS "smart quotes and
  dashes" setting. Smart quotes are unchanged, and the system setting and
  other apps are untouched.

### Also

- Dependencies move past two new advisories (#379): `source-map-js` 1.2.2
  for the build tools, and KaTeX 0.18 for math in Mermaid diagrams.

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
channel URL remains compatible and advertises the regular 0.6.9 version.
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
  https://raw.githubusercontent.com/Pepewitch/wisp/v0.6.9/scripts/install.sh | sh
```

Back up task state **and the original Git repositories** before upgrading.
Follow [backup and restore](https://github.com/Pepewitch/wisp/blob/v0.6.9/docs/INSTALL.md#back-up-and-restore-a-wisp-home); copying `.wisp`
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
preparation, the 0.6.9 artifact gates are pending; the [qualification ledger](https://github.com/Pepewitch/wisp/blob/main/docs/v0.6/QUALIFICATION.md)
records the final outcome separately from these immutable release notes.

Specific to this release:
- Per-model defaults apply only in the Browser and Desktop composer.
  `wisp new` and the API still use only the values they are sent.
  Against an older daemon, the Models modal shows no switches and the composer
  uses the built-in defaults.
- `ultracode` runs at Claude's `xhigh` effort and cannot be combined with
  another level. On a Claude model without ultracode, such as Haiku, it has no
  effect, and Wisp does not say so.

The image-output and attachment-preview limits listed for
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

- `wisp-v0.6.9-linux-x86_64`
- `release-manifest.json`
- `SHA256SUMS`
- `wisp-v0.6.9-darwin-arm64.tar.gz`
- `release-manifest-darwin-arm64.json`
- `SHA256SUMS-darwin-arm64`
- `wisp-desktop-v0.6.9-darwin-arm64.tar.gz`
- `wisp-desktop-v0.6.9-darwin-arm64.tar.gz.sig`
- `release-manifest-desktop-darwin-arm64.json`
- `SHA256SUMS-desktop-darwin-arm64`
