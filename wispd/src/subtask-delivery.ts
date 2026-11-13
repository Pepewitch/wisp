/**
 * Delivering what subtasks reported (subtask-reports.ts) to their parent.
 *
 * Rows go pending → queued → delivered. A pass for one parent:
 *  1. drops what can no longer reach it (archived, being deleted, gone);
 *  2. waits while it is busy, needs the person, is held after a Stop, or
 *     the daemon has no free slot: a report never interrupts its parent.
 *     A busy parent's reports are queued meanwhile, unstarted, so they hold
 *     their place in line: its next turn end starts them before anything
 *     sent after them (runner.ts, subtask-report-queue.ts reportBefore), and
 *     a parent that is always sent something cannot starve them (#499).
 *     A report queued longer than REPORT_STEER_AFTER_MS behind a turn that
 *     is still running is steered into it, as a person's message would be,
 *     where the parent's harness takes live input: a turn that never ends
 *     would otherwise keep its reports waiting without bound;
 *  3. starts the report message already queued for it, by id, or else turns
 *     every pending row into ONE message (reports close together arrive
 *     together) and starts that. While other children are still working,
 *     routine reports first wait for them, up to REPORT_IDLE_HOLD_MS, so a
 *     fan-out's results cost the parent one turn rather than one each.
 * "Delivered" is set by a trigger when the message starts or steers a turn, so a crash
 * anywhere leaves the rows where a later pass picks them up. Passes run a
 * short debounce after anything about the parent or a child changes, at
 * startup, and on a backstop interval.
 */
import type { AdapterDef } from "./adapters";
import { canTakeReport } from "./autopilot/idle";
import type { WispConfig } from "./config";
import { subscribe } from "./events";
import { homeIsDraining } from "./home-lifetime";
import { startNextQueuedMessage } from "./runner";
import { db, getTask, getTaskMessage, runningTurn } from "./store";
import { hasTaskCapacity } from "./task-admission";
import { deliverToRunningTurn } from "./task-submit";
import type { Task } from "./types";
import { heldAfterStop, queuedReport, queueReports, refreshReportText } from "./subtask-report-queue";
import { reportFraming } from "./subtask-reports";

/** How long a queued report waits behind a parent's running turn before it steers into that turn. */
export const REPORT_STEER_AFTER_MS = 5 * 60_000;

/** Reports arriving this close together are combined into one message. */
export const REPORT_DEBOUNCE_MS = 3_000;
const BACKSTOP_MS = 30_000;

/**
 * How long a routine report waits for its siblings while the parent is idle.
 *
 * Every report an idle parent takes starts a whole turn, and a turn re-reads
 * the parent's entire conversation: an orchestrating task fanning out to many
 * subtasks paid that once per finished child (in one measured home, 458
 * reports started 421 parent turns, each re-reading ~355k tokens). While
 * other children that report to the same parent are still working, a routine
 * report waits up to this long, counted from the oldest one waiting, so
 * results finishing minutes apart arrive as one message and one turn. The
 * last working sibling settling releases the wait at once, and so does any
 * report that asks the parent to act (urgentReport).
 */
export const REPORT_IDLE_HOLD_MS = 2 * 60_000;

/** Reports that ask the parent to act now: never held for siblings, and they carry any held report with them. */
const URGENT_REPORT_KINDS = new Set(["question", "needs-you", "stuck", "setup-failed"]);

/**
 * Whether a pending report asks the parent to act. A `turn` report is routine
 * only when the child's turn ended done: one that failed or ended needing
 * input leaves the child blocked on its parent, as a question does. The
 * outcome is in the facts recordTurnReport wrote (subtask-reports.ts).
 */
function urgentReport(row: { kind: string; outcome: string | null }): boolean {
  return URGENT_REPORT_KINDS.has(row.kind) || (row.kind === "turn" && row.outcome !== "done");
}

/**
 * When a parent's pending reports may go, if they should wait for working
 * siblings first (REPORT_IDLE_HOLD_MS); null when they may go now. A child
 * counts as working while it is creating, queued or running and reports to
 * this parent; a stuck or needs-input child has already reported why, and
 * that report goes at once.
 */
export function siblingHoldUntil(parentId: string, holdMs: number, now = Date.now()): number | null {
  if (holdMs <= 0) return null;
  const pending = db.query(`SELECT kind, created_at, CASE WHEN json_valid(facts_json) THEN json_extract(facts_json, '$.outcome') END AS outcome
    FROM subtask_reports WHERE parent_task_id = ? AND state = 'pending'`)
    .all(parentId) as { kind: string; created_at: string; outcome: string | null }[];
  if (pending.length === 0 || pending.some(urgentReport)) return null;
  const working = db.query(`SELECT 1 FROM tasks WHERE parent_task_id = ? AND report_to_parent = 1 AND archived = 0
    AND state IN ('creating', 'queued', 'running') LIMIT 1`).get(parentId);
  if (!working) return null;
  const until = Math.min(...pending.map((row) => Date.parse(row.created_at))) + holdMs;
  return Number.isFinite(until) && until > now ? until : null;
}

function dropPending(parentId: string, reason: string): void {
  db.run("UPDATE subtask_reports SET state = 'dropped', reason = ?, updated_at = ? WHERE parent_task_id = ? AND state = 'pending'",
    [reason, new Date().toISOString(), parentId]);
}

export class SubtaskDelivery {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** One wake per parent for the moment its sibling hold ends; the backstop alone would add up to 30 s. */
  private readonly holds = new Map<string, ReturnType<typeof setTimeout>>();
  private unsubscribe: (() => void) | null = null;
  private backstop: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly cfg: WispConfig,
    private readonly adapters: Readonly<Record<string, AdapterDef>>,
    private readonly debounceMs = REPORT_DEBOUNCE_MS,
    private readonly idleHoldMs = REPORT_IDLE_HOLD_MS,
  ) {}

  start(): void {
    // anything about a task can make its parent's reports deliverable: a child settling, the parent going idle
    this.unsubscribe = subscribe((event) => {
      if (event.type === "task" || event.type === "message") for (const parent of this.parentsTouching(event.taskId)) this.kick(parent);
    });
    this.backstop = setInterval(() => this.passAll(), BACKSTOP_MS);
    this.passAll();
  }

  async stop(): Promise<void> {
    this.unsubscribe?.();
    if (this.backstop) clearInterval(this.backstop);
    for (const timer of [...this.timers.values(), ...this.holds.values()]) clearTimeout(timer);
    this.timers.clear();
    this.holds.clear();
  }

  /** A pass for this parent when its sibling hold ends; an earlier pass meanwhile may already have delivered. */
  private wakeAt(parentId: string, at: number): void {
    if (this.holds.has(parentId)) return;
    this.holds.set(parentId, setTimeout(() => {
      this.holds.delete(parentId);
      this.deliver(parentId);
    }, Math.max(0, at - Date.now()) + 50));
  }

  /** A pass for this parent after the debounce; a second kick meanwhile does not move it. */
  kick(parentId: string): void {
    if (this.timers.has(parentId)) return;
    this.timers.set(parentId, setTimeout(() => {
      this.timers.delete(parentId);
      this.deliver(parentId);
    }, this.debounceMs));
  }

  /** Every parent with something undelivered, now. */
  passAll(): void {
    const parents = db.query("SELECT DISTINCT parent_task_id AS id FROM subtask_reports WHERE state IN ('pending', 'queued')").all() as { id: string }[];
    for (const { id } of parents) this.deliver(id);
  }

  /** One pass for one parent (the module comment's three steps). */
  deliver(parentId: string): void {
    if (homeIsDraining()) return;
    try {
      const parent = getTask(parentId);
      if (!parent) return dropPending(parentId, "parent deleted");
      if (parent.archived) return dropPending(parentId, "parent archived");
      if (parent.purge_pending) return dropPending(parentId, "parent being deleted");
      if (!canTakeReport(parent) || heldAfterStop(parent.id) || !hasTaskCapacity(this.cfg, parent.id)) {
        // Busy with its own work: queue the reports now, unstarted, so they hold their place in
        // line and its next turn end starts them before anything sent later (runner.ts reportBefore).
        if (parent.state !== "needs-input" && !queuedReport(parent.id)) queueReports(parent);
        this.steerIfWaitedTooLong(parent);
        return;
      }
      const queued = queuedReport(parent.id);
      // A report already queued waited behind the parent's own work: it goes now. Otherwise
      // routine reports wait a little for siblings still working, to arrive as one turn.
      const holdUntil = queued ? null : siblingHoldUntil(parent.id, this.idleHoldMs);
      if (holdUntil !== null) return this.wakeAt(parent.id, holdUntil);
      const id = queued ?? queueReports(parent);
      if (id) startNextQueuedMessage(parent.id, this.adapters, this.cfg, id);
    } catch (error) {
      console.error(`[wisp] subtask reports for ${parentId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * The queued report has waited REPORT_STEER_AFTER_MS behind a turn still
   * running, counted from the later of its queueing and that turn's start:
   * it goes into that turn now, the way a person's message steers. Never past
   * a Stop hold, never again after a steer that may have reached the harness
   * (a person's message is not resent by itself either), and only where the
   * turn takes live input (the steer path refuses otherwise, and the report
   * keeps waiting for the end).
   */
  private steerIfWaitedTooLong(parent: Task): void {
    const running = runningTurn(parent.id);
    if (parent.state !== "running" || !running || heldAfterStop(parent.id)) return;
    const id = queuedReport(parent.id);
    const queued = id ? getTaskMessage(id) : null;
    if (!queued || queued.claim !== null || queued.delivery_uncertain === 1) return;
    const since = Math.max(Date.parse(queued.created_at), Date.parse(running.started_at));
    if (!(Date.now() - since >= REPORT_STEER_AFTER_MS)) return;
    // the transcript shows what the steer carries, as for a report that starts a turn (runner.ts)
    refreshReportText(queued.id, reportFraming(queued.id));
    const message = getTaskMessage(queued.id)!;
    void deliverToRunningTurn(parent, message).catch((error: unknown) => {
      console.error(`[wisp] steering subtask reports into ${parent.id}: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  private parentsTouching(taskId: string): string[] {
    return (db.query(`SELECT DISTINCT parent_task_id AS id FROM subtask_reports
      WHERE state IN ('pending', 'queued') AND (parent_task_id = ? OR child_task_id = ?)`).all(taskId, taskId) as { id: string }[]).map((row) => row.id);
  }
}
