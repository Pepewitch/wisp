import { createHash } from "node:crypto";
import { getTask, listTasks } from "./store";
import { purgeTask, RetentionError, taskStorage } from "./task-retention";
import { homeIsDraining } from "./home-lifetime";
import type { Task } from "./types";

export interface PurgeCandidate { id: string; title: string; updatedAt: string; bytes: number | null; error?: string }
export interface PurgePlan { cutoff: string; tasks: PurgeCandidate[]; bytes: number; fingerprint: string }
export interface PurgeResult { reclaimedBytes: number; purged: string[]; failed: { id: string; error: string }[] }

function candidates(cutoff: string): Task[] {
  return listTasks(true).filter(t => t.archived && t.updated_at < cutoff).sort((a, b) => a.id.localeCompare(b.id));
}
function fingerprint(tasks: { id: string; updated_at: string }[]): string {
  return createHash("sha256").update(JSON.stringify(tasks.map(t => [t.id, t.updated_at]))).digest("hex");
}
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }

export async function planBulkPurge(cutoff: string): Promise<PurgePlan> {
  const selected = candidates(cutoff), tasks: PurgeCandidate[] = [];
  for (const task of selected) {
    const row: PurgeCandidate = { id: task.id, title: task.title, updatedAt: task.updated_at, bytes: null };
    try { row.bytes = (await taskStorage(task)).bytes; }
    catch (error) { row.error = message(error); }
    tasks.push(row);
  }
  const version = fingerprint(selected);
  if (fingerprint(candidates(cutoff)) !== version) throw new RetentionError("Archived tasks changed during the preview. Run the dry run again.");
  return { cutoff, tasks, bytes: tasks.reduce((n, task) => n + (task.bytes ?? 0), 0), fingerprint: version };
}

/** Freeze the selection, then let the existing per-task owner enforce every deletion barrier. */
export async function executeBulkPurge(plan: PurgePlan, confirmCount: unknown, confirmFingerprint: unknown): Promise<PurgeResult> {
  if (!Number.isSafeInteger(confirmCount) || confirmCount !== plan.tasks.length) {
    throw new RetentionError(`Stale confirmation: found ${plan.tasks.length} archived tasks. Run the dry run again and confirm its count.`);
  }
  if (confirmFingerprint !== plan.fingerprint || fingerprint(candidates(plan.cutoff)) !== plan.fingerprint) {
    throw new RetentionError("Archived tasks changed since the preview. Run the dry run again.");
  }
  const result: PurgeResult = { reclaimedBytes: 0, purged: [], failed: [] };
  for (const row of plan.tasks) {
    try {
      if (homeIsDraining()) throw new RetentionError("Daemon is shutting down. Retry deletion after restart.");
      const task = getTask(row.id);
      if (!task?.archived || task.updated_at !== row.updatedAt) throw new RetentionError("Task is no longer the archived task shown in the preview.");
      if (row.bytes === null) throw new RetentionError(row.error ?? "Could not measure task storage. Inspect its files before deleting.");
      await purgeTask(task);
      result.reclaimedBytes += row.bytes;
      result.purged.push(row.id);
    } catch (error) {
      result.failed.push({ id: row.id, error: message(error) });
      // A failed purge can have removed some files. Count only bytes we can
      // measure; leave unmeasurable partial deletion out of the receipt.
      const task = getTask(row.id);
      if (task && row.bytes !== null) {
        try { result.reclaimedBytes += Math.max(0, row.bytes - (await taskStorage(task)).bytes); } catch { /* reported above */ }
      }
    }
  }
  return result;
}
