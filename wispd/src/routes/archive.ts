import { trackHomeWork } from "../home-lifetime";
import { removeTaskAttachments } from "../attachments";
import { repoConfigFor, type WispConfig } from "../config";
import { hasRunningTurn, killTurnForArchive } from "../runner";
import { assertTaskNotStopping } from "../turn-interrupt";
import { assertTaskProcessesEnded, backgroundWork, refreshProcessGroups } from "../task-processes";
import {
  advanceArchiveCleanup,
  archiveTaskWithCleanup,
  clearArchiveCleanup,
  failArchiveCleanup,
  pendingArchiveCleanups,
  type ArchiveCleanupJob,
  type ArchiveStage,
} from "../archive-jobs";
import { getTask } from "../store";
import { killForTask } from "../terminal";
import { taskMode, type Task } from "../types";
import { archivePreflight, removeWorktree, TEARDOWN_TIMEOUT_MINUTES } from "../worktree";
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
 * Archive's destructive half.
 *
 * Two properties this has to have, and did not:
 *
 * 1. **Fail closed.** Stopping the turn and the task's shells came first but
 *    their failures were only collected, so `git worktree remove --force` ran
 *    anyway — deleting files under a live process. A stop that did not stop is
 *    now the end of the attempt: nothing after it runs.
 *
 * 2. **Be resumable.** The whole thing was a detached promise, so a daemon
 *    that died mid-teardown left a worktree and attachment bytes that no row
 *    admitted to owning. Each stage now checkpoints, and the next daemon (or
 *    the retry loop) picks the job up where it stopped.
 *
 * The stages are ordered so that everything destructive is behind everything
 * that stops a process, and each one is idempotent — a resumed job may repeat
 * the stage it was interrupted in.
 */
/** The sentence a stopped teardown leaves on the task; matched to replace it. */
const INCOMPLETE_PREFIX = "Archived. Cleanup is incomplete";

async function runCleanupStages(job: ArchiveCleanupJob): Promise<void> {
  const stages: { stage: ArchiveStage; what: string; run: () => Promise<void> }[] = [
    {
      stage: "stop-turn",
      what: "could not stop the running turn",
      run: async () => {
        // Called even when nothing was running at archive time: a finished
        // turn can still have left members in its process group, and this is
        // the stage that must refuse rather than let the removal proceed. It
        // is a no-op when there is neither a live turn nor a survivor.
        if (job.force || !job.stop_turn) await killTurnForArchive(job.task_id);
      },
    },
    {
      stage: "stop-shells",
      what: "could not stop the task's shells",
      run: () => killForTask(job.task_id),
    },
    {
      stage: "remove-worktree",
      what: "worktree teardown failed",
      run: async () => {
        if (!job.removable) return;
        await assertTaskProcessesEnded(job.task_id);
        await removeWorktree(
          job.repo_path,
          job.worktree_path!,
          job.branch!,
          job.force,
          teardownConfig(job),
          job.task_id,
        );
      },
    },
    {
      stage: "remove-attachments",
      what: "could not remove the task's attachments",
      run: async () => { await assertTaskProcessesEnded(job.task_id); await removeTaskAttachments(job.task_id); },
    },
  ];

  const from = stages.findIndex((candidate) => candidate.stage === job.stage);
  for (const { stage, what, run } of stages.slice(from === -1 ? 0 : from)) {
    advanceArchiveCleanup(job.task_id, stage);
    try {
      await run();
    } catch (error) {
      const detail = `${what}: ${error instanceof Error ? error.message : String(error)}`;
      failArchiveCleanup(job.task_id, detail);
      console.error(`[wisp] task ${job.task_id}: archive cleanup stopped at ${stage} — ${detail}`);
      // Deliberately no further stages: the next one deletes files, and the
      // reason we are here is that something is still using them.
      noteOnTask(job.task_id, `${INCOMPLETE_PREFIX} and will be retried — ${detail}`);
      return;
    }
  }
  clearArchiveCleanup(job.task_id);
  // Replace the "incomplete" sentence, and only that one: leaving it behind
  // after a successful retry is the same lie in the other direction. A
  // first-attempt success keeps whatever the archive itself said — the "files
  // left behind" note, for instance.
  if ((getTask(job.task_id)?.state_detail ?? "").startsWith(INCOMPLETE_PREFIX)) {
    noteOnTask(job.task_id, "Archived. The teardown that failed earlier has now finished.");
  }
}

/**
 * The teardown context a job carries, rather than whatever the config says
 * now: a project can be removed between the archive and its cleanup, and the
 * archive script configured when the user asked is the one that must run.
 */
function teardownConfig(job: ArchiveCleanupJob): WispConfig {
  // Built from the job's own fields rather than `loadConfig()`. Re-reading the
  // live config would make a teardown depend on a file it does not need — one
  // that can be temporarily unreadable, and whose loader repairs permissions
  // and may persist as a side effect (a review's note). Everything
  // `removeWorktree` reads is already on the job.
  return {
    instanceId: "",
    port: 0,
    host: "127.0.0.1",
    token: "",
    webhooks: [],
    repos: job.archive_script === null ? [] : [{ path: job.repo_path, archiveScript: job.archive_script }],
    stuckMinutes: 0,
    logMaxBytes: 0,
    setupTimeoutMinutes: job.timeout_minutes,
    envAllowlist: {},
    harnessDefaults: {},
  };
}

/** In-flight jobs, so a retry tick never runs one twice. */
const runningCleanups = new Set<string>();

async function runCleanup(job: ArchiveCleanupJob): Promise<void> {
  if (runningCleanups.has(job.task_id)) return;
  runningCleanups.add(job.task_id);
  try {
    await runCleanupStages(job);
  } finally {
    runningCleanups.delete(job.task_id);
  }
}

/**
 * Resume every unfinished teardown. Called at startup — before the port opens,
 * a job whose daemon died mid-stage is exactly as urgent as a turn that needs
 * finalizing — and on a slow timer, which is the automatic half of "retain a
 * retry action with a precise reason".
 */
export async function resumeArchiveCleanups(): Promise<void> {
  for (const job of pendingArchiveCleanups()) {
    // A resumed job's task may have been purged from the database entirely;
    // the row is then the only thing left, and the stages are all no-ops.
    await runCleanup(job).catch((error) => {
      console.error(`[wisp] task ${job.task_id}: archive cleanup failed — ${String(error)}`);
    });
  }
}

/** How often an incomplete teardown is retried while the daemon runs. */
export const CLEANUP_RETRY_MS = 60_000;

export function startArchiveCleanupLoop(): ReturnType<typeof setInterval> {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await trackHomeWork(resumeArchiveCleanups());
    } finally {
      running = false;
    }
  }, CLEANUP_RETRY_MS);
  timer.unref?.();
  return timer;
}

async function prepareArchive(snapshot: Task, force: boolean): Promise<PreparedArchive | ArchiveRefusal> {
  const task = getTask(snapshot.id) ?? snapshot;
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
    void trackHomeWork(runCleanup(job));
    return { task, branch: task.branch, note: preflight?.leftBehind ?? null };
  });
  return { archived };
}
