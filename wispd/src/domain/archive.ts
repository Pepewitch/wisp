import { kickCleanup } from "../archive-worker";
import { repoConfigFor, type WispConfig } from "../config";
import { drainSubtaskQueues, hasRunningTurn } from "../runner";
import { assertTaskNotStopping } from "../turn-interrupt";
import { backgroundWork, refreshProcessGroups } from "../task-processes";
import { archiveTaskWithCleanup, type ArchiveCleanupJob } from "../archive-jobs";
import { db, getTask } from "../store";
import { childrenOf, familyOf } from "../subtasks";
import { taskMode, type Task } from "../types";
import { archivePreflight, TEARDOWN_TIMEOUT_MINUTES } from "../worktree";
import { autopilotArchiveWarning, autopilotStatus } from "../autopilot/store";
import { updateTaskAndEmit } from "../task-update";
import { autopilotSwitchDetail, recordAudit, type TaskAuditActor } from "../task-audit";
import { endReviewArchivedAlone, endRoundsOfArchived } from "../verify/archive-reviews";

const PREFLIGHT_CONCURRENCY = 4;

/** One task of the batch, with the consents that apply to it alone. */
interface ArchiveRow {
  task: Task;
  force: boolean;
  /** stop its auto-merge / auto-fix */
  stopAutopilot: boolean;
  /** asked for by name, not brought along by a parent */
  requested: boolean;
}

interface PreparedArchive extends ArchiveRow {
  running: ReturnType<typeof hasRunningTurn>;
  removable: boolean;
  preflight: Awaited<ReturnType<typeof archivePreflight>> | null;
}

/** A child that kept its family's archive from happening, and what it needs. */
export interface RefusedSubtask {
  id: string;
  title: string;
  error: string;
  /** the consent that would let it go: `stopAutopilot` (its automation), or `subtasks` (the request's opt-in) */
  needs?: "stopAutopilot" | "subtasks";
}

interface ArchiveRefusal {
  error: string;
  status: 409;
  task: Task;
  /** the refusal is autopilot's, which the stopAutopilot consent waives */
  needs?: "stopAutopilot";
  /** every child that refused; nothing in the batch changed */
  refusedSubtasks?: RefusedSubtask[];
}

export interface ArchivedTaskResult {
  task: Task;
  branch: string | null;
  note: string | null;
}

/**
 * `stopAutopilot` is the one consent that switching auto-merge / auto-fix off
 * needs; unlike `force` it waives nothing else, so a confirm of that sentence
 * can never also discard unsaved work or kill a turn.
 */
export interface ArchiveOptions {
  stopAutopilot?: boolean
  /** who asked, for the task audit; `api` when the caller did not say */
  actor?: TaskAuditActor
  /** why, when it was not a request about this task (a project removal) */
  reason?: string
  /**
   * A parent's unarchived subtasks go with it only when asked: `archive`
   * (each must be archivable as it is) or `force` (each is forced). Without
   * it, a parent with one is refused. Wisp's reviewers always go, forced.
   */
  subtasks?: "archive" | "force"
}

const refusalText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

async function prepareArchive(row: ArchiveRow): Promise<PreparedArchive | ArchiveRefusal> {
  const task = getTask(row.task.id) ?? row.task;
  if (task.archived) return { ...row, task, running: null, removable: false, preflight: null };
  await refreshProcessGroups(task.id);
  try {
    assertTaskNotStopping(task.id);
  } catch (error) {
    return { error: refusalText(error), status: 409, task };
  }
  const running = hasRunningTurn(task.id);
  if (!row.force && backgroundWork(task.id).state !== "none") {
    return { error: "Background work is still running or unverified — stop it first, or force-archive to stop verified processes", status: 409, task };
  }
  if (running && !row.force) {
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
    preflight = await archivePreflight(task.worktree_path!, task.branch!, task.base_commit, row.force);
    if (preflight.refusal !== null) return { error: preflight.refusal, status: 409, task };
  }
  // Last, so any unsaved work or running turn is what the owner hears about first.
  // A task asked for by name keeps today's rule (force covers it); a child
  // brought along needs the autopilot consent itself, so the two stay separate.
  const waived = row.stopAutopilot || (row.requested && row.force);
  const autopilot = waived ? null : autopilotArchiveWarning(task.id);
  if (autopilot) return { error: autopilot, status: 409, task, needs: "stopAutopilot" };
  return { ...row, task, running, removable, preflight };
}

/**
 * The batch: the tasks asked for, then each one's unarchived family, two
 * levels deep. Reviewers come along forced; a non-reviewer child only with
 * the request's opt-in, and is otherwise a refusal.
 */
function expandFamilies(tasks: Task[], force: boolean, options: ArchiveOptions): { rows: ArchiveRow[]; missing: RefusedSubtask[] } {
  const stopAutopilot = options.stopAutopilot === true;
  const seen = new Set(tasks.map((task) => task.id));
  // a reviewer whose author is in the batch too (a project removal) is forced like one brought along
  const rows: ArchiveRow[] = tasks.map((task) => task.verify_role === "reviewer" && seen.has(task.parent_task_id ?? "")
    ? { task, force: true, stopAutopilot: true, requested: true }
    : { task, force, stopAutopilot, requested: true });
  const missing: RefusedSubtask[] = [];
  for (const task of tasks) {
    for (const member of familyOf(task.id)) {
      if (seen.has(member.id)) continue;
      seen.add(member.id);
      if (member.verify_role === "reviewer") {
        rows.push({ task: member, force: true, stopAutopilot: true, requested: false });
      } else if (options.subtasks) {
        rows.push({ task: member, force: options.subtasks === "force", stopAutopilot, requested: false });
      } else {
        missing.push({ id: member.id, title: member.title, error: "a live subtask", needs: "subtasks" });
      }
    }
  }
  return { rows, missing };
}

function refusedFamily(parent: Task, refused: RefusedSubtask[]): ArchiveRefusal {
  const optIn = refused.every((child) => child.needs === "subtasks");
  const error = optIn
    ? `task ${parent.id} has ${refused.length} live subtask${refused.length === 1 ? "" : "s"} — archive them with it (subtasks: "archive"), or force them ("force")`
    : `${refused.length} of task ${parent.id}'s subtasks cannot be archived; nothing was archived`;
  return { error, status: 409, task: parent, refusedSubtasks: refused };
}

/** Every row prepared, or every refusal: a family archives whole or not at all. */
async function prepareAll(rows: ArchiveRow[]): Promise<PreparedArchive[] | { refusals: { row: ArchiveRow; refusal: ArchiveRefusal }[] }> {
  const prepared: PreparedArchive[] = [];
  const refusals: { row: ArchiveRow; refusal: ArchiveRefusal }[] = [];
  for (let index = 0; index < rows.length; index += PREFLIGHT_CONCURRENCY) {
    const batch = rows.slice(index, index + PREFLIGHT_CONCURRENCY);
    const results = await Promise.all(batch.map((row) => prepareArchive(row)));
    results.forEach((result, at) => {
      if ("error" in result) refusals.push({ row: batch[at]!, refusal: result });
      else prepared.push(result);
    });
  }
  return refusals.length > 0 ? { refusals } : prepared;
}

/**
 * A send may have started a turn while Git preflight yielded, and a child may
 * have been created under a parent in the batch. Recheck every row before the
 * synchronous flips.
 */
function recheck(prepared: PreparedArchive[]): ArchiveRefusal | null {
  const batch = new Set(prepared.map((row) => row.task.id));
  for (const candidate of prepared) {
    try {
      assertTaskNotStopping(candidate.task.id);
    } catch (error) {
      return { error: refusalText(error), status: 409, task: candidate.task };
    }
    const latestRunning = hasRunningTurn(candidate.task.id);
    if (latestRunning && !candidate.force) {
      return {
        error: `turn ${latestRunning.n} is still running — interrupt it first, or force-archive to kill it`,
        status: 409,
        task: candidate.task,
      };
    }
    candidate.running = latestRunning;
    // any child, a reviewer auto-review launched meanwhile included: the family goes whole
    const late = childrenOf(candidate.task.id).find((child) => !batch.has(child.id));
    if (late) return { error: `subtask ${late.id} was created while task ${candidate.task.id} was being archived; try again`, status: 409, task: candidate.task };
  }
  return null;
}

function cleanupJob(row: PreparedArchive, teardownCfg: WispConfig): ArchiveCleanupJob {
  const { task } = row;
  return {
    task_id: task.id,
    stage: "stop-turn",
    force: row.force,
    stop_turn: row.running !== null,
    removable: row.removable,
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
}

/**
 * Archive one or more tasks, with their families, behind one refusal line.
 * Every task is checked before any row flips, so neither a project removal
 * nor a parent's archive can archive only part of what it covers.
 */
export async function archiveTaskRows(
  tasks: Task[],
  force: boolean,
  cfg: WispConfig,
  options: ArchiveOptions = {},
): Promise<ArchiveRefusal | { archived: ArchivedTaskResult[] }> {
  // Teardown runs after project removal mutates cfg.repos, but it still needs
  // the archive hook that was configured when this operation started.
  const teardownCfg: WispConfig = { ...cfg, repos: [...cfg.repos] };
  // an already archived task is reported as it is, and brings no family along
  const already = tasks.filter((task) => (getTask(task.id) ?? task).archived);
  const live = tasks.filter((task) => !already.includes(task));
  const { rows, missing } = expandFamilies(live, force, options);
  const prepared = await prepareAll(rows);
  if ("refusals" in prepared) {
    const own = prepared.refusals.find(({ row }) => row.requested);
    if (own) return own.refusal;
    const refused = [...missing, ...prepared.refusals.map(({ row, refusal }) => ({
      id: row.task.id, title: row.task.title, error: refusal.error, ...(refusal.needs ? { needs: refusal.needs } : {}),
    }))];
    return refusedFamily(parentOf(refused, tasks), refused);
  }
  if (missing.length > 0) return refusedFamily(parentOf(missing, tasks), missing);
  const late = recheck(prepared);
  if (late) return late;

  const actor = options.actor ?? "api";
  const armed = new Map(prepared.map((row) => [row.task.id, autopilotStatus(row.task.id)]));
  const batch = new Set(prepared.map((row) => row.task.id));
  // One transaction for the whole family: its review rounds end, a reviewer
  // archived on its own records why, and every flip with the job that owns
  // its teardown. The emits follow the commit, so no client can observe an
  // archived task whose cleanup nothing is responsible for.
  db.transaction(() => {
    const now = new Date();
    endRoundsOfArchived(prepared.filter((row) => row.task.verify_role !== "reviewer").map((row) => row.task), now);
    for (const row of prepared) {
      if (getTask(row.task.id)?.archived) continue;
      if (row.task.verify_role === "reviewer" && !batch.has(row.task.parent_task_id ?? "")) endReviewArchivedAlone(row.task, actor, now);
      archiveTaskWithCleanup(row.task.id, row.preflight?.leftBehind ?? null, cleanupJob(row, teardownCfg));
    }
  })();
  for (const row of prepared) {
    recordAudit(row.task.id, row.force ? "force-archive" : "archive", actor, options.reason ?? (row.requested ? null : `with task ${row.task.parent_task_id}`));
    // the archive trigger completes auto-merge / auto-fix: say who switched them off
    const before = armed.get(row.task.id)!;
    const stopped = autopilotSwitchDetail(before, { ...before, autoMerge: false, autoFix: false });
    if (stopped) recordAudit(row.task.id, "autopilot", actor, `${stopped} by archiving`);
  }
  // children before their parents; a live parent hears that its list changed
  for (const row of [...prepared].reverse()) updateTaskAndEmit(row.task.id, {});
  const parents = new Set(prepared.map((row) => row.task.parent_task_id).filter((id): id is string => Boolean(id) && !batch.has(id!)));
  for (const parent of parents) updateTaskAndEmit(parent, {});
  kickCleanup();
  const results = new Map([
    ...already.map((task) => [task.id, { task, branch: task.branch, note: null }] as const),
    ...prepared.map((row) => [row.task.id, { task: row.task, branch: row.task.branch, note: row.preflight?.leftBehind ?? null }] as const),
  ]);
  // in the order asked, then the families that came along
  return { archived: [...tasks.map((task) => results.get(task.id)!), ...prepared.filter((row) => !row.requested).map((row) => results.get(row.task.id)!)] };
}

/** The asked-for task a refused child belongs to, for the refusal's headline. */
function parentOf(refused: RefusedSubtask[], tasks: Task[]): Task {
  return tasks.find((task) => familyOf(task.id).some((member) => member.id === refused[0]!.id)) ?? tasks[0]!;
}

/** After an archive freed slots: siblings waiting on a live parent's running cap may start. */
export function drainAfterArchive(archived: ArchivedTaskResult[], adapters: Parameters<typeof drainSubtaskQueues>[1], cfg: WispConfig): void {
  const parents = new Set(archived.map((row) => row.task.parent_task_id).filter((id): id is string => Boolean(id)));
  for (const parent of parents) drainSubtaskQueues(parent, adapters, cfg);
}
