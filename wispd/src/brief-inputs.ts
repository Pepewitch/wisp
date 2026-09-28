/**
 * What the person last said, for task briefs — recorded by Wisp, never asked
 * of the model.
 *
 * Three sources, ordered by the admission number each input was given when it
 * arrived (store-messages `admitTaskInput`), never by timestamp or by when it
 * was delivered: an older queued message that reaches the agent after a newer
 * answer does not become "the latest thing you said".
 *
 *  - a message the person wrote (origin 'human', or 'legacy' for rows from
 *    before origin was recorded). A workflow's message never counts, even
 *    after a finished workflow clears its link. A cancelled message counts
 *    only while its delivery is uncertain — one that certainly never arrived
 *    was not said to the agent.
 *  - an answer to a native questionnaire, which bypasses the message table.
 *    While briefs are on, the answer route records it here BEFORE the native
 *    write and settles it after, so a crash in between leaves it uncertain
 *    rather than silently delivered — and its text outlives the turn log.
 *  - the task's first prompt, when there is nothing else. It is the prompt as
 *    stored, which may carry a suffix prompt the person picked.
 */
import { BRIEF_INPUT_EXCERPT, type BriefLatestInput } from "../../shared/task-brief";
import { db, getTask, getTurn } from "./store";
import { admitTaskInput } from "./store-messages";
import type { Task, TaskMessage } from "./types";

interface AnswerObservationRow {
  id: string;
  task_id: string;
  turn_id: number;
  turn_n: number;
  context_n: number;
  source_seq: number;
  question_id: string;
  question_text: string;
  answers_json: string;
  state: "pending" | "delivered" | "failed" | "uncertain";
  created_at: string;
  updated_at: string;
}

/** The latest input and the admission number that ranks it (0 = the task prompt). */
export interface RankedInput {
  seq: number;
  input: BriefLatestInput;
}

/** What a publication remembers about the person's input at the moment it was saved. */
export interface InputSnapshot {
  inputRev: number;
  latestSeq: number;
  latestKind: BriefLatestInput["kind"] | null;
  latestId: string | null;
  /** a person's message was still waiting for a turn */
  pending: boolean;
  uncertain: boolean;
}

const QUESTION_TEXT_MAX = 2000;

function excerpt(text: string): Pick<BriefLatestInput, "text" | "truncated" | "length"> {
  const points = [...text];
  return points.length > BRIEF_INPUT_EXCERPT
    ? { text: points.slice(0, BRIEF_INPUT_EXCERPT).join(""), truncated: true, length: points.length }
    : { text, truncated: false, length: points.length };
}

function messageDelivery(message: TaskMessage): BriefLatestInput["delivery"] {
  if (message.status === "delivered") return message.delivery === "steered" ? "steered" : "started";
  if (message.delivery_uncertain) return "uncertain";
  return "queued";
}

function latestMessage(taskId: string): RankedInput | null {
  const message = (db.query(
    `SELECT * FROM task_messages
     WHERE task_id = ? AND origin != 'workflow' AND source_seq IS NOT NULL
       AND NOT (status = 'cancelled' AND delivery_uncertain = 0)
     ORDER BY source_seq DESC LIMIT 1`,
  ).get(taskId) as TaskMessage | null) ?? null;
  if (!message) return null;
  return {
    seq: message.source_seq ?? 0,
    input: {
      kind: "message",
      id: message.id,
      ...excerpt(message.text),
      question: null,
      delivery: messageDelivery(message),
      turnN: message.turn_n,
      at: message.created_at,
      legacy: message.origin === "legacy",
    },
  };
}

function latestAnswer(taskId: string): RankedInput | null {
  const row = (db.query(
    `SELECT * FROM task_answer_observations WHERE task_id = ? AND state != 'failed' ORDER BY source_seq DESC LIMIT 1`,
  ).get(taskId) as AnswerObservationRow | null) ?? null;
  if (!row) return null;
  const answers = JSON.parse(row.answers_json) as { answer: string }[];
  return {
    seq: row.source_seq,
    input: {
      kind: "answer",
      id: row.id,
      ...excerpt(answers.map((a) => a.answer).join("\n")),
      question: row.question_text,
      delivery: row.state === "delivered" ? "delivered" : row.state === "pending" ? "pending" : "uncertain",
      turnN: row.turn_n,
      at: row.created_at,
      legacy: false,
    },
  };
}

function taskPrompt(taskId: string): RankedInput | null {
  const turn = db.query(`SELECT prompt, started_at FROM turns WHERE task_id = ? AND n = 1`).get(taskId) as
    | { prompt: string; started_at: string }
    | null;
  if (!turn) return null;
  return {
    seq: 0,
    input: { kind: "task-prompt", id: null, ...excerpt(turn.prompt), question: null, delivery: "started", turnN: 1, at: turn.started_at, legacy: false },
  };
}

/** The person's most recent input, by admission order. */
export function latestHumanInput(taskId: string): RankedInput | null {
  const candidates = [latestMessage(taskId), latestAnswer(taskId)].filter((c): c is RankedInput => c !== null);
  if (candidates.length === 0) return taskPrompt(taskId);
  return candidates.reduce((best, next) => (next.seq > best.seq ? next : best));
}

function uncertain(input: BriefLatestInput | undefined): boolean {
  return input?.delivery === "uncertain" || input?.delivery === "pending";
}

/** Taken inside the publication transaction, so it agrees with the write it describes. */
export function inputSnapshot(task: Task): InputSnapshot {
  const latest = latestHumanInput(task.id);
  const pending = db.query(
    `SELECT 1 FROM task_messages WHERE task_id = ? AND origin != 'workflow' AND status = 'queued' LIMIT 1`,
  ).get(task.id) !== null;
  return {
    inputRev: task.input_rev ?? 0,
    latestSeq: latest?.seq ?? 0,
    latestKind: latest?.input.kind ?? null,
    latestId: latest?.input.id ?? null,
    pending,
    uncertain: uncertain(latest?.input),
  };
}

/** Parse a stored snapshot; reports saved before provenance existed have none. */
export function parseInputSnapshot(sourceJson: string): InputSnapshot | null {
  const source = JSON.parse(sourceJson) as { input?: InputSnapshot };
  return source.input ?? null;
}

/** Whether the latest input is newer than, or changed since, what a report saw. */
export function inputFreshness(task: Task, latest: RankedInput | null, snapshot: InputSnapshot | null): {
  newer: boolean;
  changed: boolean;
  uncertain: boolean;
  legacy: boolean;
} {
  const newer = snapshot !== null && latest !== null && latest.seq > snapshot.latestSeq;
  return {
    newer,
    changed: snapshot !== null && !newer && (task.input_rev ?? 0) > snapshot.inputRev,
    uncertain: uncertain(latest?.input),
    legacy: latest?.input.legacy === true,
  };
}

/**
 * Record an answer about to be written into a live turn — only while the
 * task's briefs are on, and always before the native write, so the order of
 * events on disk is the order they happened. Returns the observation id to
 * settle, or null when nothing was recorded.
 */
export function observeAnswer(
  taskId: string,
  turnId: number,
  questionId: string,
  questions: { index: number; question: string }[],
  answers: { index: number; answer: string }[],
): string | null {
  return db.transaction((): string | null => {
    const task = getTask(taskId);
    const turn = getTurn(turnId);
    if (!task || task.brief_enabled !== 1 || !turn) return null;
    const byIndex = new Map(answers.map((a) => [a.index, a.answer.trim()]));
    const paired = questions.map((q) => ({ index: q.index, question: q.question, answer: byIndex.get(q.index) ?? "" }));
    const questionText = [...questions.map((q) => q.question).join("\n")].slice(0, QUESTION_TEXT_MAX).join("");
    const id = `qa_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const at = new Date().toISOString();
    const seq = admitTaskInput(taskId, true);
    db.run(
      `INSERT INTO task_answer_observations
         (id, task_id, turn_id, turn_n, context_n, source_seq, question_id, question_text, answers_json, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      [id, taskId, turn.id, turn.n, turn.context_n, seq, questionId, questionText, JSON.stringify(paired), at, at],
    );
    return id;
  })();
}

/** The native write finished: it was delivered, or it certainly was not. */
export function settleAnswerObservation(id: string, state: "delivered" | "failed"): void {
  db.run(
    `UPDATE task_answer_observations SET state = ?, updated_at = ? WHERE id = ? AND state = 'pending'`,
    [state, new Date().toISOString(), id],
  );
  db.run(`UPDATE tasks SET input_rev = input_rev + 1 WHERE id = (SELECT task_id FROM task_answer_observations WHERE id = ?)`, [id]);
}

/** After a crash, an answer caught between record and write may or may not have arrived. */
export function markPendingAnswersUncertain(): void {
  db.run(`UPDATE task_answer_observations SET state = 'uncertain', updated_at = ? WHERE state = 'pending'`, [new Date().toISOString()]);
}
