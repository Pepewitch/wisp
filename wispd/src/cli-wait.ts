import { api } from "./cli-api";
import type { Flags } from "./cli-args";
import { print, printError } from "./cli-print";
import { wispCommand } from "./command";
import { backgroundSummary, type ApiTask, type TaskState } from "./types";

const COMMAND = wispCommand();

export const WAIT_USAGE = `usage: ${COMMAND} wait <task>… [--any|--all] [--settled] [--timeout <sec>]`;

/**
 * `wisp wait` exit codes, one per settled state. 'creating'/'running' are
 * in-flight and 'stuck' is reversible (the harness may still be alive and
 * simply quiet), so none of them end the wait — only these three do.
 *
 * `needs-input` now covers two situations, and 2 is right for both: a turn
 * that ENDED asking for something, and a turn SUSPENDED inside a questionnaire
 * the harness is blocked on. The wait's promise is "block until the task is
 * finished or wants you", and a blocked harness wants you as much as a
 * finished one does. A `wisp send` after either resumes the task correctly —
 * the suspended case steers, which answers the open questionnaire on the way
 * through (see adapters/live/droid.ts).
 */
const WAIT_EXIT: Partial<Record<TaskState, number>> = { done: 0, failed: 1, "needs-input": 2 };
const WAIT_POLL_MS = 2000;
/** ~a day: long enough to be "block until it settles", finite so a wedged wait still exits 3. */
const WAIT_DEFAULT_TIMEOUT_SEC = 86_400;

export type WaitMode = "one" | "any" | "all";

type WaitTask = Pick<ApiTask, "id" | "state" | "state_detail" | "background">;

/**
 * Background work the task's own agent will wake for: a lingering Claude or
 * Droid process Wisp keeps alive on purpose (a Monitor, a `fireAndForget`
 * command, a background subagent). Such a group carries `tasks`, even once
 * the list empties: Claude clears it before its follow-up turn opens, and that
 * gap must not end the wait. The group is reported at once (no settle window
 * to slip through) and holds even while it reads `unknown` (one failed process
 * snapshot marks every group so). A process a finished harness merely left
 * behind, such as a dev server, has no `tasks`, no agent to wake, and never
 * holds the wait. A kept harness with nothing left closes itself within
 * seconds.
 */
function agentWillWake(task: WaitTask): boolean {
  const background = task.background;
  return background !== undefined && background.state !== "none" && background.details.some(group => group.tasks !== undefined);
}

/**
 * The exit code if this task ends the wait now, else undefined. A `done` task
 * whose harness is kept alive for its background work is done for now: the
 * agent wakes and answers again when that work finishes, which `--settled`
 * waits for.
 */
export function settledCode(task: WaitTask, settled: boolean): number | undefined {
  const code = WAIT_EXIT[task.state];
  if (code === 0 && settled && agentWillWake(task)) return undefined;
  return code;
}

export function waitLine(task: WaitTask): string {
  return `${task.id}  ${task.state}${backgroundSummary(task as ApiTask)}${task.state_detail ? ` — ${task.state_detail}` : ""}`;
}

export interface WaitOutcome {
  code: number;
  /** The tasks to print, in the order given. */
  report: WaitTask[];
}

/**
 * Whether the wait ends with this snapshot (tasks in the order given), and how.
 * `any` ends on the first task that settles, `all` once every one has, with the
 * most serious code: failed over needs-input over done.
 */
export function waitOutcome(tasks: WaitTask[], mode: WaitMode, settled: boolean): WaitOutcome | null {
  const codes = tasks.map(task => settledCode(task, settled));
  if (mode === "all") {
    if (codes.some(code => code === undefined)) return null;
    const code = codes.includes(1) ? 1 : codes.includes(2) ? 2 : 0;
    return { code, report: tasks };
  }
  const first = codes.findIndex(code => code !== undefined);
  return first === -1 ? null : { code: codes[first]!, report: [tasks[first]!] };
}

/** A note for a `done` task whose agent will answer again. */
export function backgroundNote(task: WaitTask, settled: boolean): string | null {
  if (settled || task.state !== "done" || !agentWillWake(task)) return null;
  return `${task.id} still has background work its agent will answer again for (${COMMAND} wait ${task.id} --settled waits for that)`;
}

/** What a timed-out wait prints: every task under --all, else the ones it was waiting on. */
export function timeoutLines(tasks: WaitTask[], mode: WaitMode, settled: boolean, timeoutSec: number): string[] {
  const shown = mode === "all" ? tasks : tasks.filter(task => settledCode(task, settled) === undefined);
  return shown.map(task => `${waitLine(task)}${settledCode(task, settled) === undefined ? `  (timeout after ${timeoutSec}s)` : ""}`);
}

export function parseWait(positional: string[], flags: Flags): { ids: string[]; mode: WaitMode; settled: boolean; timeoutSec: number } | string {
  const ids = [...new Set(positional)];
  if (ids.length === 0) return WAIT_USAGE;
  if (flags.any && flags.all) return "--any and --all cannot be combined";
  const rawTimeout = flags.timeout;
  const timeoutSec = rawTimeout === undefined ? WAIT_DEFAULT_TIMEOUT_SEC : Number(rawTimeout);
  if ((typeof rawTimeout !== "string" && rawTimeout !== undefined) || !Number.isFinite(timeoutSec) || timeoutSec <= 0) {
    return `--timeout must be a positive number of seconds (got: ${String(rawTimeout)})`;
  }
  const mode: WaitMode = flags.any ? "any" : ids.length > 1 || flags.all ? "all" : "one";
  return { ids, mode, settled: flags.settled === true, timeoutSec };
}

export async function waitCommand(positional: string[], flags: Flags): Promise<void> {
  const parsed = parseWait(positional, flags);
  if (typeof parsed === "string") {
    printError(parsed);
    process.exit(1);
  }
  const { ids, mode, settled, timeoutSec } = parsed;
  const deadline = Date.now() + timeoutSec * 1000;
  for (;;) {
    const tasks: WaitTask[] = [];
    for (const id of ids) tasks.push((await api(`/api/tasks/${id}`)) as ApiTask);
    const outcome = waitOutcome(tasks, mode, settled);
    if (outcome) {
      for (const task of outcome.report) print(waitLine(task));
      for (const task of outcome.report) {
        const note = backgroundNote(task, settled);
        if (note) printError(note);
      }
      process.exit(outcome.code);
    }
    if (Date.now() >= deadline) {
      for (const line of timeoutLines(tasks, mode, settled, timeoutSec)) print(line);
      process.exit(3);
    }
    await Bun.sleep(Math.min(WAIT_POLL_MS, Math.max(0, deadline - Date.now())));
  }
}
