import { db, getTask } from "./store";
import { archiveCleanup } from "./archive-jobs";
import { emit } from "./events";
import type { CleanupState, CleanupSummary } from "../../shared/api/task";

export type { CleanupState, CleanupSummary } from "../../shared/api/task";

export const CLEANUP_PHASES = ["stop-turn", "stop-shells", "save-work", "repo-hook", "project-hook", "remove-worktree", "remove-attachments"] as const;
export type CleanupPhase = typeof CLEANUP_PHASES[number] | "legacy-hooks";
export interface CleanupProgress {
  task_id: string; phase: CleanupPhase; status: CleanupState; repo_script: string | null;
  prepared: number; next_retry_at: string | null; revision: number;
  hook_pgid: number | null; hook_boot: string | null;
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
const CLEANUP_COMPLETE: CleanupSummary = Object.freeze({ state: "complete", step: "Cleanup complete", error: null, retryAt: null, revision: 0, uncertain: false, confirmStopped: false });
function summaryOf(p: Pick<CleanupProgress, "phase" | "status" | "next_retry_at" | "revision">, error: string | null): CleanupSummary {
  return { state: p.status, step: LABELS[p.phase], error, retryAt: p.next_retry_at, revision: p.revision,
    uncertain: isHook(p.phase) && p.status === "needs-attention", confirmStopped: p.phase === "legacy-hooks" };
}
export function cleanupSummary(id: string): CleanupSummary {
  const p = cleanupProgress(id), job = archiveCleanup(id);
  return p && job ? summaryOf(p, job.last_error) : CLEANUP_COMPLETE;
}
/**
 * cleanupSummary() for every archived task in one read, for the task list:
 * one statement for the whole list instead of two per archived row. A task
 * missing from the map has nothing in progress, so it is complete.
 */
export function cleanupSummaries(): (id: string) => CleanupSummary {
  const rows = db.query(`SELECT p.task_id, p.phase, p.status, p.next_retry_at, p.revision, c.last_error
    FROM archive_cleanup_progress p JOIN archive_cleanups c ON c.task_id = p.task_id`)
    .all() as (Pick<CleanupProgress, "task_id" | "phase" | "status" | "next_retry_at" | "revision"> & { last_error: string | null })[];
  const summaries = new Map(rows.map(row => [row.task_id, summaryOf(row, row.last_error)]));
  return id => summaries.get(id) ?? CLEANUP_COMPLETE;
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
