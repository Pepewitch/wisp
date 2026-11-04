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
 *     together) and starts that.
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

function dropPending(parentId: string, reason: string): void {
  db.run("UPDATE subtask_reports SET state = 'dropped', reason = ?, updated_at = ? WHERE parent_task_id = ? AND state = 'pending'",
    [reason, new Date().toISOString(), parentId]);
}

export class SubtaskDelivery {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private unsubscribe: (() => void) | null = null;
  private backstop: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly cfg: WispConfig,
    private readonly adapters: Readonly<Record<string, AdapterDef>>,
    private readonly debounceMs = REPORT_DEBOUNCE_MS,
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
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
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
      const id = queuedReport(parent.id) ?? queueReports(parent);
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
