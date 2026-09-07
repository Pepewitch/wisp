# Install Wisp Desktop and the daemon on Apple Silicon

Alpha.11 is the first Wisp Desktop prerelease prepared for
Developer ID signing, Apple notarization, and signed in-app updates. Apple
Silicon support remains experimental and has only limited single-machine
qualification.

## Scope and security notice

The experimental v0.4 target is:

- Apple Silicon arm64 only, with a configured macOS 12.3 minimum;
- qualified on a limited Apple Silicon test environment;
- installed from the fully qualified custom Homebrew tap; and
- for alpha.11, blocked from publication unless Developer ID signing,
  notarization, and stapling all succeed.

Intel Macs are unsupported. The configured 12.3 deployment target is enforced
by the app metadata and Mach-O loader command, but it is not evidence that
12.3 or every later macOS version has been qualified. Alpha.8 was ad-hoc signed
and may have required a per-app Gatekeeper exception. Alpha.11 is expected to
open normally only after its release workflow proves Developer ID signing,
notarization, and stapling. Do not disable or bypass Gatekeeper for an alpha.11
artifact that fails those checks. Verify the download URL is under
`github.com/Pepewitch/wisp`, that Homebrew accepts the recipe checksum, and that
`wisp version --json` reports the release version and commit.

## Before you start

You need:

- an Apple Silicon Mac (`uname -m` prints `arm64`);
- Homebrew;
- Git and a repository with `user.name` and `user.email`;
- at least one installed and authenticated harness: `droid`, `claude`,
  `codex`, or `cursor-agent`; and
- permission to approve the alpha explicitly if Gatekeeper prompts.

Wisp runs as your user so it can access your repositories and harness
credentials. Its state stays in `~/.wisp`, outside Homebrew's versioned prefix.
launchd does not source interactive shell startup files; the Formula must give
the service a path to Git and documented harness locations. Prefer each
harness's secure per-user login or keychain. Never put an API key in the
Formula or launchd plist.

## Install the desktop app and daemon

Install the desktop app from the public tap:

```sh
brew install --cask Pepewitch/tap/wisp-desktop
```

The Cask declares `Pepewitch/tap/wisp` as a required Formula dependency.
Homebrew therefore installs the CLI/daemon as part of this command when Wisp
is absent. Both recipes download immutable arm64 release assets and verify
their SHA-256 checksums. Neither requires Bun.

To install only the daemon, CLI, and browser UI, use:

```sh
brew install Pepewitch/tap/wisp
```

Launch the desktop app:

```sh
open -a Wisp
```

The signed and notarized alpha.11 artifact should not require **Open Anyway**.
If macOS says it cannot verify alpha.11 or offers to move it to Trash, stop and
check the installed version, Cask checksum, signature, and notarization ticket;
do not remove quarantine attributes or disable Gatekeeper. The per-app Privacy
& Security exception documented by Apple applies to the older ad-hoc alpha.8,
not to the expected alpha.11 release posture. See
[Open a Mac app from an unknown developer](https://support.apple.com/guide/mac-help/open-a-mac-app-from-an-unknown-developer-mh40616/mac).

On first launch, Local reports whether the standard Wisp profile and service
are ready. Wisp Desktop asks for confirmation before it initializes the
profile or starts the Homebrew service. It never starts a second child daemon
owned by the app.

The command-line equivalent initializes production state and starts the
managed launchd service:

```sh
wisp init
brew services start wisp
wisp token
wisp doctor --harness droid
```

The desktop Add Project action uses the native folder picker while Local is
active. You can still open the URL printed by `wisp token` to use the browser
UI. Do not assume the URL ends in `:8710`; use the persisted URL printed by
Wisp.

## Add a remote daemon

Click `+` in the desktop header and enter a unique tab name, the daemon URL,
and its access token. Wisp Desktop performs an authenticated capability check
before saving the connection, pins the daemon identity it reached, and stores
the token in the macOS Keychain. Tokens never return from native code to the
webview.

A URL and token do not create network connectivity. The remote daemon must
already be reachable through a trusted HTTPS route such as Tailscale Serve, or
through an exact-loopback user-managed tunnel. Never expose the Wisp port
directly to the public internet. When adding a project on a remote tab, enter
the absolute path as it exists on the remote daemon's machine; the local
folder picker is deliberately unavailable there.

Local and remote tab names are desktop-only labels and can be renamed. Remove
connection works while the daemon is offline: it immediately revokes the
desktop route and removes the active metadata, then attempts to delete the
Keychain credential. If credential cleanup fails, Wisp reports it and retains
a tombstone so **Reset desktop data** or the next launch can retry. Removal does
not stop remote agents or delete daemon projects, tasks, worktrees, or history.

Closing Wisp Desktop has the same non-destructive property: every daemon and
running agent continues independently.

## Port selection and collision behavior

Production state and its selected port live in `~/.wisp/config.json`.

- A new `wisp init` prefers `127.0.0.1:8710`.
- If that port is already occupied during first initialization, Wisp
  tries `8711` through `8799`, selects the first available loopback port, and
  persists it.
- If that complete range is occupied, initialization stops and asks for an
  explicit unused port, for example `wisp init --port 8800`.
- A later daemon restart never silently changes the persisted port.
- If another process later occupies that port, Wisp exits nonzero and names
  the address. It does not kill the process or choose another port behind your
  back.

Inspect the listener before changing anything:

```sh
port=8710 # replace with the configured port
lsof -nP -iTCP:"$port" -sTCP:LISTEN
```

If it is another Wisp instance, stop the instance you do not intend to use. If
it is another application, either move that application or edit the numeric
`port` in `~/.wisp/config.json`, then restart Wisp:

```sh
brew services restart wisp
wisp token
wisp doctor
```

Any Tailscale Serve, SSH tunnel, bookmark, or local integration must be updated
to the new URL. Keep `host` set to `127.0.0.1`.

## Upgrade

The browser header shows the running daemon version and an explicitly named
daemon update action when its Homebrew service can update safely. Wisp asks
Homebrew to refresh and upgrade the Formula, verifies the installed binary,
exits, and lets launchd start the new daemon. The browser reloads only after the
new daemon answers its health check.

Wisp Desktop has one **Updates** popover with two independent rows:

- **Wisp Desktop** checks and installs the global application version;
- **<selected connection> daemon** updates only that daemon.

Checking never installs. Desktop download and replacement start only after
**Update Desktop and relaunch** is clicked. The app checks once shortly after
launch by default, has a **Check now** action, and does not poll periodically.
A daemon update in progress temporarily disables Desktop relaunch.

The restart is immediate. Open web terminal shells stop, and an in-progress
task setup may need to be retried. Running turns retain their durable logs and
are reconciled by the new daemon.

Alpha.8 predates the Desktop updater. Bootstrap alpha.11 through Homebrew;
`--greedy` is required because the new Cask declares that the application can
update itself:

```sh
brew update
brew upgrade Pepewitch/tap/wisp
brew upgrade --cask --greedy Pepewitch/tap/wisp-desktop
brew services restart wisp
wisp version
wisp doctor --harness droid
```

If the desktop Cask is not installed yet, replace its upgrade command with
`brew install --cask Pepewitch/tap/wisp-desktop`.

After alpha.11 is installed, later Desktop upgrades use the signed Tauri
updater. Homebrew remains the recovery path:

```sh
brew update
brew reinstall --cask Pepewitch/tap/wisp-desktop
```

The updater and Cask install the same Developer ID signed, notarized archive.
The update channel, version, URL, release notes, size, and Minisign signature
are release-generated and native-controlled; the webview cannot choose them.
See [Desktop updates](DESKTOP-UPDATES.md) for the trust and qualification
contract.

Wisp Desktop never overwrites the Homebrew-managed daemon binary. An upgrade
changes the managed executable and preserves `~/.wisp`, repositories, task
history, branches, worktrees, user changes, Desktop metadata, and remote
Keychain credentials.

The button stays informational for a Homebrew binary started manually rather
than through `brew services`; Wisp cannot promise that such a process will
restart. Start the managed service before using automatic updates:

```sh
brew services restart wisp
```

An earlier alpha-to-alpha upgrade preserved config, history, branches,
worktrees, and repository work in one test environment. That is not broad
Apple Silicon support.

## Develop beside the installed service

Never point development at production `~/.wisp`. The repository's development
command defaults to separate state and port `18710`. Install its dedicated
source launcher once:

```sh
bun run dev:install-cli
bun run dev
```

The installed daemon then owns `~/.wisp` and its selected port. The development
daemon and Vite share `~/.wisp-dev` and port `18710`. If `18710` is occupied,
choose another unused development port before the first run:

```sh
wisp-dev init --port 18711
bun run dev
```

Open the development URL Vite prints, normally <http://localhost:5173>.

Use bare `wisp` for production and `wisp-dev` for development. The latter
ignores a globally exported `WISP_HOME` and always selects `~/.wisp-dev`
unless `WISP_DEV_HOME` explicitly chooses another non-production directory.
Do not copy the production token or database into the development home.

## Remove

If you want saved remote credentials deleted, remove each remote connection or
use **Reset desktop data** before uninstalling. Cask uninstall quits and
removes the application but intentionally has no destructive `zap`; desktop
metadata and remote Keychain entries otherwise remain available for a later
reinstall.

Remove only the desktop app:

```sh
brew uninstall --cask wisp-desktop
```

The daemon is a separate Formula and remains installed. Remove it only when it
is no longer needed:

```sh
brew services stop wisp
brew uninstall wisp
```

Homebrew removes its managed binary and service definition. It does not remove
`~/.wisp`; inspect that directory and all referenced worktrees before deleting
anything manually.
