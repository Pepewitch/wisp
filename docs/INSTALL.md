# Install and activate Wisp on Linux

This guide covers **Ubuntu 24.04 LTS, x86_64, glibc**.
`0.5.3` is the release covered by this guide. The
Apple Silicon Homebrew path is documented separately in
[INSTALL-MACOS.md](INSTALL-MACOS.md).

Automated install and activation gates cover this target. Full clean-machine
and upgrade/rollback qualification remains incomplete; see the
[0.5 qualification ledger](v0.5/QUALIFICATION.md).

## Before you start

You need:

- an x86_64 Ubuntu 24.04 host;
- `curl`, `git`, `sha256sum`, and the standard `install` utility;
- a Git repository with a configured `user.name` and `user.email`;
- at least one installed and authenticated harness: `droid`, `claude`,
  `codex`, `cursor-agent`, or `opencode`.

Wisp must run on the same host and as the same user that can access the
repositories and harness authentication. It does not put a harness or its
account in a separate container.

## Public release install

Use the public release installer:

```sh
version=0.5.3 # replace with the current published release
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
artifact=dist/release/v0.5.3/wisp-v0.5.3-linux-x86_64
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
only after verification. An installer-managed daemon running as the active
`wisp.service` process can check and upgrade itself:

```sh
wisp update
```

The command and browser update action read the fixed daemon channel published
with each supported release. Wisp then downloads the release manifest and
binary, verifies the target, size, SHA-256, and embedded version/commit
identity, writes the new version separately, and atomically switches
`current`. It exits only after activation; systemd's `Restart=always` starts
the upgraded binary.

After an out-of-band CLI upgrade, restart the daemon manually:

```sh
systemctl --user restart wisp.service
wisp version
wisp doctor --harness droid
```

The web header also shows the running daemon version. When the channel has a
newer promoted Wisp release, an installer-managed binary running as the active
`wisp.service` process shows an **Update** button. The browser reloads after
the expected version answers its health check.

The restart is immediate. Open web terminal shells stop, and an in-progress
task setup may need to be retried. Running turns retain their durable logs and
are reconciled by the new daemon. Foreground and custom-supervisor processes
show the available version but update manually because Wisp cannot guarantee
their restart.

The complete Linux upgrade and rollback matrix is not yet qualified. Take a
backup before changing versions — the procedure below, not a plain `cp`
of a live profile.

## Back up and restore a Wisp home

A backup must exist **outside the machine or disk you might lose** before a
failure. Choose what you need to recover:

| Purpose | What to preserve |
| --- | --- |
| Roll back a Wisp upgrade on the same machine | A pre-upgrade Wisp home, with the original repositories still intact at their existing paths |
| Recover after losing a VM or disk | The Wisp home **and every source repository its tasks use**, including Git metadata and any task worktrees stored elsewhere |

A copy of `~/.wisp` alone is not a complete machine-loss backup. Linked task
worktrees share objects, branches, and administrative data with their source
repository's Git directory. An unpublished task commit may exist only there;
a fresh clone from GitHub cannot recover commits that were never pushed.
See [Git's worktree storage details](https://git-scm.com/docs/git-worktree#_details).

### Take an offline backup

1. Stop submitting work. Let task setup and cleanup scripts settle. Finish or
   explicitly **Stop** active turns and background watchers; close task
   terminals and stop other tools writing to these repositories. Check any
   **Cleanup needs attention** tasks using the [cleanup guide](ARCHIVE-CLEANUP.md).
   Stopping the daemon alone does not guarantee its detached children stopped.
2. Stop the daemon and keep it stopped until the copy finishes. For the managed
   Linux service, use `systemctl --user stop wisp.service`; for foreground or
   other service managers, stop that instance and prevent automatic restart.
   Verify no task, setup, cleanup, or external process is still writing the files.
3. Copy the entire Wisp home and the repositories needed for your recovery goal.
   Include hidden Git directories, uncommitted/untracked files, local-task
   checkouts, and worktrees outside the default home. If a repository itself is
   a linked worktree or uses external Git storage, include that shared storage
   too. Record the original absolute paths, Wisp version, and configured
   `WISP_HOME` with the backup.
4. Check the copy succeeded before restarting Wisp, then transfer it off the
   machine. Restrict access and encrypt it in storage/transit: config, logs,
   attachments, and copied project files can contain credentials and private data.

For example, **after completing steps 1–2**, a default home and one ordinary
repository under `~/projects/example-app` can be copied together:

```sh
umask 077
backup_file="$HOME/wisp-backup-$(date +%Y%m%d-%H%M%S).tar.gz"
# Use your service manager if different; restart only if tar succeeds:
tar -czf "$backup_file" -C "$HOME" .wisp projects/example-app &&
  systemctl --user start wisp.service
# Transfer the archive to protected storage outside this machine.
```

Replace the example repository and include **all** required paths. A custom
`WISP_HOME` replaces `.wisp` in this example. The local archive is only a staging
copy, and the commands do not stop task processes or upload it for you. If tar
fails, fix the reported cause and retry with a new filename; discard the partial
archive only after a successful replacement exists.

The Wisp home includes these recovery inputs; copy the whole directory rather
than using this table as a file allowlist:

| Path | Why it is needed |
| --- | --- |
| `wisp.db` and any accompanying `-wal`, `-shm` files | tasks, turns, messages, cleanup jobs, outbox, schema ledger |
| `config.json`, `instance-id` | settings, credentials, projects, and daemon identity |
| `adapters.json`, `suffix-prompts.json` | user-defined harnesses and prompts, when present |
| `tasks/`, `logs/` | image attachments and transcripts |
| `worktrees/` | task files, including uncommitted/untracked work; Git history also needs the source repositories |

A live [SQLite `VACUUM INTO` snapshot](https://www.sqlite.org/lang_vacuum.html#vacuuminto)
is consistent **for the database only**. Copying attachments, logs, or worktrees
while tasks or cleanup jobs modify them does not give a consistent whole-Wisp
backup. Use the offline procedure above for recovery; a database-only snapshot
is not a substitute for it.

### Restore and verify

1. Keep the destination daemon stopped and preserve any existing files separately.
   Install the backed-up Wisp version first: a newer build may migrate the
   database, while an older build refuses a schema it does not understand.
2. Restore the Wisp home **and the source repositories** with their permissions,
   preferably to the same absolute paths under the same account. Reinstall
   harness CLIs and restore their credentials/session data separately if needed;
   their own homes are outside this backup's scope. Keep the old machine's Wisp
   stopped so both copies do not resume the same work or webhook deliveries.
3. If paths changed, do not start Wisp yet. Git's
   [`worktree repair`](https://git-scm.com/docs/git-worktree#_commands)
   can reconnect moved repositories/worktrees, but it does **not** update Wisp's
   stored paths. Wisp has no automatic profile-relocation command. Restoring the
   original paths is the simplest option; relocation needs separate review of
   configuration and database paths before startup.
4. Run `wisp doctor` against the restored home while the daemon is stopped.
   Also check each source repository with `git -C <repo> worktree list`, and
   each task worktree with `git -C <worktree> log -1` and `git -C <worktree> status`.
   Confirm an expected unpublished commit and any uncommitted files survived.
   Database integrity alone does not establish that Git data or attachments exist.
5. Start Wisp, then use `wisp ls` and the UI to check task history, attachments,
   and logs. Review queued messages and cleanup status: startup resumes recovery
   and delivery work. If checks fail, stop Wisp and retain the original backup
   while investigating; do not delete branches or archive tasks to hide the error.

Use the restored `WISP_HOME` for these commands if it is not the default.
An upgrade rollback requires the backup taken **before** the migration; restoring
a newer database does not undo its schema. Excluded files or repositories cannot
be recreated by Wisp. A full fresh-machine restore drill is not yet qualified;
verify your own backup before relying on it for disaster recovery.

## Remove binaries and service

The uninstaller removes only installer-managed binaries, symlinks, and the
managed systemd user unit:

```sh
version=0.5.3 # replace with the installed version
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
