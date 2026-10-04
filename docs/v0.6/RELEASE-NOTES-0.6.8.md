# Wisp 0.6.8

Wisp 0.6.8 shows more of what an agent made and what you sent it, where it
happened in the conversation.
- **Images from agents.** An image an agent produces appears under that turn's
  reply in Browser and Desktop, and the CLI can list and save it.
- **Readable attachments.** A text file you attached opens in a viewer, and a
  csv or tsv shows its first rows under your message.
- **Clearer activity titles.** A tool call is titled by what the agent said it
  was doing, when it said so.

## What changed since 0.6.7

### Image outputs

- **Images an agent returns appear in the conversation** (#368), below the
  turn's reply in Browser and Desktop. Click one to expand it; Download saves
  the original file, through a native Save panel in Desktop and a browser
  download in Browser. Images stay available when activity is collapsed.
- **Captured automatically from Codex and Claude** (#368): Codex MCP image
  content and Claude base64 images in tool results are kept as task outputs.
- **Any harness can publish a file** (#368) with
  `wisp output add ./plot.png --turn <n>`. Wisp gives each ordinary turn the
  command with its turn number. `wisp output list` and `wisp output save`
  list and save a turn's images from the terminal, and `wisp show` names
  them. See [image outputs](https://github.com/Pepewitch/wisp/blob/v0.6.8/docs/IMAGE-OUTPUTS.md).
- **Images belong to the task** (#368), not the worktree: archives keep them,
  task export includes them, task storage counts them, and permanent deletion
  removes them.

### Attachments

- **Text attachments open in a viewer** (#366). Clicking a sent text file
  opens the same popup the Changes tab uses: Markdown rendered, a known
  language highlighted, anything else plain. Download is in the popup's
  footer. Before, a sent text file was only a download link.
- **csv and tsv files preview their first rows** (#366) under the message,
  with the file's rows, columns and size. **View all** opens the whole table,
  with a **Raw** tab for the original text.

### Activity

- **Tool calls are titled by their description** (#367) when the agent gave
  one, instead of the raw command. Calls without one keep their command, path
  or other argument as the title. Expanding a row still shows the full input,
  including the command, and its output.

### Also

- The build no longer depends on the `braces` package (#368): Wisp's own
  bundler step replaces the glob library that pulled it in. The shipped
  Browser and Desktop bundles keep their layout.

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
channel URL remains compatible and advertises the regular 0.6.8 version.
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
  https://raw.githubusercontent.com/Pepewitch/wisp/v0.6.8/scripts/install.sh | sh
```

Back up task state **and the original Git repositories** before upgrading.
Follow [backup and restore](https://github.com/Pepewitch/wisp/blob/v0.6.8/docs/INSTALL.md#back-up-and-restore-a-wisp-home); copying `.wisp`
alone does not preserve linked worktrees or unpublished Git objects.
This release adds database migration 22, so a 0.6.7 daemon cannot reopen a profile that 0.6.8 has opened.

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
preparation, the 0.6.8 artifact gates are pending; the [qualification ledger](https://github.com/Pepewitch/wisp/blob/main/docs/v0.6/QUALIFICATION.md)
records the final outcome separately from these immutable release notes.

Specific to this release:
- Images are captured automatically only from Codex MCP image content and
  Claude base64 images in tool results. Droid, Cursor, OpenCode, and tools
  that return a file path need `wisp output add`. Wisp does not guess images
  from other tool output.
- Image outputs accept PNG, JPEG, GIF and WebP, up to 8 MiB each and 32
  images or 64 MiB per turn. SVG is not supported, and the CLI prints file
  details and save commands rather than drawing images in the terminal.
- A text attachment preview reads at most 512 KB. Tables show at most 12
  columns, and the full table view stops at 1,000 rows; **Raw** shows every
  column. A pdf is still a download.

The icon-cache and tooltip limits listed for
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

- `wisp-v0.6.8-linux-x86_64`
- `release-manifest.json`
- `SHA256SUMS`
- `wisp-v0.6.8-darwin-arm64.tar.gz`
- `release-manifest-darwin-arm64.json`
- `SHA256SUMS-darwin-arm64`
- `wisp-desktop-v0.6.8-darwin-arm64.tar.gz`
- `wisp-desktop-v0.6.8-darwin-arm64.tar.gz.sig`
- `release-manifest-desktop-darwin-arm64.json`
- `SHA256SUMS-desktop-darwin-arm64`
