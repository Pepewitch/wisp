# Archive cleanup and recovery

Archiving hides a task from active work immediately. Its cleanup job then stops
task processes and terminals, saves uncommitted work on the kept branch, runs the
repository cleanup script followed by the configured project archive script,
removes the worktree, and preserves the conversation and attachments. Local tasks skip worktree scripts
and worktree removal. The existing archive preflight and process checks still
protect files; a cleanup failure leaves the remaining files in place.

Pending jobs do not delay daemon startup. Two workers process them in the
background. In the browser and Desktop, unfinished archives appear in the
sidebar's **Cleanup** section regardless of **Show archived**. Selecting one
shows its step, status, error, and recovery actions. Completed cleanup disappears
from that section; the task's retained history remains under **Show archived**.

## Safe retries

A failed process check or filesystem/Git step retries after 30 seconds, then
with increasing delays. After five failed attempts on that step, automatic
retries stop and the task shows **Cleanup needs attention**. Fix the reported
cause (for example, free disk space, restore repository access, or finish the
process using the workspace), then select **Retry cleanup**.

Each successful script is checkpointed separately. A failure in later Git or
archive finalization never deliberately reruns a checkpointed script.

## A script may have already run

Custom scripts can have external effects. A nonzero exit, timeout, output-limit
failure, or crash after launch does not prove those effects did not happen.
Wisp pauses cleanup and preserves the remaining files. It does not automatically
repeat an uncertain script or silently treat its failure as success.

1. Read **View script log** and inspect the script's intended effects, including
   any external service it changed. The log shows the last attempt, capped to
   its last 16 KiB in the interface. Output is captured when a command settles;
   a daemon crash can leave only the attempt's start marker.
2. If you verified the script completed its intended work, choose **Confirm
   script completed**. This skips that script and continues the remaining
   cleanup, which can remove files.
3. Otherwise, use **Rerun script** only after checking that repeating its effects
   is acceptable. Wisp asks for confirmation before sending that decision.

Wisp checks the previous process group before accepting either action. If it
cannot confirm the group ended, inspect the named group on the machine running
the daemon and wait for the script and its children to finish. Refresh and try
again. Wisp does not signal an unverified historical process ID. As with task
execution, a descendant that deliberately leaves the process group is outside
that tracking boundary.

An unfinished combined removal stage from an older Wisp cannot reveal which
scripts already ran or which processes they started. Its recovery dialog
requires confirmation that **both** scripts and their children stopped before
either accepting their completion or rerunning them. Other safe checkpoints
resume normally after upgrade.

Scripts should tolerate intentional reruns where practical. Wisp cannot promise
exactly-once effects in an external service across a daemon crash. The configured
project script is retained with the job even if its project is unregistered;
the repository script runs from the retained workspace with its usual Bash
file-path semantics. Log storage is bounded to the last attempt (up to 1 MiB
stdout and 64 KiB stderr); excessive stdout stops the script and requires review.

## CLI

```sh
wisp cleanup <task> --log
wisp cleanup <task> --retry
wisp cleanup <task> --confirm-complete
wisp cleanup <task> --rerun
```

The last two commands are explicit decisions with the same consequences as the
UI actions. For an uncertain cleanup from an older Wisp, add `--verified-stopped`
after checking both scripts and their children. Repeating `wisp archive` does
not reset a job or bypass an uncertain script.

## API

All endpoints use the daemon's normal authentication. `GET /api/capabilities`
advertises `archiveCleanup: true`; this is additive within protocol version 1.

- `GET /api/tasks?cleanup=1` includes active tasks and unfinished archives.
  `?archived=1` continues to include all archived tasks. The default list is
  unchanged for existing clients.
- Archived task responses include optional `cleanup`: `state` (`pending`,
  `running`, `needs-attention`, `complete`), `step`, `error`, `retryAt`, `revision`,
  `uncertain`, and `confirmStopped` (whether legacy verification is required).
  Older daemons omit this field; the UI retains their existing archive behavior.
- `GET /api/tasks/:id/cleanup` returns that summary plus the last script log tail.
- `POST /api/tasks/:id/cleanup` accepts `action` (`retry`, `confirm`, `rerun`),
  the displayed `revision`, and `confirmStopped: true` when required. Success is
  202. An obsolete revision, running job, unverified process group, or missing
  confirmation returns 409 with a remedy. Refetch before making a new decision.

Task events invalidate cleanup status as well as ordinary task data. Desktop
requests and late callbacks remain bound to their initiating connection.

## Retention, export, and permanent deletion

### Storage report

`wisp doctor --storage [--archived-before <30d|YYYY-MM-DD>]` inspects the local
`WISP_HOME` without creating files, changing permissions, or requiring a daemon.
It reads a database snapshot in memory, including committed WAL pages, and never
opens the on-disk database with SQLite. It reports logical file bytes, not
allocated disk blocks; symlinks are not followed. Concurrent filesystem changes
can make the totals approximate; a busy database snapshot asks you to retry.

Orphan worktrees belong to archived or missing tasks. The report identifies
them but never removes them. The done-task estimate counts worktrees only, not
local repositories; actual archive still runs its normal safety checks.
The purge estimate counts managed task files, logs and diagnostics, not orphan
worktrees or SQLite space (logical row deletion does not shrink the database).
The cutoff uses an archive's **last update**, conservatively, because historical
tasks do not record a separate archive timestamp. Incomplete cleanup may refuse
purge. Growth is retained log bytes divided by days since the oldest log mtime,
not a measured write rate, and becomes less representative after deletion.

Archive is not deletion: conversations, attachment bytes and retained logs stay
in Wisp. Older archives whose attachments were already deleted show that loss;
upgrading cannot recreate them. Interrupted legacy archive jobs finish under
their previous attachment-removal policy.

After cleanup finishes, select **More actions → Export or delete task data…**
in the browser or Desktop. The dialog estimates task file storage (excluding
SQLite overhead) and offers a portable JSON export. Desktop uses a native Save
panel; the browser uses Downloads. Exports contain task/turn/message metadata,
retained transcripts, diagnostics and attachments encoded as base64, plus a
`missing` list. They are snapshots for inspection, not an import/restore format.
Repository code, Git history, provider session files and credentials are excluded.
Exports may contain sensitive conversation content; store them privately.

Portable exports are limited to 5,000 files, 32 MiB of file bytes and 8 MiB of
metadata. For larger tasks or complete recovery, use [the offline backup and
restore procedure](INSTALL.md#back-up-and-restore-a-wisp-home). Logs already pruned by retention and
cancelled-message attachments cannot be recovered by exporting.

**Delete permanently** requires the displayed task ID. It removes Wisp's task,
turn, message and webhook records and their managed files. It preserves the
original repository, Git branches, provider sessions, external backups and any
workspace explicitly left behind by archive cleanup. Deletion requires completed
cleanup and no tracked live processes or active webhook delivery. If interrupted,
the task stays archived with a deletion-pending notice; retry the same action.
Some files may already be gone. This is logical deletion, not forensic erasure
of SQLite pages, filesystem snapshots or copies outside Wisp.

```sh
# Run with a private umask; stdout is JSON and notices go to stderr.
umask 077
wisp export <task> > task-export.json
wisp purge <task> --confirm <task>
# Preview every matching archive, including exact task IDs and file bytes.
wisp purge --archived-before 30d
# Only after reviewing the preview: n must match its count.
wisp purge --archived-before 30d --confirm-count <n>
```

Bulk purge accepts a positive age (`30d`) or a UTC date (`YYYY-MM-DD`).
Without confirmation it deletes nothing and exits successfully. Confirmation
must match the current count; the daemon also checks the preview's selection
fingerprint and fixed cutoff before deleting. A changed selection refuses.
Only archived tasks qualify, using their last update (not creation date).
Each deletion uses the same cleanup, process, export-busy and webhook guards as
single-task purge. One failure does not stop the rest: the receipt names failed
IDs and reclaimed file bytes, and the CLI exits nonzero if any failed. Bytes
exclude SQLite pages and unmeasurable partial failures. A same-count replacement
between separate CLI invocations cannot be detected by count alone: review the
list printed on confirmation too.

Authenticated bulk API: `GET /api/purge?archivedBefore=30d` returns `tasks`,
`bytes`, `cutoff` and `fingerprint`; `DELETE /api/purge` requires that `cutoff`,
`fingerprint` and `confirmCount`. The response lists `purged`, `failed` and
`reclaimedBytes`. `GET /api/capabilities` advertises `bulkPurge`.

Authenticated API: `GET /api/tasks/:id/storage`, `GET /api/tasks/:id/export`, and
`DELETE /api/tasks/:id/purge` with `{"confirmTaskId":"<task>"}`. Export validation
is shared by CLI and UI. Task responses add `attachmentsRetained` and
`deletionPending`; clients hide the new actions for older daemons.
