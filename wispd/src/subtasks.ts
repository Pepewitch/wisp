/**
 * Subtasks: a task that belongs to a parent task (migration 26).
 *
 * The relationship is fixed when the child is created and never edited. A
 * parent is a root task; the one exception is Wisp's own reviewers, which may
 * sit under a subtask whose PR they review. Reviewers (`verify_role =
 * 'reviewer'`) are children like any other for display and archive, but they
 * never count toward a parent's caps or its "live subtasks".
 */
import { db } from "./store";
import type { ApiSubtask } from "../../shared/api/task";
import type { SubtaskKind, Task } from "./types";

export type { SubtaskKind };

/** Every child of a task, newest first; archived ones only when asked. */
export function childrenOf(parentId: string, options: { archived?: boolean } = {}): Task[] {
  const where = options.archived ? "" : "AND archived = 0";
  return db.query(`SELECT * FROM tasks WHERE parent_task_id = ? ${where} ORDER BY created_at DESC, id`).all(parentId) as Task[];
}

/** The unarchived children that count: everything but Wisp's reviewers. */
export function liveNonReviewerChildren(parentId: string): Task[] {
  return db
    .query(`SELECT * FROM tasks WHERE parent_task_id = ? AND archived = 0 AND verify_role IS NOT 'reviewer' ORDER BY created_at, id`)
    .all(parentId) as Task[];
}

/**
 * A task and its descendants, at most two levels (a root, its children, and
 * the reviewers of a child's PR), parents before children.
 */
export function familyOf(rootId: string, options: { archived?: boolean } = {}): Task[] {
  const children = childrenOf(rootId, options);
  return children.flatMap((child) => [child, ...childrenOf(child.id, options)]);
}

/** A subtask whose parent was deleted: it keeps its kind, and loses the link. */
export function isOrphan(task: Pick<Task, "parent_task_id" | "subtask_kind">): boolean {
  return !task.parent_task_id && Boolean(task.subtask_kind);
}

/**
 * The parent whose running cap applies to this task's turns, or null: a root,
 * a reviewer and an orphan are capped by the global limit only.
 */
export function cappedParent(task: Pick<Task, "parent_task_id" | "verify_role"> | null): string | null {
  if (!task?.parent_task_id || task.verify_role) return null;
  return task.parent_task_id;
}

/** A clipped result is all a list needs; the whole one is `wisp result <id>`. */
const RESULT_CLIP = 300;

interface ReportCounts {
  child_task_id: string;
  pending: number;
  queued: number;
  dropped: number;
}

/** Every child, archived ones too, newest first, as GET /api/tasks/:id/subtasks serves them. */
export function subtaskSummaries(parentId: string): ApiSubtask[] {
  const children = childrenOf(parentId, { archived: true });
  if (children.length === 0) return [];
  const ids = children.map((child) => child.id);
  const marks = ids.map(() => "?").join(", ");
  const results = new Map(
    (db.query(`SELECT task_id, result FROM turns t WHERE task_id IN (${marks}) AND result IS NOT NULL
      AND n = (SELECT MAX(n) FROM turns WHERE task_id = t.task_id AND result IS NOT NULL)`).all(...ids) as { task_id: string; result: string }[])
      .map((row) => [row.task_id, row.result]),
  );
  const reports = new Map(
    (db.query(`SELECT child_task_id,
        SUM(state = 'pending') AS pending, SUM(state = 'queued') AS queued, SUM(state = 'dropped') AS dropped
      FROM subtask_reports WHERE child_task_id IN (${marks}) GROUP BY child_task_id`).all(...ids) as ReportCounts[])
      .map((row) => [row.child_task_id, row]),
  );
  return children.map((child) => {
    const result = results.get(child.id) ?? null;
    const counts = reports.get(child.id);
    return {
      id: child.id,
      title: child.title,
      kind: child.subtask_kind ?? null,
      reviewer: child.verify_role === "reviewer",
      state: child.state,
      archived: child.archived !== 0,
      report_to_parent: child.report_to_parent === 1,
      base_from: child.base_from ?? null,
      result: result === null ? null : result.length > RESULT_CLIP ? `${result.slice(0, RESULT_CLIP)}…` : result,
      reports: { pending: counts?.pending ?? 0, queued: counts?.queued ?? 0, dropped: counts?.dropped ?? 0 },
      created_at: child.created_at,
      updated_at: child.updated_at,
    };
  });
}
