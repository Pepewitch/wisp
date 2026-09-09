# Install and activate Wisp on Linux

This guide covers **Ubuntu 24.04 LTS, x86_64, glibc**.
`0.4.0-alpha.17` is the current experimental feature prerelease. The
Apple Silicon Homebrew path is documented separately in
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
version=0.4.0-alpha.17 # replace with the current published alpha
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
artifact=dist/release/v0.4.0-alpha.17/wisp-v0.4.0-alpha.17-linux-x86_64
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
and use the daemon-served browser UI.

## Port selection and development isolation

`~/.wisp/config.json` is the authority for the installed daemon's loopback
`host` and `port`. Initialization of a new home prefers
`127.0.0.1:8710`, detects an occupied default, tries `8711` through `8799`,
persists the first available loopback port, and prints the actual URL. If the
range is exhausted, initialization stops with an explicit
`wisp init --port <port>` recovery action. A later restart never silently
changes a persisted port.

The same file controls the short-lived diagnostic flight recorder used when a
primary turn transcript is incomplete. It defaults to
`diagnosticEnabled: true`, `diagnosticRetentionDays: 7`, and a shared
`diagnosticMaxBytes: 536870912` (512 MiB). Diagnostic files and their directory
are private to the current user. Export a retained turn as JSONL with
`wisp log <task> [turn] --diagnostic`; treat that export as potentially
sensitive because it contains harness output from the turn.

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

The web header also shows the running daemon version. When GitHub has a newer
published Wisp release, an installer-managed binary running as the active
`wisp.service` process shows an **Update** button. Wisp downloads the release
manifest and binary, verifies the target, size, SHA-256, and embedded
version/commit identity, writes the new version separately, then atomically
switches `current`. It exits only after activation; systemd's `Restart=always`
starts the upgraded binary, and the browser reloads after the expected version
answers its health check.

The restart is immediate. Open web terminal shells stop, and an in-progress
task setup may need to be retried. Running turns retain their durable logs and
are reconciled by the new daemon. Foreground and custom-supervisor processes
show the available version but update manually because Wisp cannot guarantee
their restart.

The complete Linux upgrade and rollback matrix is not yet qualified. Take a
backup before changing alpha versions — the procedure below, not a plain `cp`
of a live profile.

## Back up and restore a Wisp home

`~/.wisp` is a live SQLite database plus the files that belong to it. Copying
it while the daemon runs can capture a database whose write-ahead log is
missing, which is a backup that restores to a state no daemon ever had.

Wisp records the schema version it wrote, so a restore into an older build is
refused loudly rather than read with columns that build does not know about.
That is what makes a backup taken **before** an upgrade the thing that lets you
roll one back.

The safe procedure, with the daemon stopped:

```sh
systemctl --user stop wisp.service     # or stop your foreground `wisp serve`
tar -czf "wisp-backup-$(date +%Y%m%d-%H%M).tar.gz" -C "$HOME" .wisp
systemctl --user start wisp.service
```

If stopping the daemon is not an option, take a consistent snapshot of the
database first and copy the rest normally:

```sh
sqlite3 ~/.wisp/wisp.db "VACUUM INTO '/tmp/wisp-db-snapshot.db'"
```

`VACUUM INTO` writes a single consistent file including the WAL contents. It is
the one supported way to copy the database of a running daemon.

What a complete backup contains, and why:

| Path | Why it is needed |
| --- | --- |
| `wisp.db` (+ `-wal`, `-shm` when the daemon is stopped) | tasks, turns, messages, outbox, schema ledger |
| `config.json` | port, token, projects, webhooks, harness defaults |
| `instance-id` | the identity clients use to recognize this daemon |
| `adapters.json`, `suffix-prompts.json` | user-defined harnesses and prompts, when present |
| `tasks/` | per-turn image attachments referenced by turn manifests |
| `logs/` | turn transcripts the UI replays |
| `worktrees/` | live task checkouts (large; excludable if you accept losing uncommitted work in them) |

To restore, stop the daemon, move the existing home aside rather than deleting
it, unpack the backup, and start the daemon. Check the result before trusting
it:

```sh
wisp doctor      # reports the schema version, integrity, and foreign keys
wisp ls          # the tasks you expect, with their branches
```

Two things a restore does not do: it does not recreate worktrees you excluded,
and it does not roll back a schema. Rolling back a Wisp binary across a
migration needs the backup you took before the upgrade.

## Remove binaries and service

The uninstaller removes only installer-managed binaries, symlinks, and the
managed systemd user unit:

```sh
version=0.4.0-alpha.17 # replace with the installed alpha
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
commit, and dirty-build state. It deliberately excludes installation identity
and feature details. Authenticated clients can use `GET /api/capabilities` for
the stable Wisp-home instance ID, API protocol version, product build, and
implemented API feature flags. The instance ID is not a credential, and a
copied Wisp home retains it.
