# Install Wisp on macOS

Wisp Desktop supports **Apple Silicon**, with a configured minimum of
macOS 12.3. Intel Macs are unsupported. OS coverage is limited; see the
[qualification ledger](v0.5/QUALIFICATION.md) for tested journeys and gaps.

You need Homebrew, Git, a repository with a configured Git identity, and an
installed and authenticated harness: Droid, Claude Code, Codex, Cursor, or
OpenCode. Wisp runs as your user, not in a sandbox.

## Install the desktop app and daemon

```sh
brew install --cask Pepewitch/tap/wisp-desktop
open -a Wisp
```

The Cask includes the CLI/daemon Formula. Neither needs Bun or Node.
Homebrew checks the release checksums; current Desktop releases are Developer
ID signed and notarized. If macOS rejects a current app, stop and verify the
download and signature. Do not disable Gatekeeper or remove quarantine to
bypass that failure.

In Desktop:

1. Complete **Local** setup. Wisp asks before initializing `~/.wisp` or
   starting the Homebrew user service.
2. Add a repository with the folder picker.
3. Choose your harness and create a small task.

Desktop connects to the managed daemon; it does not start a second app-owned
daemon. Closing Desktop leaves the daemon and its tasks running.

### CLI-only installation

```sh
brew install Pepewitch/tap/wisp
wisp init
brew services start wisp
wisp project add /path/to/repo
wisp doctor --harness droid
wisp new /path/to/repo "Find a small bug, fix it, and run the tests." --harness droid
```

Use your repository path and harness. `wisp token` prints the URL and private
token for the browser UI. Use that URL rather than assuming port `8710`.

**Credentials:** launchd does not source your interactive shell configuration.
Per-user harness login files may be available while shell-exported API keys
are not. Doctor probes the shell that ran it, so verify authentication with a
real daemon-launched task. See
[service credentials](INSTALL.md#harness-credentials-under-a-service-manager)
if the two disagree.

## Add a remote daemon

Click `+` in Desktop and enter a name, URL, and token. The daemon must already
be reachable through trusted HTTPS or an exact-loopback SSH tunnel. Follow
[remote access](REMOTE-ACCESS.md); never expose the Wisp port to the internet.
Enter project paths as they exist on the remote machine, not your Mac.

Remote tokens stay in the macOS Keychain, outside the webview. Removing a
connection revokes its Desktop route and attempts to delete its saved
credential, without stopping or deleting remote tasks. If credential removal
fails, retry **Reset desktop data** or relaunch. For the protocol and storage
details, see [Desktop transport](DESKTOP-TRANSPORT.md).

## Upgrade

Open **Updates** in Desktop:

- **Wisp Desktop** installs the application update and relaunches it.
- **Local daemon** updates this Mac's managed daemon, regardless of the
  selected connection tab.

**Check now** installs nothing. Saved remote daemons must be updated on their
own host or through their browser UI. The two local update operations cannot
run together.

For the managed daemon alone:

```sh
wisp update
```

Updates preserve data and repositories, but restarting the daemon closes
terminal shells and can interrupt task setup. Running turns are reconciled
after restart. Take a [backup](INSTALL.md#back-up-and-restore-a-wisp-home)
first; the full update/rollback matrix is not qualified.

Homebrew is also the bootstrap and repair path, including for older apps
without an updater:

```sh
brew update
brew upgrade Pepewitch/tap/wisp
brew upgrade --cask --greedy Pepewitch/tap/wisp-desktop
brew services restart wisp
```

An in-app update does not update Homebrew's Cask receipt. The `--greedy`
command synchronizes it. For a damaged app, quit it and run
`brew reinstall --cask Pepewitch/tap/wisp-desktop`. See
[Desktop updates](DESKTOP-UPDATES.md) for signing, recovery, and compatibility.

## Troubleshooting

| Problem | Next step |
| --- | --- |
| Local daemon is unavailable | Run `brew services info wisp`, then `wisp doctor`. Start it with `brew services start wisp` if needed. |
| A green auth check but a failed task | Check the daemon's credentials, not just your shell's; see [service credentials](INSTALL.md#harness-credentials-under-a-service-manager). |
| Port is occupied | Inspect it with `lsof -nP -iTCP:8710 -sTCP:LISTEN`, substituting the port in `~/.wisp/config.json`. Stop the unintended listener or change Wisp's port, then restart the service. |
| Profile is already being served | Use that daemon or stop its supervisor before restarting. Never delete `daemon-owner.lock.db`. |
| Browser or tunnel cannot reconnect after a port change | Run `wisp token` and update bookmarks, tunnels, and proxy mappings to the persisted address. |

Initialization prefers port `8710`, trying `8711`–`8799` if needed. An existing
profile never silently changes ports. Separate daemons need separate
`WISP_HOME` directories and ports. For source development, use the isolated
workflow in [Contributing](../CONTRIBUTING.md).

## macOS permissions

Desktop, the CLI/daemon, and agent tools are separate executables. A macOS
permission prompt is not the same as a harness's tool-approval prompt.
Wisp's built-in harnesses run with approval bypass enabled; see the
[trust model](../SECURITY.md#trust-model).

The released CLI is currently **ad-hoc signed**, unlike Desktop. A different
CLI build can have a different identity to macOS and leave another `wisp`
entry in **Privacy & Security → App Management**. Changing its icon does not
stabilize that identity or reduce its access.

Do not infer from an entry alone that an operation was safe, that permission
is required, or which child tool triggered it. If a prompt is unexpected, deny
it and record the action and named requester. Check whether the task accesses
a protected folder or modifies an application. Do not grant Full Disk Access
or Accessibility as a blanket troubleshooting step.

For old App Management entries, first identify the installed executable with
`command -v wisp` and `ls -l "$(brew --prefix wisp)/bin/wisp"`. Remove only
entries you have identified in System Settings; revoking one may cause a
future access request. Avoid resetting all applications' permissions.
Optional [CLI icon stamping](../brand/README.md#cli-file-icons) helps label
installed binaries, but is not a security fix.

## Remove

To delete saved remote credentials, remove connections or use **Reset desktop
data** before uninstalling. Otherwise, Desktop metadata and Keychain entries
remain for a later reinstall.

```sh
brew uninstall --cask wisp-desktop
```

The daemon is separate. Remove it only when no longer needed:

```sh
brew services stop wisp
brew uninstall wisp
```

Homebrew preserves `~/.wisp`, repositories, branches, and worktrees.
Inspect retained data before deleting it; uninstalling does not clear macOS
privacy decisions.
