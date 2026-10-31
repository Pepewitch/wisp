import { readFileSync } from "node:fs";
import type { AdapterDef } from "./adapters";
import { DroidLiveDriver, type DroidLiveImage } from "./adapters/live/droid";
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
import { transition } from "./store";
import { clearHarnessBackground, setHarnessBackground } from "./task-processes";
import { nativeImageAttachments } from "./turn-input";

function droidImages(def: AdapterDef, attachments: StoredAttachment[]): DroidLiveImage[] {
  return nativeImageAttachments(def, attachments).map((attachment) => ({
    type: "base64",
    data: readFileSync(attachment.path).toString("base64"),
    mediaType: attachment.mediaType,
  }));
}

export function configureDroid(options: ConfigureLiveTurnOptions): Promise<void> {
  const sink = options.child.stdin;
  if (!sink || typeof sink === "number") throw new Error("Droid live process did not expose stdin");
  const droid = new DroidLiveProcess(options, sink);
  registerLiveProcess(options.task.id, droid);
  // Unreadable stdout goes wherever the process's output goes at that moment.
  const following: LiveOutputSink = {
    recordEvent: (event) => droid.output().recordEvent(event),
    recordStdoutLine: (line) => droid.output().recordStdoutLine(line),
    recordNote: (note) => droid.output().recordNote(note),
    recordFrameDrop: (source, chars) => droid.output().recordFrameDrop(source, chars),
  };
  return Promise.all([
    staged("live input setup", droid.ready),
    staged("live output pump", pumpJsonLines(options.child, following, droid.driver, "Droid closed the JSON-RPC channel")),
  ]).then(() => {});
}

/**
 * Wisp's side of one live Droid process, which can serve several turn rows.
 *
 * A turn normally ends when Droid reports `agent_turn_completed`: stdin
 * closes, and the process exits. When work the turn started in the background
 * is still running (an `Execute` with `fireAndForget`, a background `Task`),
 * closing stdin makes Droid exit within seconds and kill it, and the completion
 * Droid would have woken itself with never arrives. So the turn settles here
 * instead and the process LINGERS, as a Claude process does (see
 * ClaudeLiveProcess for what that means to Stop, archive and the badge):
 *  - A new message is written to it as a NEW turn (`adopt`).
 *  - When the work finishes, Droid adds its own completion message and answers
 *    it in an agent turn, which opens a follow-up turn (`hooks.wake`).
 *  - What it prints while no turn is open goes to the settled turn's
 *    transcript (`hooks.between`).
 *  - When nothing is left in the background and Droid is idle, stdin closes
 *    and the process exits.
 * Without the hooks (or while a Stop owns the turn) stdin closes at the answer,
 * as it always did.
 */
export class DroidLiveProcess implements LingeringLiveProcess {
  readonly driver: DroidLiveDriver;
  readonly ready: Promise<void>;
  private readonly taskId: string;
  private current: LiveTurn;
  private phaseValue: "turn" | "settling" | "lingering" = "turn";
  private closing = false;
  private between: LiveOutputSink | null = null;
  /** The turn's answer has been acted on: settled, or its input closing. */
  private decided = false;
  /** A completion that arrived while the answer was settling: the follow-up turn it opens once the settle is done. */
  private pendingWake: string | null = null;
  /** Events held while that settle finishes, for the follow-up turn. */
  private held: Record<string, unknown>[] | null = null;
  /** That follow-up's answer arrived while the settle was still running: decide once its turn is open. */
  private decideAfterWake = false;
  private quiet: ReturnType<typeof setTimeout> | null = null;
  private settling: Promise<void> = Promise.resolve();

  constructor(private readonly options: ConfigureLiveTurnOptions, sink: import("bun").FileSink) {
    this.taskId = options.task.id;
    this.current = { turnId: options.turnId, turn: options.turn, sink: options.recorder };
    this.driver = new DroidLiveDriver({
      sink,
      def: options.def,
      cwd: options.task.worktree_path!,
      sessionId: options.task.session_id,
      model: options.task.model,
      effort: options.task.effort,
      initialMessageId: options.initialMessageId,
      initialText: options.prompt,
      initialImages: droidImages(options.def, options.attachments),
      turn: options.turn,
      emit: (event) => this.event(event),
      onTerminal: () => this.decide(),
      onBackgroundCompletion: (notice) => this.completion(notice),
      onIdle: () => this.checkQuiet(),
      // A suspended turn is still a running turn, so only the task STATE moves.
      // It also takes the task out of stuck-detection's reach, which skips
      // anything that is not running or already stuck — a turn idling on a
      // question is neither quiet nor broken, it is waiting on purpose.
      onWaiting: (waiting) =>
        transition(
          this.taskId,
          waiting ? "needs-input" : "running",
          waiting ? `turn ${this.current.turn} is asking you` : `turn ${this.current.turn}`,
        ),
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
    if (this.phase !== "lingering") throw new Error("the live Droid process is not waiting for a turn");
    const settled = this.current;
    const between = this.between;
    this.open(turn);
    this.driver.reopen(turn.turn);
    return this.driver
      .send(messageId ?? `wisp-turn-${turn.turnId}`, prompt, droidImages(this.options.def, attachments))
      .catch((error) => {
        // It never took the prompt. Back to the settled turn, input closing,
        // so the exit watcher starts the next turn on a resumed process.
        this.closing = true;
        this.clearTimers();
        releaseLiveTurn(this.taskId, turn.turnId);
        if (this.current.turnId === turn.turnId) {
          this.current = settled;
          this.between = between;
          this.phaseValue = "lingering";
        }
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
    if (this.held) this.held.push(event);
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
        await this.driver.send(message.id, steerText(this.options.def, message, files), droidImages(this.options.def, files));
        noteDelivery(turn.sink, message, files);
      },
      answer: (questionId, answers) => this.driver.answer(questionId, answers),
      question: (questionId) => this.driver.pendingQuestion(questionId),
      close: () => this.close(),
    });
  }

  /** The open turn's answer is in: keep the process for its background work, or let it go. */
  private decide(): void {
    if (this.phaseValue === "settling" && this.pendingWake !== null) {
      this.decideAfterWake = true;
      return;
    }
    if (this.phaseValue !== "turn" || this.decided) return;
    this.decided = true;
    if (this.driver.background.count() > 0 && this.linger()) return;
    void closeLiveInput(this.taskId, this.current.turnId);
  }

  /** Settle the current turn and keep the process for its background work. False when it may not. */
  private linger(): boolean {
    const hooks = this.options.linger;
    const turn = this.current;
    if (!hooks || this.closing || !hooks.canLinger(turn.turnId)) return false;
    this.clearTimers();
    this.phaseValue = "settling";
    // The steer channel belonged to the turn, which is over. A send now is a
    // new turn, which the runner hands back through `adopt`.
    releaseLiveTurn(this.taskId, turn.turnId);
    setHarnessBackground(turn.turnId, () => this.driver.background.tasks());
    this.between = hooks.between(turn.turnId);
    this.settling = hooks.settle(turn.turnId)
      .catch((error) => console.error(`[wisp] task ${this.taskId}: settling turn ${turn.turn} for its background work failed: ${String(error)}`))
      .then(() => {
        if (this.phaseValue !== "settling") return;
        this.phaseValue = "lingering";
        const reason = this.pendingWake;
        const held = this.held;
        const decide = this.decideAfterWake;
        this.pendingWake = null;
        this.held = null;
        this.decideAfterWake = false;
        if (reason !== null) {
          const next = this.options.linger?.wake(reason);
          // The driver already records this agent turn as a new one (`completion`).
          if (next) {
            this.open(next);
            this.driver.renumber(next.turn);
          }
        }
        for (const event of held ?? []) this.output().recordEvent(event);
        if (decide) this.decide();
        if (this.phaseValue === "lingering") this.options.linger?.idle();
        this.checkQuiet();
      });
    return true;
  }

  /** Background work finished, and Droid is starting the agent turn that answers it. */
  private completion(notice: string): void {
    const reason = `Background update: ${notice}`;
    if (this.phaseValue === "settling" && this.options.linger) {
      if (this.pendingWake !== null) return;
      // Its agent turn may print, and even end, before the settle is done:
      // hold all of it for the follow-up turn the settle opens.
      this.pendingWake = reason;
      this.held = [];
      this.driver.reopen(this.current.turn);
    } else if (this.phaseValue === "lingering") {
      this.wake(reason);
    }
    // During a turn the completion is that turn's.
  }

  private wake(reason: string): void {
    const turn = this.options.linger?.wake(reason);
    if (!turn) return;
    this.open(turn);
    this.driver.reopen(turn.turn);
  }

  /**
   * Nothing left in the background and Droid idle: the process has nothing
   * more to do, so its input closes. While commands remain, check now and then
   * that their processes still run, in case a completion went unrecognized.
   */
  private checkQuiet(): void {
    if (this.quiet) clearTimeout(this.quiet);
    this.quiet = null;
    if (this.phase !== "lingering") return;
    const busy = this.driver.background.count() > 0;
    this.quiet = setTimeout(() => {
      this.quiet = null;
      if (this.phase !== "lingering") return;
      if (busy) {
        this.driver.background.prune();
        this.checkQuiet();
      } else if (this.driver.background.count() === 0 && !this.driver.working) {
        void this.close().catch(() => {});
      } else {
        this.checkQuiet();
      }
    }, busy ? lingerTiming.recheckMs : lingerTiming.quietMs);
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
