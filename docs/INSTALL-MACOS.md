# Install and update Wisp on Apple Silicon

The custom tap and native Mac artifact are public. Alpha.6 is the current
maintenance prerelease. Apple Silicon support remains experimental and has
only limited single-machine qualification.

## Scope and security notice

The experimental v0.4 target is:

- Apple Silicon arm64 only;
- qualified on a limited Apple Silicon test environment;
- installed from the fully qualified custom Homebrew tap; and
- ad-hoc signed, not Developer ID signed or notarized.

Intel Macs are unsupported. One-machine testing does not prove every
Apple Silicon model or macOS version. Because the alpha is not notarized,
Gatekeeper may require explicit approval in System Settings. Do not disable
Gatekeeper globally. Verify that the download URL is under
`github.com/Pepewitch/wisp`, that Homebrew accepts the recipe checksum, and
that `wisp version --json` reports the release version and commit.

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

## Install and activate

Install from the public tap:

```sh
brew install Pepewitch/tap/wisp
```

Homebrew downloads the immutable arm64 release asset and verifies its SHA-256
from the Formula. The Formula rejects Intel Macs and does not require Bun.

Initialize production state and start the managed launchd service:

```sh
wisp init
brew services start wisp
wisp token
wisp doctor --harness droid
```

Open the URL printed by `wisp token`, register a repository, and complete one
task plus browser follow-up. Do not assume the URL ends in `:8710`; use the
persisted URL printed by Wisp.

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

The restart is immediate. Open web terminal shells stop, and an in-progress
task setup may need to be retried. Running turns retain their durable logs and
are reconciled by the new daemon.

The command-line fallback is:

```sh
brew update
brew upgrade wisp
brew services restart wisp
wisp version
wisp doctor --harness droid
```

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

```sh
brew services stop wisp
brew uninstall wisp
```

Homebrew removes its managed binary and service definition. It does not remove
`~/.wisp`; inspect that directory and all referenced worktrees before deleting
anything manually.
