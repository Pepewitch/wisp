/**
 * The durable task-message queue (D20+): rows outlive the daemon, claims make
 * an in-flight admission visible to edit/cancel/FIFO, and a submission's
 * agent snapshot commits in the same transaction as its row.
 *
 * Split out of store.ts under the file-size budget; the store re-exports
 * everything here so importers keep one module to know.
 */
import { db } from "./store-database";
import { emit } from "./events";
import { getTask, randomId, switchTaskAgentBody } from "./store";
import type { Task, TaskMessage, TaskMessageDelivery } from "./types";

const now = () => new Date().toISOString();

export function newTaskMessageId(): string {
  return randomId("m", 12);
}

interface CreateTaskMessageInput {
  id: string;
  taskId: string;
  contextN?: number;
  harness?: string;
  model?: string | null;
  effort?: string | null;
  text: string;
  attachmentHash: string;
  attachmentsJson?: string | null;
}

export interface TaskAgentSelection {
  harness: string;
  model: string | null;
  effort: string | null;
  freshContext: boolean;
}

function insertTaskMessage(input: CreateTaskMessageInput, task: Task): TaskMessage {
  const timestamp = now();
  db.run(
    `INSERT INTO task_messages
      (id, task_id, context_n, harness, model, effort, text, status, delivery, turn_n,
       attachment_hash, attachments_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', NULL, NULL, ?, ?, ?, ?)`,
    [
      input.id,
      input.taskId,
      input.contextN ?? task.context_n,
      input.harness ?? task.harness,
      input.model === undefined ? task.model : input.model,
      input.effort === undefined ? task.effort : input.effort,
      input.text,
      input.attachmentHash,
      input.attachmentsJson ?? null,
      timestamp,
      timestamp,
    ],
  );
  return getTaskMessage(input.id)!;
}

/**
 * Snapshot a submission's agent and persist its queue row in one transaction.
 * A crash can therefore expose neither a switched task without its first
 * message nor a message attributed to an agent the task never adopted.
 */
export function createTaskMessageWithAgent(
  input: CreateTaskMessageInput,
  agent: TaskAgentSelection,
): { task: Task; message: TaskMessage } {
  let switched = false;
  const result = db.transaction(() => {
    let task = getTask(input.taskId);
    if (!task) throw new Error(`no such task: ${input.taskId}`);
    // The route/runner checks precede an async gap (attachment staging), so
    // the transaction re-asks before committing the switch and the row.
    if (task.archived) throw new Error("task is archived — archived tasks are read-only");
    if (task.state === "creating") throw new Error("task is still being created");
    if (
      agent.freshContext ||
      agent.harness !== task.harness ||
      agent.model !== task.model ||
      agent.effort !== task.effort
    ) {
      task = switchTaskAgentBody(
        input.taskId,
        agent.harness,
        agent.model,
        agent.effort,
        agent.freshContext,
      );
      switched = true;
    }
    return { task, message: insertTaskMessage(input, task) };
  })();
  if (switched) {
    emit({
      type: "task",
      taskId: result.task.id,
      state: result.task.state,
      stateDetail: result.task.state_detail,
      seq: result.task.seq,
    });
  }
  emit({ type: "message", taskId: input.taskId, messageId: input.id });
  return result;
}

/**
 * The raw queue-row insert — no agent switch, no state guards. Internal
 * callers (fixtures, tests) use this; user submissions go through
 * createTaskMessageWithAgent so the guard and the switch commit together.
 */
export function createTaskMessage(input: CreateTaskMessageInput, notify = true): TaskMessage {
  const task = getTask(input.taskId);
  if (!task) throw new Error(`no such task: ${input.taskId}`);
  const message = insertTaskMessage(input, task);
  if (notify) emit({ type: "message", taskId: input.taskId, messageId: input.id });
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

export function nextQueuedMessage(taskId: string, workflowMessageId = ""): TaskMessage | null {
  return (
    (db
      .query(
        `SELECT * FROM task_messages
         WHERE task_id = ? AND status = 'queued' AND claim IS NULL AND (workflow_id IS NULL OR id = ?)
         ORDER BY created_at ASC, rowid ASC LIMIT 1`,
      )
      .get(taskId, workflowMessageId) as TaskMessage | null) ?? null
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
         WHERE queued.task_id = ? AND queued.status = 'queued' AND (queued.workflow_id IS NULL OR queued.id = ?)
         ORDER BY queued.created_at ASC, queued.rowid ASC LIMIT 1
       )`,
    [delivery, turnN, now(), id, taskId, taskId, id],
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
