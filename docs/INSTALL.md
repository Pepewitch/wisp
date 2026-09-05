# Install and activate Wisp on Linux

This guide covers **Ubuntu 24.04 LTS, x86_64, glibc**.
`0.4.0-alpha.6` is an experimental maintenance prerelease. The Apple Silicon
Homebrew path is documented separately in
[INSTALL-MACOS.md](INSTALL-MACOS.md).

The alpha is machine-qualified, not human-validated. It is not production
support.

## Before you start

You need:

- an x86_64 Ubuntu 24.04 host;
- `curl`, `git`, `sha256sum`, and the standard `install` utility;
- a Git repository with a configured `user.name` and `user.email`;
- at least one installed and authenticated harness: `droid`, `claude`,
  `codex`, or `cursor-agent`.

Wisp must run on the same host and as the same user that can access the
repositories and harness authentication. It does not put a harness or its
account in a separate container.

## Public release install

Use the public release installer:

```sh
version=0.4.0-alpha.6 # replace with the current published alpha
curl --proto '=https' --tlsv1.2 -fsSL \
  "https://raw.githubusercontent.com/Pepewitch/wisp/v${version}/scripts/install.sh" |
  sh
```

The installer downloads the versioned Linux binary and `SHA256SUMS`, verifies
the binary checksum and embedded version/commit identity, initializes a private
`~/.wisp`, and atomically points `~/.local/bin/wisp` at the verified version.
It refuses to replace unmanaged files or directories.

### Staged candidate install

Maintainers can exercise exactly the same installer against a locally built
candidate:

```sh
bun run release:linux
artifact=dist/release/v0.4.0-alpha.6/wisp-v0.4.0-alpha.6-linux-x86_64
WISP_ARTIFACT_PATH="$artifact" \
WISP_SHA256="$(sha256sum "$artifact" | awk '{print $1}')" \
WISP_COMMIT="$(git rev-parse HEAD)" \
sh scripts/install.sh
```

Use `--no-service` to keep the daemon in a foreground terminal:

```sh
sh scripts/install.sh --no-service
~/.local/bin/wisp serve
```

If `~/.local/bin` is not on `PATH`, add it in your shell startup file:

```sh
export PATH="$HOME/.local/bin:$PATH"
```

## Activate

The installer runs `wisp init`; running it again is safe and prints the daemon
address:

```sh
wisp init
```

On a normal Ubuntu user session, the installer enables and starts
`wisp.service`. Otherwise, keep `wisp serve` in a foreground terminal or use a
restart-capable supervisor.

Register one repository after the daemon is reachable:

```sh
wisp project add /absolute/path/to/repository
```

Then ask doctor to require the harness you intend to use:

```sh
wisp doctor --harness droid
```

Fix the first `fail` line and rerun it. Activation is complete only when the
last line says:

```text
ok   activation: ready for a first task with droid
```

Create a first task:

```sh
wisp new /absolute/path/to/repository \
  "Run the tests, fix one failing case, and commit the change." \
  --harness droid
```

Use the returned task id with `wisp show`, `wisp log -f`, `wisp wait`, and
`wisp send`. Or run `wisp token`, open the URL it prints, paste the token once,
and use the built-in app.

## Port selection and development isolation

`~/.wisp/config.json` is the authority for the installed daemon's loopback
`host` and `port`. Initialization of a new home prefers
`127.0.0.1:8710`, detects an occupied default, tries `8711` through `8799`,
persists the first available loopback port, and prints the actual URL. If the
range is exhausted, initialization stops with an explicit
`wisp init --port <port>` recovery action. A later restart never silently
changes a persisted port.

If a configured port is occupied, Wisp must fail rather than kill the existing
listener. Inspect it with:

```sh
port=8710 # replace with the configured port
ss -ltnp "sport = :$port"
```

If another application owns the port, stop that application or edit the
numeric `port` in `~/.wisp/config.json`, then restart the service and refresh
anything that used the old URL:

```sh
systemctl --user restart wisp.service
wisp token
wisp doctor
```

An installed daemon and a development daemon must never share state. Keep the
installation on `~/.wisp`; `bun run dev` defaults to `~/.wisp-dev` and port
`18710`. Vite reads the same `WISP_HOME`, so its API, SSE, and WebSocket proxy
follows the development daemon.

From a source checkout, install the dedicated development command once:

```sh
bun run dev:install-cli
```

Bare `wisp` remains the installed production client. `wisp-dev` runs source
from the current Wisp checkout, forces process-local state to `~/.wisp-dev`,
and ignores a globally exported `WISP_HOME`. Use `wisp-dev token`,
`wisp-dev doctor`, and the other ordinary subcommands against the development
daemon while production continues under its installed service.

## Harness credentials under systemd

A harness login stored in that harness's normal per-user files is available to
the user service. A credential exported only in an interactive shell is not.
For example, a headless Droid API key needs an explicit systemd environment
file:

```sh
mkdir -p "$HOME/.config/wisp" "$HOME/.config/systemd/user/wisp.service.d"
umask 077
read -r -s -p "Factory API key: " FACTORY_API_KEY
printf '\n'
printf 'FACTORY_API_KEY=%s\n' "$FACTORY_API_KEY" \
  > "$HOME/.config/wisp/environment"
unset FACTORY_API_KEY
cat > "$HOME/.config/systemd/user/wisp.service.d/10-environment.conf" <<'EOF'
[Service]
EnvironmentFile=%h/.config/wisp/environment
EOF
systemctl --user daemon-reload
systemctl --user restart wisp.service
wisp doctor --harness droid
```

Do not commit that environment file. Prefer the harness's own secure login
storage where it supports unattended use.

For an always-on host, decide deliberately whether the user service should
continue after logout. An administrator can enable that with
`loginctl enable-linger <user>`.

## Upgrade and reinstall

Rerunning the installer for the same version is idempotent. Installing a later
version writes a separate managed version and switches the `current` symlink
only after verification. Restart the daemon after a CLI upgrade:

```sh
systemctl --user restart wisp.service
wisp version
wisp doctor --harness droid
```

The complete Linux upgrade and rollback matrix is not yet qualified. Back up
`~/.wisp` before changing alpha versions.

## Remove binaries and service

The uninstaller removes only installer-managed binaries, symlinks, and the
managed systemd user unit:

```sh
version=0.4.0-alpha.6 # replace with the installed alpha
curl --proto '=https' --tlsv1.2 -fsSL \
  "https://raw.githubusercontent.com/Pepewitch/wisp/v${version}/scripts/uninstall.sh" |
  sh
```

For a staged checkout, run `sh scripts/uninstall.sh`.

Removal always preserves `~/.wisp`, repositories, branches, and worktrees. It
refuses to remove an install root without the expected Wisp marker. Inspect and
delete preserved data manually only after confirming no work remains.

## Troubleshooting

| Finding | Action |
|---|---|
| `wisp: command not found` | Add `$HOME/.local/bin` to `PATH`, or invoke `$HOME/.local/bin/wisp`. |
| `daemon` fails in doctor | Run `systemctl --user status wisp.service`, or start `wisp serve` in a foreground terminal. |
| daemon reports its configured port is occupied | Inspect the listener, then stop the unintended process or change `port` in `~/.wisp/config.json`; never expose the replacement port publicly. |
| harness binary fails | Install that harness and verify its own `--version` command. |
| harness auth fails | Follow the exact login/API-key action printed by doctor. |
| Git identity fails | Configure `user.name` and `user.email` globally or in the registered repository. |
| project fails | Register an existing Git working tree by absolute path. |
| daemon build skew warns | Restart the service so the daemon and CLI run the same binary. |
| systemd is unavailable | Reinstall with `--no-service` and use a foreground process or another restart-capable supervisor. |

`GET /api/health` is the liveness endpoint. It includes the Wisp version,
commit, and dirty-build state.
