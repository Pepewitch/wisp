import { join } from "node:path";
import { db, getTask } from "./store";
import { archiveCleanup, clearArchiveCleanup, failArchiveCleanup, pendingArchiveCleanups, type ArchiveCleanupJob } from "./archive-jobs";
import { CLEANUP_PHASES, cleanupProgress, isHook, notifyCleanup, updateProgress, type CleanupProgress } from "./archive-progress";
import { assertCleanupHookEnded, runCleanupHook } from "./archive-hooks";
import { assertTaskProcessesEnded } from "./task-processes";
import { killTurnForArchive } from "./runner";
import { killForTask } from "./terminal";
import { commitDirtyWork, removeWorktree, worktreeHealth } from "./worktree";
import { homeIsDraining, trackHomeWork } from "./home-lifetime";

const MAX_ATTEMPTS = 5;
export const CLEANUP_RETRY_MS = 30_000;
let working: Promise<void> | null = null;

async function prepareHooks(job: ArchiveCleanupJob, p: CleanupProgress): Promise<void> {
  if (!job.removable) { updateProgress(job.task_id, { prepared: 2 }); return; }
  await assertTaskProcessesEnded(job.task_id);
  const health = await worktreeHealth(job.worktree_path!);
  if (!health.ok) { updateProgress(job.task_id, { prepared: 2 }); return; }
  await commitDirtyWork(job.worktree_path!, job.branch!);
  if (p.prepared) return;
  const file = Bun.file(join(job.worktree_path!, ".wisp", "cleanup.sh"));
  const exists = await file.exists();
  if (exists && file.size > 256 * 1024) throw new Error("Repository cleanup script exceeds 256 KiB. Reduce its size, then retry cleanup.");
  updateProgress(job.task_id, { repo_script: exists ? await file.text() : null, prepared: 1 });
}

async function stage(job: ArchiveCleanupJob, p: CleanupProgress): Promise<void> {
  if (p.phase === "stop-turn") {
    if (job.force || !job.stop_turn) await killTurnForArchive(job.task_id);
  } else if (p.phase === "stop-shells") await killForTask(job.task_id);
  else if (p.phase === "save-work") await prepareHooks(job, p);
  else {
    await assertTaskProcessesEnded(job.task_id);
    await assertCleanupHookEnded(p);
    if (p.phase === "repo-hook" || p.phase === "project-hook") {
      if (job.removable && p.prepared !== 2) await runCleanupHook(job, p.phase === "repo-hook" ? p.repo_script : job.archive_script);
    } else if (p.phase === "remove-worktree" && job.removable) {
      await removeWorktree(job.repo_path, job.worktree_path!, job.branch!, job.force, { save: false });
    } else if (p.phase === "remove-attachments" && !getTask(job.task_id)?.archive_assets_retained) {
      const { removeTaskAttachments } = await import("./attachments");
      await removeTaskAttachments(job.task_id);
    }
  }
}

function failed(job: ArchiveCleanupJob, p: CleanupProgress, error: unknown): void {
  const detail = error instanceof Error ? error.message : String(error);
  const attention = isHook(p.phase) || job.attempts + 1 >= MAX_ATTEMPTS;
  const remedy = isHook(p.phase)
    ? "Check the script's effects before confirming completion or rerunning it."
    : "Check available disk space, file permissions, the repository path, and any running processes; fix the reported cause, then Retry cleanup.";
  failArchiveCleanup(job.task_id, `${detail} ${remedy}`.slice(0, 2000));
  db.query("UPDATE tasks SET state_detail = ? WHERE id = ?")
    .run(`Archived. Cleanup is incomplete${attention ? " and needs attention" : " and will be retried"} — ${detail}`.slice(0, 300), job.task_id);
  updateProgress(job.task_id, { status: attention ? "needs-attention" : "pending",
    next_retry_at: attention ? null : new Date(Date.now() + Math.min(CLEANUP_RETRY_MS * 2 ** job.attempts, 15 * 60_000)).toISOString() });
}

async function runJob(id: string): Promise<void> {
  for (;;) {
    if (homeIsDraining()) return;
    const job = archiveCleanup(id), p = cleanupProgress(id);
    if (!job || !p || p.status !== "pending" || (p.next_retry_at && p.next_retry_at > new Date().toISOString())) return;
    if (p.phase === "legacy-hooks") { updateProgress(id, { status: "needs-attention" }); return; }
    updateProgress(id, { status: "running", next_retry_at: null });
    try {
      await stage(job, p);
      const next = CLEANUP_PHASES[CLEANUP_PHASES.indexOf(p.phase) + 1];
      if (!next) {
        clearArchiveCleanup(id);
        if (getTask(id)?.state_detail?.startsWith("Archived. Cleanup is incomplete")) {
          db.query("UPDATE tasks SET state_detail = ? WHERE id = ?").run("Archived. The teardown that failed earlier has now finished.", id);
        }
        notifyCleanup(id);
        return;
      }
      db.transaction(() => {
        db.query("UPDATE archive_cleanups SET stage = ?, attempts = 0, last_error = NULL, updated_at = ? WHERE task_id = ?")
          .run(["save-work", "repo-hook", "project-hook"].includes(next) ? "remove-worktree" : next, new Date().toISOString(), id);
        updateProgress(id, { phase: next, status: "pending", hook_pgid: null, hook_boot: null }, false);
      })();
      notifyCleanup(id);
    } catch (error) { failed(job, p, error); return; }
  }
}

/** Two workers maximum. A slow script never blocks daemon health or task APIs. */
export function resumeArchiveCleanups(): Promise<void> {
  if (working) return working;
  const worker = async (): Promise<void> => {
    for (;;) {
      if (homeIsDraining()) return;
      const ready = pendingArchiveCleanups().find(job => {
        const p = cleanupProgress(job.task_id);
        return p?.status === "pending" && (!p.next_retry_at || p.next_retry_at <= new Date().toISOString());
      });
      if (!ready) return;
      await runJob(ready.task_id);
    }
  };
  working = Promise.all([worker(), worker()]).then(() => {}).finally(() => { working = null; });
  return working;
}

export function kickCleanup(): void {
  void trackHomeWork(resumeArchiveCleanups()).catch(error => console.error(`[wisp] cleanup worker: ${String(error)}`));
}
export function startArchiveCleanupLoop(): ReturnType<typeof setInterval> {
  const timer = setInterval(kickCleanup, 1000);
  timer.unref();
  kickCleanup();
  return timer;
}
