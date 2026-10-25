/**
 * The task list's reads: each task with the facts its newest turn settled
 * with. Beside store.ts because that file is at its size limit; store
 * re-exports them.
 */
import { db } from "./store-database";
import type { Task } from "./types";

/**
 * task_id -> the facts its highest-numbered turn settled with: the model it
 * actually ran on (P5b), its exit code, and whether it delivered a terminal
 * result. The last two are what let the list say "exited 1" instead of
 * "failed" when the work landed but the harness CLI exited badly (Theme B).
 */
export interface LatestTurnOutcome {
  model: string | null;
  exitCode: number | null;
  hasResult: boolean;
  /** The turn was one background work woke, not a message's. */
  background: boolean;
  /** The turn was one a subtask report started. */
  report: boolean;
}

export function latestTurnOutcomes(): Map<string, LatestTurnOutcome> {
  const rows = db
    .query(
      `SELECT task_id, model, exit_code, (result IS NOT NULL) AS has_result, origin FROM turns
       WHERE (task_id, n) IN (SELECT task_id, MAX(n) FROM turns GROUP BY task_id)`,
    )
    .all() as { task_id: string; model: string | null; exit_code: number | null; has_result: number; origin: string | null }[];
  return new Map(rows.map((r) => [r.task_id, { model: r.model, exitCode: r.exit_code, hasResult: r.has_result === 1, background: r.origin === "background", report: r.origin === "report" }]));
}

/**
 * The task-list route needs only visible tasks and their newest turn. Looking
 * up that turn through (task_id, n) avoids scanning every archived task's
 * history each time the sidebar refreshes.
 */
export function listTasksWithLatestTurn(includeArchived: boolean, includeCleanup: boolean):
  { task: Task; latestTurn: LatestTurnOutcome }[] {
  const where = includeArchived
    ? ""
    : includeCleanup
      ? "WHERE t.archived = 0 OR EXISTS (SELECT 1 FROM archive_cleanup_progress p WHERE p.task_id = t.id)"
      : "WHERE t.archived = 0";
  const rows = db.query(`
    SELECT t.*, latest.model AS latest_turn_model,
      latest.exit_code AS latest_turn_exit_code,
      (latest.result IS NOT NULL) AS latest_turn_has_result,
      latest.origin AS latest_turn_origin
    FROM tasks t
    LEFT JOIN turns latest ON latest.id = (
      SELECT id FROM turns WHERE task_id = t.id ORDER BY n DESC LIMIT 1
    )
    ${where}
    ORDER BY t.updated_at DESC
  `).all() as (Task & {
    latest_turn_model: string | null;
    latest_turn_exit_code: number | null;
    latest_turn_has_result: number;
    latest_turn_origin: string | null;
  })[];
  return rows.map(({ latest_turn_model, latest_turn_exit_code, latest_turn_has_result, latest_turn_origin, ...task }) => ({
    task: task as Task,
    latestTurn: {
      model: latest_turn_model,
      exitCode: latest_turn_exit_code,
      hasResult: latest_turn_has_result === 1,
      background: latest_turn_origin === "background",
      report: latest_turn_origin === "report",
    },
  }));
}
