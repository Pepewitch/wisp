/**
 * Task briefs: the per-task switch, the binding each eligible turn is handed,
 * the atomic publication an agent makes through `wisp brief set`, and the read
 * model every client shows.
 *
 * The binding is the whole trust story, so it is worth stating plainly. A
 * turn that starts while the switch is on gets an opaque run id in its
 * environment (`WISP_BRIEF_RUN`) and a row here naming that exact task, turn,
 * context and generation. A publication is accepted only while all of these
 * still hold: the row exists for this task and daemon instance, the switch is
 * on at the SAME generation, the task is not archived, and the bound turn is
 * still running. Nothing is revoked by hand — each condition is re-read inside
 * the write's transaction, so a disable, an archive, a turn ending or a daemon
 * restart all take effect without a revocation path that could be forgotten.
 *
 * What it does not do: it never falls back to "whatever turn is latest", and
 * it cannot tell a foreground agent from a child process that inherited its
 * environment. Run identity and revisions stop obsolete and conflicting
 * writes; they say nothing about whether the prose is true.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  canonicalBriefJson,
  validateTaskBrief,
  type BriefPublication,
  type BriefReason,
  type BriefSettings,
  type BriefTurnStatus,
  type BriefView,
  type TaskBriefCheck,
  type TaskBriefV1,
} from "../../shared/task-brief";
import type { AdapterDef } from "./adapters";
import { db, getTask, getTurn, runningTurn } from "./store";
import type { Task, Turn } from "./types";

export interface BriefRunRow {
  run_id: string;
  task_id: string;
  turn_id: number;
  turn_n: number;
  context_n: number;
  generation: number;
  instance_id: string;
  created_at: string;
}

interface TaskBriefRow {
  id: number;
  task_id: string;
  turn_id: number;
  turn_n: number;
  context_n: number;
  run_id: string;
  generation: number;
  schema_version: number;
  revision: number;
  payload_json: string;
  payload_hash: string;
  source_json: string;
  saved_at: string;
}

/** A binding chosen before the spawn and written with the turn row. */
export interface PendingBriefRun {
  runId: string;
  generation: number;
}

function enabled(task: Pick<Task, "brief_enabled">): boolean {
  return task.brief_enabled === 1;
}

function generationOf(task: Pick<Task, "brief_generation">): number {
  return task.brief_generation ?? 0;
}

/**
 * The binding for a turn about to start, or null when it is not eligible.
 * Eligible means: the switch is on, the harness declares `briefs`, and the
 * prompt is not a native command (a harness only treats input as a command
 * when it STARTS with `/`, so nothing may be put in front of it).
 *
 * Reads the task row fresh: the caller may hold a synthetic task built for a
 * queued message, or one captured before a worktree setup it waited on.
 */
export function pendingBriefRun(taskId: string, def: AdapterDef, command: boolean): PendingBriefRun | null {
  if (command || def.briefs !== true) return null;
  const task = getTask(taskId);
  if (!task || task.archived || !enabled(task)) return null;
  return { runId: `br_${randomUUID().replaceAll("-", "")}`, generation: generationOf(task) };
}

/** Write the binding. Call inside the transaction that creates the turn row. */
export function recordBriefRun(
  run: PendingBriefRun,
  turn: { taskId: string; turnId: number; n: number; contextN: number },
  instanceId: string,
): void {
  db.run(
    `INSERT INTO brief_runs (run_id, task_id, turn_id, turn_n, context_n, generation, instance_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [run.runId, turn.taskId, turn.turnId, turn.n, turn.contextN, run.generation, instanceId, new Date().toISOString()],
  );
}

function runForTurn(turnId: number): BriefRunRow | null {
  return (db.query(`SELECT * FROM brief_runs WHERE turn_id = ?`).get(turnId) as BriefRunRow | null) ?? null;
}

function activation(task: Task): { activation: BriefView["activation"]; turnRunning: boolean } {
  const running = runningTurn(task.id);
  if (!enabled(task)) return { activation: "off", turnRunning: running !== null };
  const run = running ? runForTurn(running.id) : null;
  return {
    activation: run !== null && run.generation === generationOf(task) ? "active" : "next-turn",
    turnRunning: running !== null,
  };
}

export function briefSettings(task: Task): BriefSettings {
  return { enabled: enabled(task), generation: generationOf(task), ...activation(task) };
}

/**
 * Switch briefs on or off. Idempotent: repeating the current value changes
 * nothing. Every off→on advances the generation, which is what keeps a
 * binding handed out before a disable dead after the re-enable. Enabling
 * never starts, steers or interrupts anything — the next eligible turn is the
 * first to be asked.
 */
export function setBriefEnabled(taskId: string, on: boolean): BriefSettings | null {
  return db.transaction((): BriefSettings | null => {
    const task = getTask(taskId);
    if (!task) return null;
    if (on && !enabled(task)) {
      db.run(`UPDATE tasks SET brief_enabled = 1, brief_generation = brief_generation + 1 WHERE id = ?`, [taskId]);
    } else if (!on && enabled(task)) {
      db.run(`UPDATE tasks SET brief_enabled = 0 WHERE id = ?`, [taskId]);
    }
    return briefSettings(getTask(taskId)!);
  })();
}

export type PublishResult =
  | BriefPublication
  | { kind: "conflict" }
  | { kind: "forbidden"; message: string }
  | { kind: "invalid"; check: Extract<TaskBriefCheck, { ok: false }> };

/**
 * One publication, decided and written in ONE transaction: bun:sqlite is
 * synchronous, so no other request can interleave between the checks and the
 * write, and a disable committed first always wins over a write that arrives
 * after it.
 *
 * Revisions: a first report for the run sends 0 and becomes 1. The same
 * content again is `unchanged` and keeps its original snapshot and time — a
 * retry must not make an old report look newer. Different content must name
 * the stored revision; anything else is a conflict, so two replacements from
 * the same base can never both succeed.
 */
export function publishBrief(
  taskId: string,
  runId: string,
  expectedRevision: number,
  payload: unknown,
  instanceId: string,
): PublishResult {
  return db.transaction((): PublishResult => {
    const task = getTask(taskId);
    const run = (db.query(`SELECT * FROM brief_runs WHERE run_id = ?`).get(runId) as BriefRunRow | null) ?? null;
    if (!task || !run || run.task_id !== taskId || run.instance_id !== instanceId) {
      return { kind: "forbidden", message: "this brief binding does not belong to this task on this Wisp daemon" };
    }
    if (task.archived) return { kind: "skipped", reason: "archived" };
    if (!enabled(task) || run.generation !== generationOf(task)) return { kind: "skipped", reason: "disabled" };
    const turn = getTurn(run.turn_id);
    if (!turn || turn.status !== "running") return { kind: "skipped", reason: "run-ended" };
    const check = validateTaskBrief(payload);
    if (!check.ok) return { kind: "invalid", check };
    const canonical = canonicalBriefJson(check.brief);
    const hash = createHash("sha256").update(canonical).digest("hex");
    const existing = (db.query(`SELECT * FROM task_briefs WHERE turn_id = ?`).get(turn.id) as TaskBriefRow | null) ?? null;
    const savedAt = new Date().toISOString();
    const source = JSON.stringify({ turnN: turn.n, contextN: turn.context_n, taskContextN: task.context_n, taskTurnCount: task.turn_count });
    if (!existing) {
      if (expectedRevision !== 0) return { kind: "conflict" };
      db.run(
        `INSERT INTO task_briefs
           (task_id, turn_id, turn_n, context_n, run_id, generation, schema_version, revision, payload_json, payload_hash, source_json, saved_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?, ?)`,
        [taskId, turn.id, turn.n, turn.context_n, run.run_id, run.generation, canonical, hash, source, savedAt],
      );
      return { kind: "saved", revision: 1 };
    }
    if (existing.payload_hash === hash) return { kind: "unchanged", revision: existing.revision };
    if (expectedRevision !== existing.revision) return { kind: "conflict" };
    const revision = existing.revision + 1;
    db.run(
      `UPDATE task_briefs SET revision = ?, payload_json = ?, payload_hash = ?, source_json = ?, saved_at = ? WHERE id = ?`,
      [revision, canonical, hash, source, savedAt, existing.id],
    );
    return { kind: "saved", revision };
  })();
}

function status(turn: Turn): BriefTurnStatus {
  return turn.status as BriefTurnStatus;
}

interface ReadFacts {
  task: Task;
  on: boolean;
  supported: boolean;
  state: BriefView["activation"];
  turnRunning: boolean;
  reportRow: TaskBriefRow | null;
  reportTurn: Turn | null;
  latestRunTurn: Turn | null;
  latestEligibleReported: boolean;
  latestTurn: Turn | null;
}

function latest<T>(sql: string, taskId: string): T | null {
  return (db.query(sql).get(taskId) as T | null) ?? null;
}

function readFacts(task: Task, adapters: Readonly<Record<string, AdapterDef>>): ReadFacts {
  const reportRow = latest<TaskBriefRow>(`SELECT * FROM task_briefs WHERE task_id = ? ORDER BY turn_n DESC LIMIT 1`, task.id);
  const latestRun = latest<BriefRunRow>(`SELECT * FROM brief_runs WHERE task_id = ? ORDER BY turn_n DESC LIMIT 1`, task.id);
  const latestRunTurn = latestRun ? getTurn(latestRun.turn_id) : null;
  const { activation: state, turnRunning } = activation(task);
  return {
    task,
    on: enabled(task),
    supported: adapters[task.harness]?.briefs === true,
    state,
    turnRunning,
    reportRow,
    reportTurn: reportRow ? getTurn(reportRow.turn_id) : null,
    latestRunTurn,
    latestEligibleReported: latestRunTurn
      ? Boolean(db.query(`SELECT 1 FROM task_briefs WHERE turn_id = ?`).get(latestRunTurn.id))
      : false,
    latestTurn: latest<Turn>(`SELECT * FROM turns WHERE task_id = ? ORDER BY n DESC LIMIT 1`, task.id),
  };
}

/** Every condition that holds at once; a client chooses its one line from these. */
function briefReasons(f: ReadFacts): BriefReason[] {
  const reasons: BriefReason[] = [];
  if (!f.on) reasons.push("disabled");
  if (!f.supported) reasons.push("unsupported");
  if (f.on && f.state === "next-turn" && f.turnRunning) reasons.push("awaiting-next-turn");
  if (f.on && (!f.reportRow || (f.latestRunTurn !== null && !f.latestEligibleReported))) reasons.push("no-report");
  const turn = f.reportTurn;
  if (!f.reportRow || !turn) return reasons;
  if (turn.status === "running") reasons.push("provisional");
  if (turn.status === "failed") reasons.push("source-failed");
  if (turn.status === "interrupted") reasons.push("source-interrupted");
  if (f.latestTurn && f.latestTurn.n > turn.n) reasons.push("newer-turn");
  const later = f.latestRunTurn;
  if (later && later.n > turn.n && later.status !== "running" && !f.latestEligibleReported) reasons.push("newer-turn-unreported");
  if (f.task.context_n !== f.reportRow.context_n) reasons.push("newer-context");
  return reasons;
}

/**
 * The read model. Pure reading: nothing here generates, schedules or writes.
 * The latest report is chosen by source-turn order, never by arrival, and its
 * turn's CURRENT status is joined in — a report saved mid-turn reads as a
 * failed turn's report if that is how the turn ended.
 */
export function briefView(task: Task, adapters: Readonly<Record<string, AdapterDef>>): BriefView {
  const f = readFacts(task, adapters);
  const { reportRow, reportTurn, latestRunTurn, latestTurn } = f;
  return {
    enabled: f.on,
    generation: generationOf(task),
    archived: task.archived !== 0,
    harness: task.harness,
    supported: f.supported,
    activation: f.state,
    report: reportRow && reportTurn
      ? {
        turn: { n: reportTurn.n, status: status(reportTurn), contextN: reportRow.context_n, endedAt: reportTurn.ended_at ?? null },
        revision: reportRow.revision,
        savedAt: reportRow.saved_at,
        brief: JSON.parse(reportRow.payload_json) as TaskBriefV1,
      }
      : null,
    latestEligibleTurn: latestRunTurn
      ? { n: latestRunTurn.n, status: status(latestRunTurn), reported: f.latestEligibleReported }
      : null,
    latestTurn: latestTurn ? { n: latestTurn.n, status: status(latestTurn), contextN: latestTurn.context_n } : null,
    reasons: briefReasons(f),
  };
}

/** Every stored report for a task, oldest first — for the portable export. */
export function taskBriefsForExport(taskId: string): unknown[] {
  return (db.query(`SELECT * FROM task_briefs WHERE task_id = ? ORDER BY turn_n`).all(taskId) as TaskBriefRow[]).map((row) => ({
    turn: row.turn_n,
    context: row.context_n,
    revision: row.revision,
    savedAt: row.saved_at,
    brief: JSON.parse(row.payload_json) as unknown,
  }));
}
