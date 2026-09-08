import { Database } from "bun:sqlite";
import { DB_PATH } from "./config";
import { enforceForeignKeys, migrate } from "./migrations";
import { emit } from "./events";
import type {
  OutboxRow,
  Task,
  TaskMessage,
  TaskMessageDelivery,
  TaskMode,
  TaskState,
  Turn,
  TurnCaptureMode,
  TurnCaptureState,
  TurnDiagnosticState,
  TurnStatus,
} from "./types";

export const db = new Database(DB_PATH, { create: true });

/**
 * Schema first, then enforcement — both through the ledger (ENG-06), so an
 * upgrade is recorded, and a profile written by a newer Wisp is refused rather
 * than read with columns this build does not know exist.
 */
migrate(db);
enforceForeignKeys(db);

const now = () => new Date().toISOString();

/** States whose transitions must reach the user (webhook outbox). */
const NOTIFY_STATES: TaskState[] = ["done", "needs-input", "stuck", "failed"];

export function newTaskId(): string {
  return randomId("t", 5);
}

function randomId(prefix: string, length: number): string {
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
  db.run(
    `INSERT INTO tasks (id, title, repo_path, harness, model, effort, mode, slot, state, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'creating', ?, ?)`,
    [t.id, t.title, t.repo_path, t.harness, t.model, t.effort ?? null, t.mode ?? "worktree", t.slot, now(), now()],
  );
  return getTask(t.id)!;
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
  "worktree_path",
  "branch",
  "base_commit",
  "session_id",
  "skills_json",
  "turn_count",
  "archived",
  "state_detail",
] as const;

export function setTaskFields(id: string, fields: Partial<Pick<Task, (typeof TASK_FIELDS)[number]>>): void {
  const keys = Object.keys(fields).filter((k) => (TASK_FIELDS as readonly string[]).includes(k));
  if (keys.length === 0) return;
  const sets = keys.map((k) => `${k} = ?`).join(", ");
  const vals = keys.map((k) => (fields as Record<string, unknown>)[k]);
  db.run(`UPDATE tasks SET ${sets}, updated_at = ? WHERE id = ?`, [...vals, now(), id] as never[]);
}

/**
 * The transaction body of transition(); returns the new seq so the caller can
 * publish it to the event bus AFTER commit (an event for a rolled-back
 * transition would be a lie).
 */
const transitionTx = db.transaction((id: string, state: TaskState, detail?: string | null): number => {
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
});

/**
 * Atomic state transition: bumps seq, and for notify-worthy states writes the
 * outbox row in the same transaction (the at-least-once delivery guarantee).
 * The event bus (src/events.ts, the SSE layer's source) is fed after commit
 * for EVERY state — NOTIFY_STATES only gates the webhook outbox.
 */
export function transition(id: string, state: TaskState, detail?: string | null): void {
  const seq = transitionTx(id, state, detail);
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
): number {
  const captureState: TurnCaptureState = capture_mode === null ? "legacy" : "complete";
  const res = db.run(
    `INSERT INTO turns
       (task_id, n, prompt, status, pid, pid_start_time, log_file, started_at, attachments_json,
        capture_mode, capture_state, captured_bytes, omitted_bytes, omitted_records, diagnostic_state)
     VALUES (?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 'unavailable')`,
    [task_id, n, prompt, pid, pid_start_time, log_file, now(), attachments_json, capture_mode, captureState],
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

export function newTaskMessageId(): string {
  return randomId("m", 12);
}

export function createTaskMessage(input: {
  id: string;
  taskId: string;
  text: string;
  attachmentHash: string;
  attachmentsJson?: string | null;
}): TaskMessage {
  const timestamp = now();
  db.run(
    `INSERT INTO task_messages
      (id, task_id, text, status, delivery, turn_n, attachment_hash, attachments_json, created_at, updated_at)
     VALUES (?, ?, ?, 'queued', NULL, NULL, ?, ?, ?, ?)`,
    [
      input.id,
      input.taskId,
      input.text,
      input.attachmentHash,
      input.attachmentsJson ?? null,
      timestamp,
      timestamp,
    ],
  );
  const message = getTaskMessage(input.id)!;
  emit({ type: "message", taskId: input.taskId, messageId: input.id });
  return message;
}

export function getTaskMessage(id: string): TaskMessage | null {
  return (db.query(`SELECT * FROM task_messages WHERE id = ?`).get(id) as TaskMessage | null) ?? null;
}

export function messagesFor(taskId: string): TaskMessage[] {
  return db
    .query(`SELECT * FROM task_messages WHERE task_id = ? ORDER BY created_at ASC, rowid ASC`)
    .all(taskId) as TaskMessage[];
}

export function nextQueuedMessage(taskId: string): TaskMessage | null {
  return (
    (db
      .query(
        `SELECT * FROM task_messages
         WHERE task_id = ? AND status = 'queued' AND claim IS NULL
         ORDER BY created_at ASC, rowid ASC LIMIT 1`,
      )
      .get(taskId) as TaskMessage | null) ?? null
  );
}

export function updateQueuedTaskMessage(id: string, taskId: string, text: string): TaskMessage | null {
  const result = db.run(
    `UPDATE task_messages SET text = ?, updated_at = ?
     WHERE id = ? AND task_id = ? AND status = 'queued' AND claim IS NULL`,
    [text, now(), id, taskId],
  );
  const updated = result.changes > 0 ? getTaskMessage(id) : null;
  if (updated) emit({ type: "message", taskId, messageId: id });
  return updated;
}

export function cancelQueuedTaskMessage(id: string, taskId: string): TaskMessage | null {
  db.run(
    `UPDATE task_messages SET status = 'cancelled', updated_at = ?
     WHERE id = ? AND task_id = ? AND status = 'queued' AND claim IS NULL`,
    [now(), id, taskId],
  );
  const message = getTaskMessage(id);
  const cancelled = message?.task_id === taskId && message.status === "cancelled" ? message : null;
  if (cancelled) emit({ type: "message", taskId, messageId: id });
  return cancelled;
}

/**
 * Reserve a queued row while a native channel is waiting for admission.
 * Keeping the claim in internal columns preserves the public three-state
 * model while blocking edit/cancel/FIFO drain.
 */
export function claimTaskMessageForSteering(id: string, taskId: string, turnN: number): TaskMessage | null {
  return claimTaskMessage(id, taskId, turnN, "steered");
}

function claimTaskMessage(
  id: string,
  taskId: string,
  turnN: number,
  delivery: Exclude<TaskMessageDelivery, null>,
): TaskMessage | null {
  const result = db.run(
    `UPDATE task_messages
     SET claim = ?, claim_turn_n = ?, updated_at = ?
     WHERE id = ? AND task_id = ? AND status = 'queued' AND claim IS NULL
       AND id = (
         SELECT queued.id FROM task_messages AS queued
         WHERE queued.task_id = ? AND queued.status = 'queued'
         ORDER BY queued.created_at ASC, queued.rowid ASC LIMIT 1
       )`,
    [delivery, turnN, now(), id, taskId, taskId],
  );
  return result.changes > 0 ? getTaskMessage(id) : null;
}

/** Reserve the FIFO head across attachment promotion, spawn, and turn-row creation. */
export function claimTaskMessageForStart(id: string, taskId: string, turnN: number): TaskMessage | null {
  return claimTaskMessage(id, taskId, turnN, "started");
}

/** Put an incomplete delivery back at its original FIFO position. */
export function releaseTaskMessageClaim(
  id: string,
  taskId: string,
  deliveryUncertain = false,
): TaskMessage | null {
  const result = db.run(
    `UPDATE task_messages
     SET claim = NULL, claim_turn_n = NULL,
         delivery_uncertain = MAX(delivery_uncertain, ?), updated_at = ?
     WHERE id = ? AND task_id = ? AND status = 'queued' AND claim IS NOT NULL`,
    [deliveryUncertain ? 1 : 0, now(), id, taskId],
  );
  const released = result.changes > 0 ? getTaskMessage(id) : null;
  if (released && deliveryUncertain) emit({ type: "message", taskId, messageId: id });
  return released;
}

/**
 * A daemon crash can strand an in-flight admission claim. A start is proven
 * by its turn row. Native steering cannot be made exactly-once across the
 * acknowledgement/SQLite boundary, so retry it at least once and preserve an
 * explicit uncertainty bit for API/UI disclosure.
 */
export function releaseOrphanedTaskMessageClaims(): void {
  const rows = db
    .query(
      `SELECT id, task_id, claim, claim_turn_n
       FROM task_messages WHERE status = 'queued' AND claim IS NOT NULL`,
    )
    .all() as {
      id: string;
      task_id: string;
      claim: Exclude<TaskMessageDelivery, null>;
      claim_turn_n: number | null;
    }[];
  for (const row of rows) {
    const turn =
      row.claim_turn_n === null
        ? null
        : (db.query(`SELECT id FROM turns WHERE task_id = ? AND n = ?`).get(row.task_id, row.claim_turn_n) as
            | { id: number }
            | null);
    if (row.claim === "started" && turn && row.claim_turn_n !== null) {
      markTaskMessageDelivered(row.id, "started", row.claim_turn_n);
    } else {
      // Without a turn row, even a start claim could have crossed the spawn
      // boundary before the daemon died. Conservatively disclose possible
      // delivery rather than presenting a replay as certainly new.
      releaseTaskMessageClaim(row.id, row.task_id, true);
    }
  }
}

export function markTaskMessageDelivered(
  id: string,
  delivery: Exclude<TaskMessageDelivery, null>,
  turnN: number,
): TaskMessage {
  db.run(
    `UPDATE task_messages
     SET status = 'delivered', delivery = ?, turn_n = ?, claim = NULL, claim_turn_n = NULL, updated_at = ?
     WHERE id = ? AND status = 'queued'`,
    [delivery, turnN, now(), id],
  );
  const message = getTaskMessage(id);
  if (!message || message.status !== "delivered") throw new Error(`queued message ${id} was no longer available`);
  emit({ type: "message", taskId: message.task_id, messageId: id });
  return message;
}

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
