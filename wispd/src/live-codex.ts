import type { AdapterDef } from "./adapters";
import { CodexLiveDriver, type CodexLiveInput } from "./adapters/live/codex";
import type { StoredAttachment } from "./attachments";
import {
  closeLiveInput,
  forgetLiveProcess,
  lingerTiming,
  messageAttachments,
  noteDelivery,
  openLiveInput,
  pumpJsonLines,
  registerLiveProcess,
  releaseLiveTurn,
  staged,
  steerText,
  type ConfigureLiveTurnOptions,
  type LingeringLiveProcess,
  type LiveOutputSink,
  type LiveTurn,
} from "./live-input";
import { setTurnUsage, turnForTask } from "./store";
import { clearHarnessBackground, setHarnessBackground } from "./task-processes";
import { nativeImageAttachments } from "./turn-input";

export function codexInput(def: AdapterDef, text: string, attachments: StoredAttachment[]): CodexLiveInput[] {
  return [
    ...nativeImageAttachments(def, attachments).map((attachment) => ({
      type: "localImage" as const,
      path: attachment.path,
    })),
    { type: "text", text, text_elements: [] },
  ];
}

export function configureCodex(options: ConfigureLiveTurnOptions): Promise<void> {
  const sink = options.child.stdin;
  if (!sink || typeof sink === "number") throw new Error("Codex live process did not expose stdin");
  const codex = new CodexLiveProcess(options, sink);
  registerLiveProcess(options.task.id, codex);
  // Unreadable stdout goes wherever the process's output goes at that moment.
  const following: LiveOutputSink = {
    recordEvent: (event) => codex.output().recordEvent(event),
    recordStdoutLine: (line) => codex.output().recordStdoutLine(line),
    recordNote: (note) => codex.output().recordNote(note),
    recordFrameDrop: (source, chars) => codex.output().recordFrameDrop(source, chars),
  };
  return Promise.all([
    staged("live input setup", codex.ready),
    staged("live output pump", pumpJsonLines(options.child, following, codex.driver, "Codex closed the app-server channel")),
  ]).then(() => {});
}

const GOAL_ACTIVE = "active";

/**
 * Wisp's side of one live Codex app-server, which can serve several turn rows.
 *
 * A turn normally ends at its `turn/completed`: stdin closes and the
 * app-server exits. A thread with an active Codex Goal does not stop there:
 * the app-server starts the next turn by itself about a tenth of a second
 * later (live-probed on 0.164.0), and keeps going until the goal is complete,
 * paused, blocked or out of budget, or until Codex's own guard stops a
 * continuation that made no progress. Closing stdin at the answer killed that
 * continuation. So while the goal is active the turn settles here instead and
 * the process LINGERS, as a Claude or Droid process does:
 *  - Each turn the app-server starts by itself opens a follow-up turn
 *    (`hooks.wake`), recorded like any background follow-up.
 *  - A new message is started on the same thread as a NEW turn (`adopt`).
 *  - When the goal is no longer active, or no continuation comes, stdin
 *    closes and the process exits.
 * Without the hooks (or while a Stop owns the turn) stdin closes at the
 * answer, as it always did.
 */
export class CodexLiveProcess implements LingeringLiveProcess {
  readonly driver: CodexLiveDriver;
  readonly ready: Promise<void>;
  private readonly taskId: string;
  private current: LiveTurn;
  private phaseValue: "turn" | "settling" | "lingering" = "turn";
  private closing = false;
  private between: LiveOutputSink | null = null;
  private decided = false;
  /**
   * Continuations the app-server started that no turn records yet (a settle
   * was still running, or an earlier one is still waiting for its turn), in
   * order. The driver streams the newest, so what it says goes to the last;
   * each opens its turn when the settle before it is done.
   */
  private unrecorded: { held: Record<string, unknown>[]; usage: Record<string, unknown> | null; ended: boolean }[] = [];
  private quiet: ReturnType<typeof setTimeout> | null = null;
  private settling: Promise<void> = Promise.resolve();
  private lingeringSince = new Date().toISOString();

  constructor(private readonly options: ConfigureLiveTurnOptions, sink: import("bun").FileSink) {
    this.taskId = options.task.id;
    this.current = { turnId: options.turnId, turn: options.turn, sink: options.recorder };
    this.driver = new CodexLiveDriver({
      sink,
      def: options.def,
      cwd: options.task.worktree_path!,
      sessionId: options.task.session_id,
      model: options.task.model,
      effort: options.task.effort,
      fast: options.task.fast !== 0,
      initialMessageId: options.initialMessageId,
      initialInput: codexInput(options.def, options.prompt, options.attachments),
      emit: (event) => this.event(event),
      onTerminal: () => {
        const streaming = this.unrecorded.at(-1);
        if (streaming) streaming.ended = true;
        else this.decide();
      },
      // The driver reads its resume's starting point from the previous turn's usage...
      previousUsage: options.task.session_id ? turnForTask(options.task.id, options.turn - 1)?.usage_json : null,
      // ...so the turn stores its own as it grows: one that never completes still leaves a starting point
      onUsage: (usage) => {
        const streaming = this.unrecorded.at(-1);
        if (streaming) streaming.usage = usage;
        else setTurnUsage(this.current.turnId, JSON.stringify(usage));
      },
      onContinuation: (turnId) => this.continuation(turnId),
      onGoal: () => this.checkQuiet(),
    });
    this.ready = this.driver.ready;
    this.open(this.current);
  }

  get phase(): "turn" | "settling" | "lingering" | "closing" {
    return this.closing ? "closing" : this.phaseValue;
  }

  get turnId(): number {
    return this.current.turnId;
  }

  async settled(): Promise<void> {
    for (let current = this.settling; ; current = this.settling) {
      await current;
      if (current === this.settling) return;
    }
  }

  adopt(turn: LiveTurn, prompt: string, attachments: StoredAttachment[], messageId?: string): Promise<void> {
    if (this.phase !== "lingering") throw new Error("the live Codex process is not waiting for a turn");
    const settled = this.current;
    const between = this.between;
    this.open(turn);
    return this.driver
      .startTurn(messageId ?? `wisp-turn-${turn.turnId}`, codexInput(this.options.def, prompt, attachments))
      .catch((error) => {
        // It never took the prompt (a continuation may have started first).
        // Back to the settled turn, input closing, so the exit watcher starts
        // the next turn on a resumed process.
        this.closing = true;
        this.clearTimers();
        releaseLiveTurn(this.taskId, turn.turnId);
        if (this.current.turnId === turn.turnId) {
          this.current = settled;
          this.between = between;
          this.phaseValue = "lingering";
        }
        void this.driver.close().catch(() => {});
        throw error;
      });
  }

  retire(): void {
    this.options.linger = undefined;
    this.clearTimers();
  }

  ended(): void {
    this.retire();
    forgetLiveProcess(this.taskId, this);
    clearHarnessBackground(this.current.turnId);
  }

  output(): LiveOutputSink {
    return this.phaseValue === "turn" ? this.current.sink : (this.between ?? this.current.sink);
  }

  private event(event: Record<string, unknown>): void {
    const streaming = this.unrecorded.at(-1);
    if (streaming) streaming.held.push(event);
    else this.output().recordEvent(event);
  }

  private open(turn: LiveTurn): void {
    this.clearTimers();
    this.current = turn;
    this.phaseValue = "turn";
    this.between = null;
    this.decided = false;
    openLiveInput(this.taskId, {
      turnId: turn.turnId,
      turn: turn.turn,
      send: async (message) => {
        const files = messageAttachments(this.taskId, message);
        await this.driver.send(message.id, codexInput(this.options.def, steerText(this.options.def, message, files), files));
        noteDelivery(turn.sink, message, files);
      },
      close: () => this.close(),
    });
  }

  private goalActive(): boolean {
    return this.driver.goal?.status === GOAL_ACTIVE;
  }

  /** The open turn's answer is in: keep the process for an active goal's next turn, or let it go. */
  private decide(): void {
    if (this.phaseValue !== "turn" || this.decided) return;
    this.decided = true;
    // a continuation still waiting for its turn keeps it too, whatever the goal says by now
    if ((this.goalActive() || this.unrecorded.length > 0) && this.linger()) return;
    void closeLiveInput(this.taskId, this.current.turnId);
  }

  /** Settle the current turn and keep the process for the goal's next turn. False when it may not. */
  private linger(): boolean {
    const hooks = this.options.linger;
    const turn = this.current;
    if (!hooks || this.closing || !hooks.canLinger(turn.turnId)) return false;
    this.clearTimers();
    this.phaseValue = "settling";
    this.lingeringSince = new Date().toISOString();
    // The steer channel belonged to the turn, which is over. A send now is a
    // new turn, which the runner hands back through `adopt`.
    releaseLiveTurn(this.taskId, turn.turnId);
    // What the badge and `wisp wait --settled` name: the goal still running.
    setHarnessBackground(turn.turnId, () => {
      const goal = this.driver.goal;
      return goal?.status === GOAL_ACTIVE
        ? [{ name: (goal.objective || "Codex goal").slice(0, 120), kind: "goal", turn: turn.turn, since: this.lingeringSince }]
        : [];
    });
    this.between = hooks.between(turn.turnId);
    this.settling = hooks.settle(turn.turnId)
      .catch((error) => console.error(`[wisp] task ${this.taskId}: settling turn ${turn.turn} for its Codex goal failed: ${String(error)}`))
      .then(() => this.afterSettle());
    return true;
  }

  private afterSettle(): void {
    if (this.phaseValue !== "settling") return;
    this.phaseValue = "lingering";
    const next = this.unrecorded.shift();
    if (next && !this.record(next)) return;
    if (this.phaseValue === "lingering") this.options.linger?.idle();
    this.checkQuiet();
  }

  /** Open the turn for a continuation held so far, and play back what it said. False when it could not be recorded. */
  private record(continuation: { held: Record<string, unknown>[]; usage: Record<string, unknown> | null; ended: boolean }): boolean {
    const turn = this.wakeTurn();
    if (!turn) return false;
    if (continuation.usage) setTurnUsage(turn.turnId, JSON.stringify(continuation.usage));
    for (const event of continuation.held) turn.sink.recordEvent(event);
    // its answer is in: settle it (and keep going for the goal) or let the process go
    if (continuation.ended) this.decide();
    return true;
  }

  /** The app-server started the goal's next turn by itself; the driver already serves it. */
  private continuation(_turnId: string): void {
    if (this.closing) return;
    if (this.phaseValue === "lingering" && this.unrecorded.length === 0) {
      this.wakeTurn();
    } else if (this.phaseValue === "settling" || this.unrecorded.length > 0) {
      // recorded once the settle (or the turn before it) is done
      this.unrecorded.push({ held: [], usage: null, ended: false });
    } else {
      // An answer already let go of (or no hooks at all): it must not run unseen.
      void this.close().catch(() => {});
    }
  }

  /** Open the follow-up turn for the continuation the driver now serves, or close when it cannot be recorded. */
  private wakeTurn(): LiveTurn | null {
    const goal = this.driver.goal;
    const turn = this.options.linger?.wake(`Codex goal continued: ${(goal?.objective || "the thread's goal").slice(0, 200)}`) ?? null;
    if (!turn) {
      // Over a task that needs the person, failed, or is being stopped.
      this.unrecorded = [];
      void this.close().catch(() => {});
      return null;
    }
    this.open(turn);
    return turn;
  }

  /**
   * Lingering with the goal no longer active, or with no continuation coming:
   * the process has nothing more to do, so its input closes. A continuation
   * starts within a fraction of a second; the wait covers a slow machine.
   */
  private checkQuiet(): void {
    if (this.quiet) clearTimeout(this.quiet);
    this.quiet = null;
    if (this.phase !== "lingering") return;
    this.quiet = setTimeout(() => {
      this.quiet = null;
      if (this.phase === "lingering") void this.close().catch(() => {});
    }, this.goalActive() ? lingerTiming.quietMs : lingerTiming.followOnMs);
    this.quiet.unref?.();
  }

  private close(): Promise<void> {
    this.closing = true;
    this.clearTimers();
    return this.driver.close();
  }

  private clearTimers(): void {
    if (this.quiet) clearTimeout(this.quiet);
    this.quiet = null;
  }
}
