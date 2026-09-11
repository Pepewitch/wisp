<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="brand/wisp-logo-dark.svg" />
  <img src="brand/wisp-logo-light.svg" alt="Wisp" width="179" height="72" />
</picture>

**Run coding agents in parallel. Keep their work separate.**

Self-hosted · No Wisp account · Desktop, browser, phone, and CLI

</div>

Working on several things with coding agents usually means juggling terminals,
remembering which branch belongs to which task, and checking whether an agent
is finished or waiting for you.

Wisp gives each task its own Git worktree and branch, with one place to follow
progress, review diffs, and send follow-up instructions. Keep using your
existing **Droid, Claude Code, Codex, Cursor, or OpenCode** installation.

## Why Wisp

- **Work in parallel without sharing a checkout.** Give one agent a bug fix
  and another a feature. Their edits stay on separate task branches.
- **Pick up where you left off.** Read the conversation, inspect changes, open
  a terminal, or steer the next step. Tasks keep running when you close the UI.
- **Use the interface that fits.** Work locally in Desktop or the browser,
  script tasks from the CLI, and check in from your phone over a
  [private connection](docs/REMOTE-ACCESS.md).

## Install

Bring Git, a repository, and at least one installed and authenticated coding
agent. Wisp itself needs no Node or Bun runtime.

### macOS, Apple Silicon

```sh
brew install --cask Pepewitch/tap/wisp-desktop
open -a Wisp
```

This installs both Desktop and the CLI/daemon. In the app, finish Local setup,
add a repository, and create a task. For CLI-only installation and
troubleshooting, see the [macOS guide](docs/INSTALL-MACOS.md).

### Linux, x86_64

```sh
curl --proto '=https' --tlsv1.2 -fsSL \
  https://raw.githubusercontent.com/Pepewitch/wisp/v0.5.5/scripts/install.sh | sh
```

The installer verifies the download, installs under your home directory, and
starts a systemd user service when available. It does not use `sudo`.
For inspecting the script first, running without systemd, or fixing PATH,
see the [Linux guide](docs/INSTALL.md).

### Your first CLI task

With the daemon running, substitute your repository path and agent:

```sh
wisp project add /path/to/repo
wisp doctor --harness droid
wisp new /path/to/repo "Find a small bug, fix it, and run the tests." --harness droid
wisp token
```

Open the URL from `wisp token` and paste its token to follow the task in your
browser. Keep that token private. `wisp help` lists the CLI commands.

## Before you run an agent

**A worktree is not a sandbox.** Wisp runs agents as your OS user with their
tool-approval bypass enabled. They can access files, credentials, and the
network outside the task checkout. Use trusted repositories, review changes,
and use a separate OS account or disposable VM for untrusted work.

Wisp is pre-1.0 and intended for single-user use. Linux release gates cover
Ubuntu 24.04 x86_64; the binary requires glibc 2.17+ (no musl build).
Desktop targets Apple Silicon and macOS 12.3+, with limited OS qualification.
Intel Macs and Windows are unsupported. Desktop releases are signed and
notarized; the macOS CLI is currently ad-hoc signed.

## Go further

- [CLI reference](skills/wisp/references/cli.md)
- [Remote and phone access](docs/REMOTE-ACCESS.md)
- [Storage, archive, and cleanup](docs/ARCHIVE-CLEANUP.md)
- [Security and vulnerability reporting](SECURITY.md)
- [Release notes](https://github.com/Pepewitch/wisp/releases) and [tested limits](docs/v0.5/QUALIFICATION.md)

## Contribute

Bug reports, documentation fixes, and small PRs are welcome.
Start with [Contributing](CONTRIBUTING.md) for local setup and checks, or
[Architecture](docs/ARCHITECTURE.md) to understand the code.

[MIT](LICENSE) © 2026 pepewitch.
