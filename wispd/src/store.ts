import { db } from "./store-database";
export { db, initializeStore } from "./store-database";
import { emit } from "./events";
import type {
  OutboxRow,
  Task,
  TaskContext,
  TaskMode,
  TaskState,
  Turn,
  TurnCaptureMode,
  TurnCaptureState,
  TurnDiagnosticState,
  TurnStatus,
} from "./types";

const now = () => new Date().toISOString();

/** States whose transitions must reach the user (webhook outbox). */
const NOTIFY_STATES: TaskState[] = ["done", "needs-input", "stuck", "failed"];

export function newTaskId(): string {
  return randomId("t", 5);
}

/** Shared with store-messages (task message ids); store re-exports that module. */
export function randomId(prefix: string, length: number): string {
  const chars = "abcdefghjkmnpqrstuvwxyz23456789";
  let s = prefix;
  for (let i = 0; i < length; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

/** Lowest slot number not used by a live task — stable per-task int for port offsets etc. */
export function freeSlot(): number {
  const used = new Set(
    (db.query(`SELECT slot FROM tasks WHERE archived = 0`).all() as { slot: number }[]).map((r) => r.slot),
  );
  let s = 0;
  while (used.has(s)) s++;
  return s;
}

// db.transaction is created at CALL time, never at module scope: store-database
// keeps `db` undefined until the daemon owns the home and initializes it.
export function createTask(t: {
  id: string;
  title: string;
  repo_path: string;
  harness: string;
  model: string | null;
  /** creation-time reasoning-effort snapshot (config harnessDefaults, P5b); optional like createTurn's pid_start_time */
  effort?: string | null;
  /** where turns run; omitted = 'worktree', the behaviour every task had before local mode */
  mode?: TaskMode;
  slot: number;
}): Task {
  return db.transaction((input: typeof t): Task => {
    const timestamp = now();
    db.run(
      `INSERT INTO tasks (id, title, repo_path, harness, model, effort, mode, slot, state, context_n, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'creating', 1, ?, ?)`,
      [input.id, input.title, input.repo_path, input.harness, input.model, input.effort ?? null, input.mode ?? "worktree", input.slot, timestamp, timestamp],
    );
    // A task's first durable context is born with it — one row, one boundary.
    db.run(
      `INSERT INTO task_contexts
         (task_id, n, harness, model, effort, session_id, skills_json, created_at, updated_at)
       VALUES (?, 1, ?, ?, ?, NULL, NULL, ?, ?)`,
      [input.id, input.harness, input.model, input.effort ?? null, timestamp, timestamp],
    );
    return getTask(input.id)!;
  })(t);
}

export function getTask(id: string): Task | null {
  return (db.query(`SELECT * FROM tasks WHERE id = ?`).get(id) as Task | null) ?? null;
}

export function listTasks(includeArchived = false): Task[] {
  const where = includeArchived ? "" : "WHERE archived = 0";
  return db.query(`SELECT * FROM tasks ${where} ORDER BY updated_at DESC`).all() as Task[];
}

/**
 * Tasks wedged mid-creation. Only possible after a daemon crash — creation
 * (worktree + setup + startTurn) runs in-process, so a 'creating' row at
 * startup belongs to a dead daemon.
 */
export function creatingTasks(): Task[] {
  return db.query(`SELECT * FROM tasks WHERE state = 'creating' AND archived = 0`).all() as Task[];
}

/**
 * Fields a caller may set WITHOUT a transition. `state_detail` is on the list
 * and `state` is deliberately not: the archive route's background teardown has
 * to report a failure that happened after the 200 (Q11), and the task's state
 * is not what changed — only the sentence describing it is. seq, the outbox and
 * the notify rules stay transition()'s alone, so the store/runner freeze holds.
 */
const TASK_FIELDS = [
  "title",
  "custom_title",
  "worktree_path",
  "branch",
  "base_commit",
  "base_ref",
  "session_id",
  "skills_json",
  "turn_count",
  "archived",
  "archive_assets_retained",
  "purge_pending",
  "state_detail",
] as const;

export function setTaskFields(id: string, fields: Partial<Pick<Task, (typeof TASK_FIELDS)[number]>>): void {
  const keys = Object.keys(fields).filter((k) => (TASK_FIELDS as readonly string[]).includes(k));
  if (keys.length === 0) return;
  const sets = keys.map((k) => `${k} = ?`).join(", ");
  const vals = keys.map((k) => (fields as Record<string, unknown>)[k]);
  db.run(`UPDATE tasks SET ${sets}, updated_at = ? WHERE id = ?`, [...vals, now(), id] as never[]);
  if (fields.session_id !== undefined || fields.skills_json !== undefined) {
    const task = getTask(id);
    if (task) {
      const contextFields = {
        ...(fields.session_id !== undefined ? { session_id: fields.session_id } : {}),
        ...(fields.skills_json !== undefined ? { skills_json: fields.skills_json } : {}),
      };
      const contextKeys = Object.keys(contextFields);
      const contextSets = contextKeys.map((key) => `${key} = ?`).join(", ");
      const contextValues = contextKeys.map((key) => (contextFields as Record<string, unknown>)[key]);
      db.run(
        `UPDATE task_contexts SET ${contextSets}, updated_at = ? WHERE task_id = ? AND n = ?`,
        [...contextValues, now(), id, task.context_n] as never[],
      );
    }
  }
}

export function getTaskContext(taskId: string, n: number): TaskContext | null {
  return (
    (db.query(`SELECT * FROM task_contexts WHERE task_id = ? AND n = ?`).get(taskId, n) as TaskContext | null) ??
    null
  );
}

/** Transaction body, exported so store-messages can nest it inside its own transaction. */
export function switchTaskAgentBody(
  taskId: string,
  harness: string,
  model: string | null,
  effort: string | null,
  freshContext: boolean,
): Task {
  const task = getTask(taskId);
  if (!task) throw new Error(`no such task: ${taskId}`);
  const timestamp = now();
  if (freshContext) {
    const row = db.query(`SELECT MAX(n) AS max_n FROM task_contexts WHERE task_id = ?`).get(taskId) as {
      max_n: number | null;
    };
    const contextN = (row.max_n ?? task.context_n) + 1;
    db.run(
      `INSERT INTO task_contexts
         (task_id, n, harness, model, effort, session_id, skills_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
      [taskId, contextN, harness, model, effort, timestamp, timestamp],
    );
    db.run(
      `UPDATE tasks
       SET harness = ?, model = ?, effort = ?, context_n = ?, session_id = NULL, skills_json = NULL, updated_at = ?
       WHERE id = ?`,
      [harness, model, effort, contextN, timestamp, taskId],
    );
  } else {
    db.run(
      `UPDATE task_contexts SET model = ?, effort = ?, updated_at = ? WHERE task_id = ? AND n = ?`,
      [model, effort, timestamp, taskId, task.context_n],
    );
    db.run(
      `UPDATE tasks SET model = ?, effort = ?, updated_at = ? WHERE id = ?`,
      [model, effort, timestamp, taskId],
    );
  }
  return getTask(taskId)!;
}

/**
 * Change the active requested agent. A fresh context is the durable boundary
 * used for cross-harness switches and `/fresh`; same-harness model changes
 * update the current context and preserve its provider session.
 */
export function switchTaskAgent(
  taskId: string,
  harness: string,
  model: string | null,
  effort: string | null,
  freshContext: boolean,
): Task {
  // db.transaction at CALL time: `db` is undefined until the daemon initializes it.
  return db.transaction(switchTaskAgentBody)(taskId, harness, model, effort, freshContext);
}

/** Persist provider-owned metadata on the context that produced it. */
export function setTaskContextFields(
  taskId: string,
  contextN: number,
  fields: { session_id?: string | null; skills_json?: string | null },
): void {
  db.transaction(
    (id: string, n: number, updates: typeof fields): void => {
      const keys = Object.keys(updates) as (keyof typeof updates)[];
      if (keys.length === 0) return;
      const timestamp = now();
      const sets = keys.map((key) => `${key} = ?`).join(", ");
      const values = keys.map((key) => updates[key]);
      db.run(
        `UPDATE task_contexts SET ${sets}, updated_at = ? WHERE task_id = ? AND n = ?`,
        [...values, timestamp, id, n] as never[],
      );
      const active = getTask(id);
      if (active?.context_n === n) {
        db.run(
          `UPDATE tasks SET ${sets}, updated_at = ? WHERE id = ?`,
          [...values, timestamp, id] as never[],
        );
      }
    },
  )(taskId, contextN, fields);
}

/**
 * The transaction body of transition(); returns the new seq so the caller can
 * publish it to the event bus AFTER commit (an event for a rolled-back
 * transition would be a lie).
 */
function transitionBody(id: string, state: TaskState, detail?: string | null): number {
  const task = getTask(id);
  if (!task) throw new Error(`transition on unknown task ${id}`);
  const seq = task.seq + 1;
  db.run(`UPDATE tasks SET state = ?, state_detail = ?, seq = ?, updated_at = ? WHERE id = ?`, [
    state,
    detail ?? null,
    seq,
    now(),
    id,
  ]);
  if (NOTIFY_STATES.includes(state)) {
    const payload = JSON.stringify({
      task_id: id,
      seq,
      state,
      title: task.title,
      harness: task.harness,
      detail: detail ?? null,
    });
    db.run(
      `INSERT INTO outbox (task_id, seq, event, payload, next_attempt_at, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      [id, seq, state, payload, now(), now()],
    );
  }
  return seq;
}

/**
 * Atomic state transition: bumps seq, and for notify-worthy states writes the
 * outbox row in the same transaction (the at-least-once delivery guarantee).
 * The event bus (src/events.ts, the SSE layer's source) is fed after commit
 * for EVERY state — NOTIFY_STATES only gates the webhook outbox.
 */
export function transition(id: string, state: TaskState, detail?: string | null): void {
  const seq = db.transaction(transitionBody)(id, state, detail);
  emit({ type: "task", taskId: id, state, stateDetail: detail ?? null, seq });
}

export function createTurn(
  task_id: string,
  n: number,
  prompt: string,
  pid: number | null,
  log_file: string,
  pid_start_time: string | null = null,
  /** the turn's attachment manifest (A1a); null = no images, and stays null for turns that predate the column */
  attachments_json: string | null = null,
  capture_mode: TurnCaptureMode | null = null,
  agent?: {
    context_n: number;
    harness: string;
    model: string | null;
    effort: string | null;
  },
): number {
  const captureState: TurnCaptureState = capture_mode === null ? "legacy" : "complete";
  const task = getTask(task_id);
  const contextN = agent?.context_n ?? task?.context_n ?? 1;
  const harness = agent?.harness ?? task?.harness ?? "";
  const requestedModel = agent?.model ?? task?.model ?? null;
  const requestedEffort = agent?.effort ?? task?.effort ?? null;
  const res = db.run(
    `INSERT INTO turns
       (task_id, n, context_n, harness, requested_model, requested_effort,
        prompt, status, pid, pid_start_time, log_file, started_at, attachments_json,
        capture_mode, capture_state, captured_bytes, omitted_bytes, omitted_records, diagnostic_state)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 'unavailable')`,
    [
      task_id,
      n,
      contextN,
      harness,
      requestedModel,
      requestedEffort,
      prompt,
      pid,
      pid_start_time,
      log_file,
      now(),
      attachments_json,
      capture_mode,
      captureState,
    ],
  );
  emit({ type: "turn", taskId: task_id, n, status: "running" });
  return Number(res.lastInsertRowid);
}

export function finishTurn(id: number, status: TurnStatus, exit_code: number | null, result: string | null): void {
  db.run(`UPDATE turns SET status = ?, exit_code = ?, result = ?, ended_at = ? WHERE id = ?`, [
    status,
    exit_code,
    result,
    now(),
    id,
  ]);
  // keyed by row id, so the bus event's task_id/n come from the updated row
  const turn = getTurn(id);
  if (turn) emit({ type: "turn", taskId: turn.task_id, n: turn.n, status });
}

export function getTurn(id: number): Turn | null {
  return (db.query(`SELECT * FROM turns WHERE id = ?`).get(id) as Turn | null) ?? null;
}

/** Persist (or with null, clear) user-interrupt intent on the turn row (a prior audit). */
export function setTurnInterrupt(id: number, detail: string | null): void {
  db.run(`UPDATE turns SET interrupt_detail = ? WHERE id = ?`, [detail, id]);
}

/** Record the model a turn actually ran on (P5b), parsed from the harness's stream by the adapter. */
export function setTurnModel(id: number, model: string): void {
  db.run(`UPDATE turns SET model = ? WHERE id = ?`, [model, id]);
}

/**
 * Record the harness's own usage report for a turn (Theme B) — the raw blob,
 * JSON-stringified. A field update like setTurnModel, not a transition: the
 * store/runner freeze holds.
 */
export function setTurnUsage(id: number, usageJson: string): void {
  db.run(`UPDATE turns SET usage_json = ? WHERE id = ?`, [usageJson, id]);
}

export interface TurnCaptureCheckpoint {
  state: TurnCaptureState;
  capturedBytes: number;
  omittedBytes: number;
  omittedRecords: number;
  categoriesJson: string | null;
  detail: string | null;
  outcomeJson: string | null;
}

/** Atomically replace the reducer/capture checkpoint for a recorder-owned turn. */
export function setTurnCaptureCheckpoint(id: number, checkpoint: TurnCaptureCheckpoint): void {
  db.run(
    `UPDATE turns
     SET capture_state = ?, captured_bytes = ?, omitted_bytes = ?, omitted_records = ?,
         capture_categories_json = ?, capture_detail = ?, outcome_json = ?
     WHERE id = ?`,
    [
      checkpoint.state,
      checkpoint.capturedBytes,
      checkpoint.omittedBytes,
      checkpoint.omittedRecords,
      checkpoint.categoriesJson,
      checkpoint.detail,
      checkpoint.outcomeJson,
      id,
    ],
  );
}

/** Persist Wisp's own kill/transport reason instead of relying on daemon memory. */
export function setTurnKillDetail(id: number, detail: string | null): void {
  db.run(`UPDATE turns SET kill_detail = ? WHERE id = ?`, [detail, id]);
}

export interface TurnDiagnosticCheckpoint {
  state: TurnDiagnosticState;
  bytes: number;
  firstSeq: number | null;
  lastSeq: number | null;
  detail: string | null;
  evictedAt: string | null;
}

export function setTurnDiagnosticCheckpoint(id: number, checkpoint: TurnDiagnosticCheckpoint): void {
  db.run(
    `UPDATE turns
     SET diagnostic_state = ?, diagnostic_bytes = ?, diagnostic_first_seq = ?, diagnostic_last_seq = ?,
         diagnostic_detail = ?, diagnostic_evicted_at = ?
     WHERE id = ?`,
    [
      checkpoint.state,
      checkpoint.bytes,
      checkpoint.firstSeq,
      checkpoint.lastSeq,
      checkpoint.detail,
      checkpoint.evictedAt,
      id,
    ],
  );
}

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
}

export function latestTurnOutcomes(): Map<string, LatestTurnOutcome> {
  const rows = db
    .query(
      `SELECT task_id, model, exit_code, (result IS NOT NULL) AS has_result FROM turns
       WHERE (task_id, n) IN (SELECT task_id, MAX(n) FROM turns GROUP BY task_id)`,
    )
    .all() as { task_id: string; model: string | null; exit_code: number | null; has_result: number }[];
  return new Map(rows.map((r) => [r.task_id, { model: r.model, exitCode: r.exit_code, hasResult: r.has_result === 1 }]));
}

export function turnsFor(taskId: string): Turn[] {
  return db.query(`SELECT * FROM turns WHERE task_id = ? ORDER BY n ASC`).all(taskId) as Turn[];
}

export function turnForTask(taskId: string, n: number): Turn | null {
  return (
    (db.query(`SELECT * FROM turns WHERE task_id = ? AND n = ?`).get(taskId, n) as Turn | null) ?? null
  );
}

export function latestTurnForTask(taskId: string): Turn | null {
  return (
    (db.query(`SELECT * FROM turns WHERE task_id = ? ORDER BY n DESC LIMIT 1`).get(taskId) as Turn | null) ??
    null
  );
}

export function nextTurnNumber(taskId: string, recordedCount = 0): number {
  const row = db.query(`SELECT MAX(n) AS max_n FROM turns WHERE task_id = ?`).get(taskId) as {
    max_n: number | null;
  };
  return Math.max(recordedCount, row.max_n ?? 0) + 1;
}

export {
  cancelQueuedTaskMessage,
  claimTaskMessageForStart,
  claimTaskMessageForSteering,
  createTaskMessage,
  createTaskMessageWithAgent,
  getTaskMessage,
  markTaskMessageDelivered,
  messagesFor,
  newTaskMessageId,
  nextQueuedMessage,
  releaseOrphanedTaskMessageClaims,
  releaseTaskMessageClaim,
  updateQueuedTaskMessage,
  type TaskAgentSelection,
} from "./store-messages";

export function runningTurns(taskId?: string): Turn[] {
  if (taskId) {
    return db.query(`SELECT * FROM turns WHERE status = 'running' AND task_id = ?`).all(taskId) as Turn[];
  }
  return db.query(`SELECT * FROM turns WHERE status = 'running'`).all() as Turn[];
}

export function runningTurn(taskId: string): Turn | null {
  return (
    (db
      .query(`SELECT * FROM turns WHERE status = 'running' AND task_id = ? ORDER BY n DESC LIMIT 1`)
      .get(taskId) as Turn | null) ?? null
  );
}

export function pendingOutbox(limit = 20): OutboxRow[] {
  return db
    .query(
      `SELECT * FROM outbox WHERE delivered_at IS NULL AND next_attempt_at <= ? ORDER BY id ASC LIMIT ?`,
    )
    .all(now(), limit) as OutboxRow[];
}

export function undeliveredOutbox(): OutboxRow[] {
  return db.query(`SELECT * FROM outbox WHERE delivered_at IS NULL ORDER BY id ASC`).all() as OutboxRow[];
}

export function markDelivered(id: number): void {
  db.run(`UPDATE outbox SET delivered_at = ? WHERE id = ?`, [now(), id]);
}

export function markAttempt(id: number, attempts: number, err: string): void {
  const backoffSec = Math.min(2 ** attempts * 5, 900);
  const next = new Date(Date.now() + backoffSec * 1000).toISOString();
  db.run(`UPDATE outbox SET attempts = ?, next_attempt_at = ?, last_error = ? WHERE id = ?`, [
    attempts,
    next,
    err.slice(0, 500),
    id,
  ]);
}
