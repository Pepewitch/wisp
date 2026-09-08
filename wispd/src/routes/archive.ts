import { removeTaskAttachments } from "../attachments";
import type { WispConfig } from "../config";
import { hasRunningTurn, killTurnForArchive } from "../runner";
import { getTask } from "../store";
import { killForTask } from "../terminal";
import { taskMode, type Task } from "../types";
import { archivePreflight, removeWorktree } from "../worktree";
import { updateTaskAndEmit } from "./task-update";

const STATE_DETAIL_CAP = 300;
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

function noteOnTask(taskId: string, detail: string): void {
  updateTaskAndEmit(taskId, { state_detail: detail.slice(0, STATE_DETAIL_CAP) });
}

/**
 * Archive's destructive half, run after the response. Everything here either
 * takes unbounded time or cannot refuse, so teardown failures are recorded on
 * the already-archived task rather than delaying the API response.
 */
async function teardownArchive(
  task: Task,
  force: boolean,
  wasRunning: boolean,
  removable: boolean,
  cfg: WispConfig,
): Promise<void> {
  const failures: string[] = [];
  const attempt = async (what: string, run: () => Promise<void>): Promise<void> => {
    try {
      await run();
    } catch (error) {
      failures.push(`${what}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  if (wasRunning && force) {
    await attempt("could not stop the running turn", () => killTurnForArchive(task.id));
  }
  await attempt("could not stop the task's shells", () => killForTask(task.id));
  if (removable) {
    await attempt("worktree teardown failed", () =>
      removeWorktree(task.repo_path, task.worktree_path!, task.branch!, force, cfg, task.id),
    );
  }
  await attempt("could not remove the task's attachments", () => removeTaskAttachments(task.id));
  if (failures.length > 0) {
    console.error(`[wisp] task ${task.id}: archive teardown failed — ${failures.join("; ")}`);
    noteOnTask(task.id, `Archived, but the teardown failed — ${failures.join("; ")}`);
  }
}

async function prepareArchive(snapshot: Task, force: boolean): Promise<PreparedArchive | ArchiveRefusal> {
  const task = getTask(snapshot.id) ?? snapshot;
  const running = hasRunningTurn(task.id);
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
    updateTaskAndEmit(task.id, {
      archived: 1,
      ...(preflight?.leftBehind ? { state_detail: preflight.leftBehind } : {}),
    });
    void teardownArchive(task, force, running !== null, removable, teardownCfg);
    return { task, branch: task.branch, note: preflight?.leftBehind ?? null };
  });
  return { archived };
}
