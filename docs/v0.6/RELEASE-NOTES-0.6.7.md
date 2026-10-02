# Wisp 0.6.7

Wisp 0.6.7 gives Wisp its own look and a smoother feel. A small flame spirit
with two eyes replaces the glass icosahedron as the mark, and the interface
moves with one quick, calm motion throughout.
- **A new mark.** The Desktop app icon, the phone's home-screen icon, the
  browser favicon and the mark in the top bar are the spirit now.
- **Tooltips that unfold.** Hovering or keyboard-focusing a control shows
  Wisp's own tooltip, instead of the browser's.
- **A composer that grows with your message.** The message box grows line by
  line as you type, instead of scrolling inside a fixed box.

## What changed since 0.6.6

### The spirit, Wisp's new mark

- **The spirit replaces the glass icosahedron** (#359): a small flame with two
  eyes and no mouth. It is the Desktop app icon, the phone's home-screen and
  touch icons, the browser favicon and the mark in the app's top bar. Small
  sizes use a flat drawing of the same silhouette, so it stays legible at
  16 px.

### Motion

- **Tooltips** (#358). Every control that names itself on hover now shows
  Wisp's own tooltip. The first one waits a moment, so a pointer crossing a
  toolbar shows nothing, and the next one along a row opens at once.
  Focusing a control from the keyboard shows it too; a field you are typing
  in never gets one. Touch screens keep their usual long-press.
- **Menus, popovers and dialogs** (#358) open from the control that opened
  them and settle into place, then close a little faster than they opened.
- **The composer** (#358) grows with your message, up to its usual limit, and
  glides to each new height. Before, a long message scrolled inside a fixed
  box three lines tall (two on a phone).
- **Reduced motion** turns all of it off: with the system setting on,
  everything appears and disappears at once, as before.

### Fixes

- **A connection tab carries one mark** (#364): its connection's health, the
  same on a selected tab and an inactive one. Before, an inactive tab could
  also show the dot of its busiest task, so two dots sat side by side and
  their colours collided: the amber of delayed live updates beside the amber
  of a task waiting for input. Delayed or dropped live updates are now a
  hollow grey ring. Which task needs you still shows in the connection
  switcher's menu, and desktop notifications are unchanged.
- **DOMPurify 3.4.16** (#363). The sanitizer that cleans mermaid diagrams
  moves past a low advisory
  ([GHSA-p98j-92pf-mc4p](https://github.com/advisories/GHSA-p98j-92pf-mc4p))
  affecting 3.4.13 to 3.4.15.

### Also

- The project README and the social preview are rewritten (#360, #361), with
  a short film of what Wisp does.

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
channel URL remains compatible and advertises the regular 0.6.7 version.
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
  https://raw.githubusercontent.com/Pepewitch/wisp/v0.6.7/scripts/install.sh | sh
```

Back up task state **and the original Git repositories** before upgrading.
Follow [backup and restore](https://github.com/Pepewitch/wisp/blob/v0.6.7/docs/INSTALL.md#back-up-and-restore-a-wisp-home); copying `.wisp`
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
preparation, the 0.6.7 artifact gates are pending; the [qualification ledger](https://github.com/Pepewitch/wisp/blob/main/docs/v0.6/QUALIFICATION.md)
records the final outcome separately from these immutable release notes.

Specific to this release:
- An existing Desktop install can keep showing the old icon in the Dock or
  Finder until macOS refreshes its icon cache, for example after a restart.
- Tooltips need a device with a pointer that can hover. On a phone or tablet
  Wisp shows none, keyboard focus included, and leaves long-press to the system.

The Autopilot-tab, background-process, `wisp audit` and GitHub-use limits
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

- `wisp-v0.6.7-linux-x86_64`
- `release-manifest.json`
- `SHA256SUMS`
- `wisp-v0.6.7-darwin-arm64.tar.gz`
- `release-manifest-darwin-arm64.json`
- `SHA256SUMS-darwin-arm64`
- `wisp-desktop-v0.6.7-darwin-arm64.tar.gz`
- `wisp-desktop-v0.6.7-darwin-arm64.tar.gz.sig`
- `release-manifest-desktop-darwin-arm64.json`
- `SHA256SUMS-desktop-darwin-arm64`
