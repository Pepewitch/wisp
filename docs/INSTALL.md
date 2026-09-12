# Install Wisp on Linux

Release gates cover **Ubuntu 24.04 LTS, x86_64**. The binary requires
glibc 2.17 or newer; other glibc distributions are untested, not blocked. There is
no musl or ARM Linux artifact. Full clean-machine and rollback qualification
still has gaps; see the [qualification ledger](v0.5/QUALIFICATION.md).

For Apple Silicon, use the [macOS guide](INSTALL-MACOS.md).

## Before you start

You need `curl`, `git`, `sha256sum`, and the standard `install` utility, plus:

- a Git repository with `user.name` and `user.email` configured;
- an installed and authenticated harness: Droid, Claude Code, Codex, Cursor,
  or OpenCode;
- the same OS user for Wisp, the repository, and the harness credentials.

Wisp does not require Node or Bun. It runs agents with your user's access,
not in a sandbox. Read the [trust model](../SECURITY.md#trust-model) before
running a task.

## Public release install

```sh
curl --proto '=https' --tlsv1.2 -fsSL \
  https://raw.githubusercontent.com/Pepewitch/wisp/v0.5.6/scripts/install.sh | sh
```

This pins the installer to release `0.5.6`. It verifies the binary checksum,
embedded version, and clean-build flag before activation. An expected commit
is also checked if supplied through `WISP_COMMIT`.

| Installed item | Location |
| --- | --- |
| Versioned binary | `~/.local/share/wisp` |
| Command symlink | `~/.local/bin/wisp` |
| Private config and task data | `~/.wisp` |
| User service, when available | `wisp.service` |

The installer initializes the profile and enables/starts a systemd **user**
service when available. It uses no `sudo` and refuses to replace unmanaged
paths. Uninstall preserves task data and repositories.

To inspect the script first, download it into a scratch directory:

```sh
curl --proto '=https' --tlsv1.2 -fsSL \
  https://raw.githubusercontent.com/Pepewitch/wisp/v0.5.6/scripts/install.sh \
  -o install-wisp.sh
less install-wisp.sh
sh install-wisp.sh
```

Use `sh install-wisp.sh --no-service` instead if you want foreground operation.
If `wisp` is not found, add this to your shell startup file:

```sh
export PATH="$HOME/.local/bin:$PATH"
```

For locally built release candidates, see the
[maintainer install check](../wispd/README.md#test-a-release-candidate).

## Activate

Check that the daemon is running:

```sh
systemctl --user status wisp.service
```

Without systemd, keep `wisp serve` running in a separate terminal; see
[Run without systemd](#run-without-systemd) for persistent operation.
The installer already runs `wisp init`; rerunning it is safe but does not
start a daemon.

Use your repository path and harness:

```sh
wisp project add /path/to/repo
wisp doctor --harness droid
wisp new /path/to/repo "Find a small bug, fix it, and run the tests." --harness droid
```

Fix any `fail` lines from doctor, then confirm that the real task runs.
**Doctor checks harness authentication in your shell, not the daemon's
environment.** A green result alone does not prove a managed service can
authenticate; see [service credentials](#harness-credentials-under-a-service-manager).

Follow the task with `wisp log -f <task>`, or run `wisp token`, open its URL,
and paste the token into the browser UI. Keep the token private. See the
[CLI reference](../skills/wisp/references/cli.md) for follow-up, interruption,
search, and archive commands.

## Harness credentials under a service manager

A service does not inherit your interactive shell's environment. Harness
credentials in normal per-user login files are available to the same user;
a key exported only in your terminal is not. Prefer the harness's own secure
login storage when it supports unattended use.

For a systemd-managed daemon that needs an API key:

1. Create `~/.config/wisp/environment` with mode `0600`, inside a private
   directory, containing the required `KEY=value` entries. For Droid the key
   is `FACTORY_API_KEY`. Do not commit or share this file.
2. Create `~/.config/systemd/user/wisp.service.d/10-environment.conf`:

   ```ini
   [Service]
   EnvironmentFile=%h/.config/wisp/environment
   ```

3. Reload and restart:

   ```sh
   systemctl --user daemon-reload
   systemctl --user restart wisp.service
   ```

4. Run a real task to verify the daemon can authenticate. Repeating doctor
   from the same interactive shell cannot detect this environment gap.

For launchd, supervisord, or a foreground daemon, use that process's own
environment configuration. Never put secrets in a Homebrew Formula, a shared
service definition, or a public diagnostic report.

## Run without systemd

For a temporary session, run `wisp serve` in a terminal. For persistent use,
configure a restart-capable supervisor with:

- restart on daemon exit, including a successful update exit;
- umask `0077`, your user's `HOME`, and a `PATH` reaching Wisp and the harnesses;
- stop signals directed to the daemon, **not its whole process group**.
- `WISP_UPDATE_SUPERVISOR=supervisord` only when the program is named `wisp`
  and keeps `autorestart=true`; this explicitly enables automatic updates.

For example, under supervisord:

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
environment=HOME="%(ENV_HOME)s",PATH="%(ENV_HOME)s/.local/bin:/usr/local/bin:/usr/bin:/bin",WISP_UPDATE_SUPERVISOR="supervisord"
```

Adapt `PATH` for your harness locations. Provide credentials and any
`WISP_ALLOWED_ORIGINS` in the supervised process environment, not just your
terminal. Killing the whole group can stop harness children behind Wisp.

Doctor's local supervisor check recognizes systemd on Linux, so its supervisor
warning is expected here. Before enabling automatic updates, Wisp requires the
explicit opt-in above, Supervisor's injected process identity, and an exact PID
match from `supervisorctl pid wisp`. Updates remain informational for foreground
daemons and other supervisors because Wisp cannot guarantee restart.

For a systemd service that should continue after logout, an administrator can
deliberately enable user lingering with `loginctl enable-linger <user>`.

## Upgrade and reinstall

For an installer-managed daemon running under `wisp.service` or an explicitly
opted-in Supervisor program:

```sh
wisp update
```

The command and browser update action use the promoted release channel,
verify the candidate, activate it atomically, and let the service manager
restart Wisp. Rerunning the installer for the same version is idempotent.

After an out-of-band installation, restart the service yourself:

```sh
systemctl --user restart wisp.service
wisp version
wisp doctor --harness droid
```

Restart closes terminal shells and may interrupt task setup. Running turns
retain their logs and are reconciled by the new daemon. For foreground or
custom-supervised operation, stop that instance, install, then restart it.
Take a [backup](#back-up-and-restore-a-wisp-home) first. An older binary cannot
undo a database migration.

## Configuration and troubleshooting

`~/.wisp/config.json` owns the loopback host and port. A new profile prefers
`127.0.0.1:8710`, trying ports `8711`–`8799` if needed. It persists its choice;
a later restart never silently changes it. Use `wisp token` for the actual
URL. If the initial range is full, run `wisp init --port <unused-port>`.

| Problem | Next step |
| --- | --- |
| `wisp: command not found` | Add `~/.local/bin` to PATH or invoke `~/.local/bin/wisp`. |
| Daemon unavailable | Check `systemctl --user status wisp.service`, or start `wisp serve`. |
| Configured port occupied | Inspect with `ss -ltnp 'sport = :8710'`, substituting your port. Stop the unintended listener or change Wisp's config and restart. Never kill an unknown listener automatically. |
| Profile already being served | Use the existing instance or stop its supervisor before restarting. Never delete `daemon-owner.lock.db` to bypass ownership. |
| Harness or auth check fails | Follow doctor's named install/login action. If only real tasks fail, check [service credentials](#harness-credentials-under-a-service-manager). |
| Git identity or project check fails | Configure Git's name/email and register an existing Git working tree. |
| CLI and daemon versions differ | Restart the managed daemon after installation. |
| Database startup fails | Run `wisp doctor --database` against the same `WISP_HOME`; preserve files before repair or restore. |

Database diagnosis is read-only and does not probe harnesses. Wisp takes
exclusive home ownership before migrations; a rejected second start does not
change the database. Failed migration steps roll back and can be retried after
fixing the cause. A newer schema needs the same or a newer Wisp version.
Deleting the database discards tasks.

Separate instances need different `WISP_HOME` directories **and** ports.
Use [Contributing](../CONTRIBUTING.md) for isolated source development.
Keep Wisp bound to loopback; use the [remote guide](REMOTE-ACCESS.md) for
private HTTPS or SSH access and update its mappings after a port change.

Embedded terminals use your OS account's login shell. To choose another,
set `terminalShell` to an absolute installed shell path in `config.json` and
restart. The shell must accept `-l`.

See [storage and retention](ARCHIVE-CLEANUP.md) for disk usage and cleanup,
and the [CLI reference](../skills/wisp/references/cli.md#daemon--diagnostics)
for diagnostic logs and concurrency settings.

## Back up and restore a Wisp home

A backup must reach a separate machine or disk before failure. For upgrade
rollback on the same machine, preserve the **pre-upgrade** Wisp home with its
repositories intact. For machine-loss recovery, preserve the Wisp home
**and every source repository**, including Git metadata and any task worktrees
stored elsewhere.

Linked worktrees share objects and branch history with their source repository.
A copy of `~/.wisp` alone, or a fresh clone from GitHub, cannot recover every
unpublished commit. See [Git's worktree storage](https://git-scm.com/docs/git-worktree#_details).

### Take an offline backup

1. Stop submitting work. Let setup and cleanup scripts settle. Finish or
   explicitly Stop active turns and background watchers, close task terminals,
   and stop other writers. Resolve [uncertain cleanup](ARCHIVE-CLEANUP.md).
   Stopping the daemon alone does not prove detached children stopped.
2. Stop the daemon and prevent its supervisor from restarting it. For Linux,
   use `systemctl --user stop wisp.service`; for macOS, use
   `brew services stop wisp`. Verify no relevant process is still writing.
3. Copy the entire Wisp home and all required repositories/worktrees, including
   hidden Git directories, external Git storage, and uncommitted/untracked
   files. Record the original paths, Wisp version, and `WISP_HOME`.
4. Verify the copy before restarting, then transfer it off the machine.
   Restrict access and encrypt storage/transit: config, attachments, logs, and
   project files may contain credentials or private data.

For example, **after steps 1–2**, back up a default profile and one ordinary
repository under `~/projects/example-app`:

```sh
umask 077
backup_file="$HOME/wisp-backup-$(date +%Y%m%d-%H%M%S).tar.gz"
tar -czf "$backup_file" -C "$HOME" .wisp projects/example-app &&
  systemctl --user start wisp.service
```

Adapt the service manager and include **all** required paths. Transfer the
verified archive to protected off-machine storage. If copying fails, retain
the originals and retry with a new destination. A live SQLite `VACUUM INTO`
snapshot covers only the database, not a consistent Wisp home or Git backup.

### Restore and verify

1. Keep the destination daemon stopped and preserve any existing files.
   Install the backed-up Wisp version first.
2. Restore the whole home and repositories with their permissions, preferably
   to the same absolute paths under the same account. Restore harness
   installations and credentials separately. Keep the old machine's daemon
   stopped so both copies do not resume the same work.
3. If paths changed, do not start yet. `git worktree repair` can reconnect
   Git worktrees but does **not** update Wisp's stored paths. Wisp has no
   automatic profile-relocation command; use original paths or review both
   config and database paths before startup.
4. Run `wisp doctor` against the restored home while the daemon is stopped
   (the daemon-unavailable finding is expected). Check each repository with
   `git -C <repo> worktree list` and task worktrees with `git log -1` and
   `git status`. Verify an unpublished commit and uncommitted files survived.
5. Start Wisp and check task history, attachments, and logs. Startup can resume
   queued messages and cleanup. If anything is wrong, stop it and investigate
   without deleting branches or archiving tasks to hide the error.

A full fresh-machine restore is not yet qualified. Test your own backup;
neither missing files nor a pre-migration database can be reconstructed from
an incomplete or newer backup.

## Remove binaries and service

```sh
curl --proto '=https' --tlsv1.2 -fsSL \
  https://raw.githubusercontent.com/Pepewitch/wisp/v0.5.6/scripts/uninstall.sh | sh
```

From a checkout, use `sh scripts/uninstall.sh`. The uninstaller removes only
installer-managed binaries, symlinks, and the user service. It refuses
unmarked installations and preserves `~/.wisp`, repositories, branches, and
worktrees. Review retained data and running work before deleting anything.
