import { kickCleanup } from "../archive-worker";
export { resumeArchiveCleanups, startArchiveCleanupLoop, CLEANUP_RETRY_MS } from "../archive-worker";
import { repoConfigFor, type WispConfig } from "../config";
import { hasRunningTurn } from "../runner";
import { assertTaskNotStopping } from "../turn-interrupt";
import { backgroundWork, refreshProcessGroups } from "../task-processes";
import { archiveTaskWithCleanup, type ArchiveCleanupJob } from "../archive-jobs";
import { getTask } from "../store";
import { taskMode, type Task } from "../types";
import { archivePreflight, TEARDOWN_TIMEOUT_MINUTES } from "../worktree";
import { updateTaskAndEmit } from "./task-update";

const PREFLIGHT_CONCURRENCY = 4;

interface PreparedArchive {
  task: Task;
  running: ReturnType<typeof hasRunningTurn>;
  removable: boolean;
  preflight: Awaited<ReturnType<typeof archivePreflight>> | null;
}

interface ArchiveRefusal {
  error: string;
  status: 409;
  task: Task;
}

export interface ArchivedTaskResult {
  task: Task;
  branch: string | null;
  note: string | null;
}

async function prepareArchive(snapshot: Task, force: boolean): Promise<PreparedArchive | ArchiveRefusal> {
  const task = getTask(snapshot.id) ?? snapshot;
  if (task.archived) return { task, running: null, removable: false, preflight: null };
  await refreshProcessGroups(task.id);
  try {
    assertTaskNotStopping(task.id);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error), status: 409, task };
  }
  const running = hasRunningTurn(task.id);
  if (!force && backgroundWork(task.id).state !== "none") {
    return { error: "Background work is still running or unverified — stop it first, or force-archive to stop verified processes", status: 409, task };
  }
  if (running && !force) {
    return {
      error: `turn ${running.n} is still running — interrupt it first, or force-archive to kill it`,
      status: 409,
      task,
    };
  }
  // A local task's worktree is the user's checkout, so archiving it is only a
  // bookkeeping flip. Worktree tasks run the normal dirty/unpushed preflight.
  const removable = taskMode(task) === "worktree" && task.worktree_path !== null && task.branch !== null;
  let preflight: Awaited<ReturnType<typeof archivePreflight>> | null = null;
  if (removable) {
    preflight = await archivePreflight(task.worktree_path!, task.branch!, task.base_commit, force);
    if (preflight.refusal !== null) return { error: preflight.refusal, status: 409, task };
  }
  return { task, running, removable, preflight };
}

/**
 * Archive one or more tasks behind one refusal line. Every task is checked
 * before any row flips, so bulk removal cannot archive only part of a project
 * before discovering unsaved work.
 */
export async function archiveTaskRows(
  tasks: Task[],
  force: boolean,
  cfg: WispConfig,
): Promise<ArchiveRefusal | { archived: ArchivedTaskResult[] }> {
  // Teardown runs after project removal mutates cfg.repos, but it still needs
  // the archive hook that was configured when this operation started.
  const teardownCfg: WispConfig = { ...cfg, repos: [...cfg.repos] };
  const prepared: PreparedArchive[] = [];
  for (let index = 0; index < tasks.length; index += PREFLIGHT_CONCURRENCY) {
    const batch = await Promise.all(
      tasks.slice(index, index + PREFLIGHT_CONCURRENCY).map((task) => prepareArchive(task, force)),
    );
    const refusal = batch.find((candidate): candidate is ArchiveRefusal => "error" in candidate);
    if (refusal) return refusal;
    prepared.push(...batch.filter((candidate): candidate is PreparedArchive => !("error" in candidate)));
  }

  // A send may have started a turn while Git preflight yielded. Recheck every
  // row before the synchronous archive flips.
  for (const candidate of prepared) {
    try {
      assertTaskNotStopping(candidate.task.id);
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error), status: 409, task: candidate.task };
    }
    const latestRunning = hasRunningTurn(candidate.task.id);
    if (latestRunning && !force) {
      return {
        error: `turn ${latestRunning.n} is still running — interrupt it first, or force-archive to kill it`,
        status: 409,
        task: candidate.task,
      };
    }
    candidate.running = latestRunning;
  }

  const archived = prepared.map(({ task, running, removable, preflight }) => {
    if ((getTask(task.id) ?? task).archived) return { task, branch: task.branch, note: null };
    const job: ArchiveCleanupJob = {
      task_id: task.id,
      stage: "stop-turn",
      force,
      stop_turn: running !== null,
      removable,
      repo_path: task.repo_path,
      worktree_path: task.worktree_path,
      branch: task.branch,
      // Resolved NOW: project removal can take the configured hook away
      // between this flip and the teardown that has to run it.
      archive_script: repoConfigFor(teardownCfg, task.repo_path)?.archiveScript?.trim() ?? null,
      timeout_minutes: teardownCfg.setupTimeoutMinutes ?? TEARDOWN_TIMEOUT_MINUTES,
      attempts: 0,
      last_error: null,
      created_at: "",
      updated_at: "",
    };
    // One transaction: the flip the user sees and the job that owns its
    // teardown. The emit follows the commit, so no client can observe an
    // archived task whose cleanup nothing is responsible for.
    archiveTaskWithCleanup(task.id, preflight?.leftBehind ?? null, job);
    updateTaskAndEmit(task.id, {});
    return { task, branch: task.branch, note: preflight?.leftBehind ?? null };
  });
  kickCleanup();
  return { archived };
}
