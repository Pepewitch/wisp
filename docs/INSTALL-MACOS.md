# Install Wisp Desktop and the daemon on Apple Silicon

Alpha.8 is the first Wisp Desktop prerelease. Apple Silicon support remains
experimental and has only limited single-machine qualification.

## Scope and security notice

The experimental v0.4 target is:

- Apple Silicon arm64 only, with a configured macOS 12.3 minimum;
- qualified on a limited Apple Silicon test environment;
- installed from the fully qualified custom Homebrew tap; and
- ad-hoc signed, not Developer ID signed or notarized.

Intel Macs are unsupported. The configured 12.3 deployment target is enforced
by the app metadata and Mach-O loader command, but it is not evidence that
12.3 or every later macOS version has been qualified. Local release
qualification used Apple Silicon macOS 26.6.2. Because the alpha is not
notarized, Gatekeeper may require Finder's Open command or explicit approval
in Privacy & Security. Do not disable Gatekeeper globally. Verify that the
download URL is under `github.com/Pepewitch/wisp`, that Homebrew accepts the
recipe checksum, and that `wisp version --json` reports the release version
and commit.

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
connection deletes the saved remote metadata and Keychain credential even
when the daemon is offline; it does not stop remote agents or delete daemon
projects, tasks, worktrees, or history.

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

The web header shows the running daemon version. When GitHub has a newer
published Wisp release, a Homebrew installation running under its registered
launchd service shows an **Update** button. Wisp asks Homebrew to refresh and
upgrade the Formula, verifies the newly installed binary's version, exits, and
lets launchd start the upgraded binary. The browser reloads only after the new
daemon answers its health check.

In Wisp Desktop, that header control applies to the daemon on the selected
connection; it does not upgrade the desktop Cask. Upgrade the app through
Homebrew as shown below.

The restart is immediate. Open web terminal shells stop, and an in-progress
task setup may need to be retried. Running turns retain their durable logs and
are reconciled by the new daemon.

Upgrade the Formula first, then the Cask:

```sh
brew update
brew upgrade Pepewitch/tap/wisp
brew upgrade --cask Pepewitch/tap/wisp-desktop
brew services restart wisp
wisp version
wisp doctor --harness droid
```

If the desktop Cask is not installed yet, replace its upgrade command with
`brew install --cask Pepewitch/tap/wisp-desktop`.

Because this alpha is only ad-hoc signed, Keychain authorization continuity is
not as predictable as it will be with a stable Developer ID signature. If a
future desktop upgrade reports a saved remote as not ready, reconnect it and
enter the token again; do not weaken Keychain access controls.

Wisp must not overwrite Homebrew's binary with a self-updater. An upgrade
changes the managed executable and preserves `~/.wisp`, repositories, task
history, branches, worktrees, and user changes.

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
use **Reset Desktop Data** before uninstalling. Cask uninstall quits and
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
