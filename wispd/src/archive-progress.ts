import { db, getTask } from "./store";
import { archiveCleanup } from "./archive-jobs";
import { emit } from "./events";

export const CLEANUP_PHASES = ["stop-turn", "stop-shells", "save-work", "repo-hook", "project-hook", "remove-worktree", "remove-attachments"] as const;
export type CleanupPhase = typeof CLEANUP_PHASES[number] | "legacy-hooks";
export type CleanupState = "pending" | "running" | "needs-attention" | "complete";
export interface CleanupProgress {
  task_id: string; phase: CleanupPhase; status: CleanupState; repo_script: string | null;
  prepared: number; next_retry_at: string | null; revision: number;
  hook_pgid: number | null; hook_boot: string | null;
}
export interface CleanupSummary {
  state: CleanupState; step: string; error: string | null; retryAt: string | null;
  revision: number; uncertain: boolean; confirmStopped: boolean;
}
export const isHook = (phase: string): boolean => ["repo-hook", "project-hook", "legacy-hooks"].includes(phase);
const LABELS: Record<CleanupPhase, string> = {
  "stop-turn": "Stop task processes", "stop-shells": "Stop task terminals", "save-work": "Save uncommitted work",
  "repo-hook": "Repository cleanup script", "project-hook": "Project archive script",
  "legacy-hooks": "Cleanup scripts from an earlier Wisp version", "remove-worktree": "Remove workspace", "remove-attachments": "Finalize archive",
};
export function cleanupProgress(id: string): CleanupProgress | null {
  return db.query("SELECT * FROM archive_cleanup_progress WHERE task_id = ?").get(id) as CleanupProgress | null;
}
export function cleanupSummary(id: string): CleanupSummary {
  const p = cleanupProgress(id), job = archiveCleanup(id);
  return p && job ? { state: p.status, step: LABELS[p.phase], error: job.last_error,
    retryAt: p.next_retry_at, revision: p.revision, uncertain: isHook(p.phase) && p.status === "needs-attention",
    confirmStopped: p.phase === "legacy-hooks" } :
    { state: "complete", step: "Cleanup complete", error: null, retryAt: null, revision: 0, uncertain: false, confirmStopped: false };
}
export function notifyCleanup(id: string): void {
  const task = getTask(id);
  if (task) emit({ type: "task", taskId: id, state: task.state, stateDetail: task.state_detail, seq: task.seq });
}
export function updateProgress(id: string, fields: Partial<Omit<CleanupProgress, "task_id" | "revision">>, notify = true): void {
  const keys = Object.keys(fields) as (keyof typeof fields)[];
  db.query(`UPDATE archive_cleanup_progress SET ${keys.map(k => `${k} = ?`).join(", ")}, revision = revision + 1 WHERE task_id = ?`)
    .run(...keys.map(k => fields[k]!), id);
  if (notify) notifyCleanup(id);
}
/** Startup only: a hook started by a previous owner has an uncertain outcome. */
export function recoverCleanupProgress(): void {
  for (const p of db.query("SELECT * FROM archive_cleanup_progress WHERE status = 'running'").all() as CleanupProgress[]) {
    const uncertain = isHook(p.phase) && p.hook_pgid !== null;
    updateProgress(p.task_id, { status: uncertain ? "needs-attention" : "pending" });
    if (uncertain) db.query("UPDATE archive_cleanups SET last_error = ? WHERE task_id = ?")
      .run("Wisp stopped before recording the script result. It may have already made changes. Check its outcome before confirming completion or rerunning it.", p.task_id);
  }
}
