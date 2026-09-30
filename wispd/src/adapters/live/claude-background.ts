import type { HarnessBackgroundTask } from "../../types";

/**
 * Claude's stream-json knowledge for a live process whose background work can
 * outlive a turn: which records start a model call, what a task notification
 * says, and whether a result ends the turn (see ClaudeLiveProcess in
 * live-input.ts, which acts on the verdicts).
 */

/** A record only a model call writes; the first one while no turn is open means one began. */
export function startsModelCall(event: Record<string, unknown>): boolean {
  return isSystem(event, "init") || event.type === "assistant" || event.type === "result" || event.type === "stream_event";
}

export function isSystem(event: Record<string, unknown>, subtype: string): boolean {
  return event.type === "system" && event.subtype === subtype;
}

/** A task notification in a few words: the CLI's own summary, else its description and status. */
export function noticeText(event: Record<string, unknown>): string {
  const summary = typeof event.summary === "string" ? event.summary.trim() : "";
  const text = summary || [event.description, event.status].filter((part) => typeof part === "string").join(" ");
  return (text || "a background task changed").replace(/\s+/g, " ").slice(0, 200);
}

export type TurnKind = "spawned" | "adopted" | "follow-up";
export type TurnVerdict = "continue" | "close" | "linger" | "wait";

/**
 * Tracks what the Claude process still has running in the background, and
 * whether a result ends the current turn.
 *
 * Claude can emit a successful result while a background task it started — a
 * `run_in_background` Bash command, or a Monitor, which registers as a
 * backgrounded local_bash task — is still active. Closing stdin then makes the
 * CLI tear the task down, so such a result LINGERS the turn instead: it
 * settles, and the process stays (see ClaudeLiveProcess). Each notification
 * the task delivers later wakes its own model call, with its own result and no
 * new user input, which becomes a follow-up turn.
 *
 * Captured from claude-code against a real Monitor:
 *
 *   background_tasks_changed [mon] / task_started is_backgrounded=true
 *   result "tick 1"              <- one result per event, task still active
 *   system/init                  <- the CLI starting the next input cycle
 *   result "tick 2"
 *   background_tasks_changed []  + task_notification status=completed
 *   system/init                  <- the follow-up cycle the completion woke
 *   result "done"                <- only now is nothing left in the background
 *
 * `system/init` is the discriminator. A result arriving after the completion
 * but before any new init belongs to the call that was already running when the
 * completion landed, so closing on it drops the follow-up. A foreground tool
 * result after the completion means that in-flight call consumed it instead and
 * no separate cycle will start. The result count bounds the wait, so an
 * unfamiliar stream cannot hold a turn open forever.
 *
 * A resumed session can also answer a notification BEFORE the prompt. When the
 * previous process exited with background work still running, the CLI replays
 * those `stopped` notifications first and emits a result for them, marked
 * `origin.kind: "task-notification"`, ahead of the prompt's own cycle:
 *
 *   task_notification status=stopped   <- tasks of the previous process
 *   system/init
 *   result "" num_turns=0 origin=task-notification
 *   system/init                        <- the prompt's cycle
 *   result "…"                         <- the prompt's answer, no origin
 *
 * Nothing is active yet at that first result, so closing on it shut stdin
 * before the prompt ran. The CLI then treated the turn as a print-mode run,
 * gave the background agents the prompt started a 600 s grace, and killed them.
 * Until the prompt's own result has arrived, a notification's result that made
 * no model call is not it. A CLI that sends no `origin` or `num_turns` makes its
 * first result the answer, as before.
 *
 * Settling early adds one question closing never had to ask: is there input
 * the CLI has not answered yet? Closing is safe either way, because the CLI
 * answers what it already read before it exits. Settling is not: a message
 * written during the call can be folded into it (at a tool boundary) or get a
 * call of its own right after it, and the stream does not say which (both
 * captured from claude-code 2.1.283). So a result that would linger while more
 * messages were written than calls have started WAITS a moment: a call of its
 * own starts at once (`system/init`) and stays in this turn, and without one
 * the CLI folded it. The same holds for a prompt written to a lingering process while a
 * notification's call was already running: that call's result is not the
 * prompt's answer, unless no other call follows it (the CLI folded the two).
 */
export function createBackgroundFollowUp(now: () => string = () => new Date().toISOString()): {
  observe(event: Record<string, unknown>, turn: number): void;
  beginTurn(kind: TurnKind): void;
  noteInput(): void;
  inputAnswered(): void;
  closesTurn(result: Record<string, unknown>): TurnVerdict;
  activeCount(): number;
  tasks(): HarnessBackgroundTask[];
} {
  const active = new Map<string, HarnessBackgroundTask>();
  let answered = false;
  let pending = false;
  let followUpStarted = false;
  let consumed = false;
  let resultsSince = 0;
  // Messages written that no call has started for yet: each call begins with
  // one `system/init` and takes at least one of them, or folds in several.
  let unstarted = 0;
  let promptOutstanding = false;
  const note = (): void => {
    pending = true;
    followUpStarted = false;
    consumed = false;
    resultsSince = 0;
  };
  const describe = (id: string, fields: Record<string, unknown>, turn: number): HarnessBackgroundTask => {
    const known = active.get(id);
    const name = typeof fields.description === "string" && fields.description.trim() ? fields.description.trim().slice(0, 120) : null;
    const kind = typeof fields.task_type === "string" ? fields.task_type : null;
    return { name: name ?? known?.name ?? "background task", kind: kind ?? known?.kind ?? null, turn: known?.turn ?? turn, since: known?.since ?? now() };
  };
  return {
    observe(event: Record<string, unknown>, turn: number): void {
      if (isSystem(event, "background_tasks_changed") && Array.isArray(event.tasks)) {
        const next = new Map<string, HarnessBackgroundTask>();
        for (const task of event.tasks) {
          const fields = (task ?? {}) as Record<string, unknown>;
          if (typeof fields.task_id === "string") next.set(fields.task_id, describe(fields.task_id, fields, turn));
        }
        let finished = false;
        for (const id of active.keys()) if (!next.has(id)) finished = true;
        active.clear();
        for (const [id, task] of next) active.set(id, task);
        if (finished) note();
      } else if (isSystem(event, "task_started") && event.is_backgrounded === true && typeof event.task_id === "string") {
        active.set(event.task_id, describe(event.task_id, event, turn));
      } else if (
        isSystem(event, "task_notification") &&
        typeof event.task_id === "string" &&
        ["completed", "failed", "stopped"].includes(String(event.status))
      ) {
        // Only a task Claude actually backgrounded owes a follow-up cycle. A
        // foreground subagent reports the same event and must not hold the
        // turn open waiting for a call that will never start.
        if (active.delete(event.task_id)) note();
      } else if (isSystem(event, "init")) {
        unstarted = Math.max(0, unstarted - 1);
        if (pending) followUpStarted = true;
      } else if (event.type === "user" && pending) {
        consumed = true;
      }
    },
    beginTurn(kind: TurnKind): void {
      // A follow-up turn has no prompt of its own: its first result answers it.
      answered = kind === "follow-up";
      promptOutstanding = kind === "adopted";
    },
    noteInput(): void {
      unstarted += 1;
    },
    inputAnswered(): void {
      unstarted = 0;
      promptOutstanding = false;
    },
    closesTurn(result: Record<string, unknown>): TurnVerdict {
      const notification = fromNotification(result);
      if (!answered) {
        if (notification && result.num_turns === 0) return "continue";
        answered = true;
      }
      let ambiguous = unstarted > 0;
      if (promptOutstanding) {
        if (notification) ambiguous = true;
        else promptOutstanding = false;
      }
      if (pending) {
        resultsSince += 1;
        if (!followUpStarted && !consumed && resultsSince < 2) return "continue";
        pending = false;
      }
      if (active.size === 0) return "close";
      return ambiguous ? "wait" : "linger";
    },
    activeCount: () => active.size,
    tasks: () => [...active.values()],
  };
}

/**
 * A result a notification's cycle produced. Only `num_turns: 0` is safe to
 * skip as not the prompt's answer: the CLI can fold a queued prompt into a
 * notification cycle that does call the model, and that cycle's result is then
 * the prompt's answer even though its origin says task-notification.
 */
function fromNotification(result: Record<string, unknown>): boolean {
  const origin = result.origin;
  return typeof origin === "object" && origin !== null && (origin as Record<string, unknown>).kind === "task-notification";
}
