# Install and activate Wisp on Linux

This guide covers **Ubuntu 24.04 LTS, x86_64, glibc**.
`0.5.3` is the release covered by this guide. The
Apple Silicon Homebrew path is documented separately in
[INSTALL-MACOS.md](INSTALL-MACOS.md).

Automated install and activation gates cover this target. Full clean-machine
and upgrade/rollback qualification remains incomplete; see the
[0.5 qualification ledger](v0.5/QUALIFICATION.md).

Ubuntu 24.04 LTS is what those gates and that ledger cover, not a hard
requirement. The release artifact is a self-contained x86_64 executable that
needs glibc 2.17 or newer, and the installer checks only that the host is
Linux on x86_64. Another glibc distribution above that floor is untested
rather than blocked: the steps below should work, and nothing in this guide is
qualified against it. There is no musl artifact.

## Before you start

You need:

- an x86_64 Linux host with glibc 2.17 or newer; Ubuntu 24.04 LTS is the
  qualified target;
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

On a normal systemd user session, the installer enables and starts
`wisp.service`. Otherwise, keep `wisp serve` in a foreground terminal or use a
restart-capable supervisor — see [Run without systemd](#run-without-systemd).

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

Doctor is a local self-check. It probes the harness binary and its
authentication in the environment of the shell that ran the command, not in
the environment of the daemon that will spawn that harness. When the daemon
runs under a service manager those two environments can differ, so a green
`harness <name> auth` line — and the `activation` receipt built on it — does
not by itself prove the daemon can authenticate that harness. Read
[Harness credentials under a service manager](#harness-credentials-under-a-service-manager)
before trusting a green receipt on a supervised daemon.

Create a first task. It is also the cheapest confirmation that the daemon's
own environment can authenticate:

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

Archived stdout/stderr turn logs have a separate policy:
`turnLogRetentionEnabled: true`, `turnLogRetentionDays: 90`, and
`turnLogMaxBytes: 1073741824` (1 GiB). The daemon evicts whole archived turns,
oldest first, only after agent prose is completely indexed. Live logs are never
eligible. Set `turnLogRetentionEnabled: false` to stop eviction, or change the
positive integer age/byte limits, then restart. These settings do not change
`turnTranscriptBytes`, the per-turn capture budget. Use `wisp doctor --storage`
to inspect storage without modifying the home; use
`wisp purge --archived-before 30d` for a non-destructive purge preview.
See [storage and retention](ARCHIVE-CLEANUP.md#turn-log-retention).


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

## Harness credentials under a service manager

A supervised daemon does not inherit your interactive shell's environment, and
the shell you later run `wisp` from does not inherit the daemon's. Two
consequences follow, and they hold for every supervisor — as well as for a
foreground `wisp serve` started from a shell that differs from the one you
test from:

- A harness login stored in that harness's normal per-user files is available
  to the daemon, because the daemon runs as the same user.
- A credential exported only in an interactive shell is not. It must be placed
  in the daemon's own environment by whatever mechanism its supervisor
  provides.

### A green doctor line does not prove the daemon can authenticate

`wisp doctor` spawns its harness and auth probes in the CLI's own process, so

```text
ok   harness droid auth: authenticated
```

is evidence about the shell that ran the command. Only the `daemon` check
reaches the running daemon. Where the two environments differ, doctor can
report a fully green activation, up to `ok activation: ready for a first
task`, while a real turn fails to authenticate. The documented install order —
the installer enables and starts the service, then you run `wisp doctor` — is
precisely the case where the daemon's environment is not the shell's.

The operator-side confirmation is to run one real task and watch it
authenticate, with `wisp new` followed by `wisp log -f <task>` as in
[Activate](#activate). That turn is spawned by the daemon, so it exercises the
environment that actually matters.

### Worked example: a systemd environment file

A headless Droid API key needs an explicit systemd environment file:

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

Under another supervisor, use its equivalent: supervisord's `environment=`, a
container env file, or an export in the wrapper script that execs
`wisp serve`. See [Run without systemd](#run-without-systemd).

For an always-on host, decide deliberately whether the user service should
continue after logout. An administrator can enable that with
`loginctl enable-linger <user>`.

## Run without systemd

When the installer cannot enable a systemd user session, keep `wisp serve` in
a foreground terminal or run it under another supervisor. Reproduce these
semantics from the managed unit in `scripts/install.sh`:

- Restart the daemon whenever it exits (`Restart=always`, `RestartSec=2`).
- Create daemon files with umask `0077` (`UMask=0077`).
- Give the process the installing user's `HOME` and a `PATH` that reaches
  both `~/.local/bin/wisp` and the harness binaries.
- Signal only the daemon process on stop (`KillMode=process`).

The KillMode row is the sharp one. A supervisor that kills the whole process
group tears down harness children behind the daemon.

A worked supervisord program uses supervisord's own environment expansion, so
the snippet needs no path editing:

```ini
[program:wisp]
command=%(ENV_HOME)s/.local/bin/wisp serve
directory=%(ENV_HOME)s
umask=077
autostart=true
autorestart=true
startsecs=5
stopasgroup=false
killasgroup=false
environment=HOME="%(ENV_HOME)s",PATH="%(ENV_HOME)s/.local/bin:/usr/local/bin:/usr/bin:/bin"
```

`stopasgroup=false` and `killasgroup=false` are that KillMode row.

supervisord `environment=` supplements the supervisord process environment,
not the operator's interactive shell. Harness credentials (`FACTORY_API_KEY`
and similar) and `WISP_ALLOWED_ORIGINS` must be in the program's environment,
or the equivalent for another supervisor. Exporting them in a login shell is
not enough, and `wisp doctor` run from that login shell cannot detect the
gap. See
[Harness credentials under a service manager](#harness-credentials-under-a-service-manager)
for the general rule, the doctor caveat, and the systemd `EnvironmentFile`
recipe, and [REMOTE-ACCESS.md](REMOTE-ACCESS.md) for `WISP_ALLOWED_ORIGINS`.

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
their restart. See [Run without systemd](#run-without-systemd).

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
   other service managers, stop that instance and prevent automatic restart
   (see [Run without systemd](#run-without-systemd)).
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
| doctor reports `ok harness <name> auth` but a real turn fails to authenticate | Doctor probed the shell's environment, not the supervised daemon's. Put the credential in the daemon's environment and restart it. See [Harness credentials under a service manager](#harness-credentials-under-a-service-manager). |
| Git identity fails | Configure `user.name` and `user.email` globally or in the registered repository. |
| project fails | Register an existing Git working tree by absolute path. |
| daemon build skew warns | Restart the service so the daemon and CLI run the same binary. |
| systemd is unavailable | Reinstall with `--no-service` and use a foreground process or another restart-capable supervisor. See [Run without systemd](#run-without-systemd). |
| `warn supervisor: wisp.service is not enabled — keep 'wisp serve' in the foreground or configure a restart-capable supervisor` | Expected when another supervisor or a foreground `wisp serve` is in use. Doctor only recognizes the systemd user unit `wisp.service` on Linux (and Homebrew launchd on macOS). It does not inspect supervisord or similar. See [Run without systemd](#run-without-systemd). |

`GET /api/health` is the liveness endpoint. It includes the Wisp version,
commit, and dirty-build state. It deliberately excludes installation identity
and feature details. Authenticated clients can use `GET /api/capabilities` for
the stable Wisp-home instance ID, API protocol version, product build, and
implemented API feature flags. The instance ID is not a credential, and a
copied Wisp home retains it.
