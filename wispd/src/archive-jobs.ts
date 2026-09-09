/**
 * The durable record of an archive's destructive half (ENG-04).
 *
 * Archiving is two things: a row flip the user sees immediately, and a
 * teardown that takes unbounded time and can fail. The teardown used to be a
 * detached promise, so a daemon that died between the flip and the deletion
 * stranded worktrees and attachment bytes with nothing left that admitted to
 * owning them. A row here IS that owner — written in the same transaction as
 * the flip, naming the stage reached, and picked up by the next daemon.
 *
 * The stage ORDER is the safety property (see routes/archive.ts): everything
 * destructive sits behind everything that stops a process.
 */
import { db, setTaskFields } from "./store";

const now = () => new Date().toISOString();

/** The ordered stages of an archive teardown; `done` only exists as a deletion. */
export const ARCHIVE_STAGES = ["stop-turn", "stop-shells", "remove-worktree", "remove-attachments"] as const;
export type ArchiveStage = (typeof ARCHIVE_STAGES)[number];

export interface ArchiveCleanupJob {
  task_id: string;
  stage: ArchiveStage;
  force: boolean;
  /** Whether a running turn has to be stopped before anything is deleted. */
  stop_turn: boolean;
  removable: boolean;
  repo_path: string;
  worktree_path: string | null;
  branch: string | null;
  archive_script: string | null;
  timeout_minutes: number;
  attempts: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

interface ArchiveCleanupRow extends Omit<ArchiveCleanupJob, "force" | "stop_turn" | "removable"> {
  force: number;
  stop_turn: number;
  removable: number;
}

function readCleanup(row: ArchiveCleanupRow): ArchiveCleanupJob {
  return { ...row, force: row.force === 1, stop_turn: row.stop_turn === 1, removable: row.removable === 1 };
}

/**
 * Flip a task to archived and record its teardown job in ONE transaction.
 *
 * Either order without a transaction loses something: flip-then-insert can
 * crash into an archived task nobody will clean up, and insert-then-flip can
 * crash into a teardown job for a task that is still live and visible. The
 * caller emits after this returns, so no client observes the flip before the
 * job exists.
 */
export function archiveTaskWithCleanup(
  taskId: string,
  detail: string | null,
  job: Omit<ArchiveCleanupJob, "attempts" | "last_error" | "created_at" | "updated_at">,
): void {
  db.transaction(() => {
    setTaskFields(taskId, { archived: 1, archive_assets_retained: 1, ...(detail === null ? {} : { state_detail: detail }) });
    const stamp = now();
    db.query(
      `INSERT INTO archive_cleanups
         (task_id, stage, force, stop_turn, removable, repo_path, worktree_path, branch,
          archive_script, timeout_minutes, attempts, last_error, created_at, updated_at)
       VALUES ($task_id, $stage, $force, $stop_turn, $removable, $repo_path, $worktree_path, $branch,
               $archive_script, $timeout_minutes, 0, NULL, $created_at, $updated_at)
       ON CONFLICT(task_id) DO UPDATE SET
         stage = $stage, force = $force, stop_turn = $stop_turn, removable = $removable,
         repo_path = $repo_path, worktree_path = $worktree_path, branch = $branch,
         archive_script = $archive_script, timeout_minutes = $timeout_minutes,
         attempts = 0, last_error = NULL, updated_at = $updated_at`,
    ).run({
      $task_id: job.task_id,
      $stage: job.stage,
      $force: job.force ? 1 : 0,
      $stop_turn: job.stop_turn ? 1 : 0,
      $removable: job.removable ? 1 : 0,
      $repo_path: job.repo_path,
      $worktree_path: job.worktree_path,
      $branch: job.branch,
      $archive_script: job.archive_script,
      $timeout_minutes: job.timeout_minutes,
      $created_at: stamp,
      $updated_at: stamp,
    });
    db.query("INSERT OR IGNORE INTO archive_cleanup_progress (task_id, phase) VALUES (?, ?)")
      .run(taskId, job.stage === "remove-worktree" ? "save-work" : job.stage);
  })();
}

/** Every unfinished teardown, oldest first — the startup resume list. */
export function pendingArchiveCleanups(): ArchiveCleanupJob[] {
  return (
    db.query(`SELECT * FROM archive_cleanups ORDER BY created_at, task_id`).all() as ArchiveCleanupRow[]
  ).map(readCleanup);
}

export function archiveCleanup(taskId: string): ArchiveCleanupJob | null {
  const row = db.query(`SELECT * FROM archive_cleanups WHERE task_id = ?`).get(taskId) as ArchiveCleanupRow | null;
  return row === null ? null : readCleanup(row);
}

/** Checkpoint a job at the stage it has reached, clearing any previous error. */
export function advanceArchiveCleanup(taskId: string, stage: ArchiveStage): void {
  db.query(`UPDATE archive_cleanups SET stage = ?, last_error = NULL, updated_at = ? WHERE task_id = ?`).run(
    stage,
    now(),
    taskId,
  );
}

/** Record why a stage refused; the job stays where it is and is retried. */
export function failArchiveCleanup(taskId: string, error: string): void {
  db.query(
    `UPDATE archive_cleanups SET attempts = attempts + 1, last_error = ?, updated_at = ? WHERE task_id = ?`,
  ).run(error, now(), taskId);
}

/** The job finished every stage; the absence of a row is what "clean" means. */
export function clearArchiveCleanup(taskId: string): void {
  db.transaction(() => {
    db.query("DELETE FROM archive_cleanup_progress WHERE task_id = ?").run(taskId);
    db.query(`DELETE FROM archive_cleanups WHERE task_id = ?`).run(taskId);
  })();
}

