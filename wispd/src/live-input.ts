import { readFileSync, writeSync } from "node:fs";
import type { AdapterDef, ImageInputStrategy } from "./adapters";
import { liveCommand } from "./adapters/live/command";
import type { QuestionAnswer } from "./adapters/live/droid";
import type { QuestionPrompt } from "./adapters/types";
import { JsonLineBuffer } from "./adapters/live/json-lines";
import { createBackgroundFollowUp, isSystem, noticeText, startsModelCall, type TurnKind } from "./adapters/live/claude-background";
import { configureCodex } from "./live-codex";
import { configureDroid } from "./live-droid";
import { pipeReader } from "./pipe-drain";
import {
  formatAttachNote,
  parseAttachmentManifest,
  readMessageAttachments,
  type StoredAttachment,
} from "./attachments";
import { emit } from "./events";
import { getTask, runningTurn } from "./store";
import { clearHarnessBackground, setHarnessBackground } from "./task-processes";
import { reportFraming } from "./subtask-reports";
import { deliveredMessage, nativeImageAttachments, withWispSection } from "./turn-input";
import { formatSteerNote } from "./turn-notes";
import type { Task, TaskMessage, TurnInput, TurnInputMode } from "./types";

export interface LiveOutputSink {
  recordEvent(event: Record<string, unknown>): void;
  recordStdoutLine(line: string): void;
  recordNote(note: string): void;
  recordFrameDrop(source: "stdout" | "stderr", chars: number): void;
  /** Present on sinks that also take the harness's stderr (the recorder), so it can follow a process from turn to turn. */
  recordStderrLine?(line: string): void;
}

/** A turn a live process is serving, and where its output goes. */
export interface LiveTurn {
  turnId: number;
  turn: number;
  sink: LiveOutputSink;
}

/**
 * The runner's side of a live process that can outlive its turn (Claude's or
 * Droid's): the answer arrived, but work the agent started in the background
 * is still running, and closing stdin would make the harness kill it. Every
 * hook but `settle` runs synchronously on the line that needs it.
 */
export interface LingerHooks {
  /** May this turn settle now and leave its process running? False while a Stop, archive or shutdown owns it. */
  canLinger(turnId: number): boolean;
  /** Settle the turn from what it recorded. The process stays alive, stdin open. */
  settle(turnId: number): Promise<void>;
  /** Where the process's output goes while no turn is open: the settled turn's transcript. */
  between(turnId: number): LiveOutputSink;
  /** A model call (an agent turn) began with no turn open. Open the turn that records it, or null to keep it with the settled turn. */
  wake(reason: string): LiveTurn | null;
  /** The settle finished and nothing woke the process, so the next queued message may start. */
  idle(): void;
  /** Whether a process with nothing left in the background may stay warm for the task's next turn; null when it may not. */
  warm?(): WarmPolicy | null;
}

/** A warm process's terms: how many the daemon keeps at once, the least recently used going first. */
export interface WarmPolicy {
  cap: number;
}

export interface ActiveLiveInput {
  turnId: number;
  turn: number;
  send: (message: TaskMessage) => Promise<void>;
  /**
   * Answer a questionnaire the harness is blocked on, in its own protocol.
   * Absent on harnesses with no such channel — for those the operator answers
   * by sending, which is the send path above.
   */
  answer?: (questionId: string, answers: QuestionAnswer[]) => Promise<void>;
  /** The questionnaire this turn is waiting on, if any: the one named, else the oldest. */
  question?: (questionId?: string) => { id: string; questions: QuestionPrompt[] } | null;
  close: () => Promise<void>;
}

export interface ConfigureLiveTurnOptions {
  child: ReturnType<typeof Bun.spawn>;
  task: Task;
  def: AdapterDef;
  turnId: number;
  turn: number;
  recorder: LiveOutputSink;
  prompt: string;
  attachments: StoredAttachment[];
  initialMessageId: string;
  claudeStrategy?: ImageInputStrategy;
  /**
   * Lets a turn settle while its process keeps background work alive. Absent:
   * a Claude turn stays open instead, and a Droid turn closes as it always did.
   */
  linger?: LingerHooks;
}

/** Verified active-turn inputs by task. Absence means durable next-turn fallback. */
const liveInputs = new Map<string, ActiveLiveInput>();
/**
 * Turns this daemon spawned with a live channel, until their process exits.
 * The channel itself leaves `liveInputs` earlier, when the harness finishes
 * its answer; the difference between the two is a turn that is ending.
 */
const liveTurns = new Map<string, number>();
/** In-flight native admission acknowledgements, serialized per task. */
const pendingDeliveries = new Map<string, Promise<void>>();

export function activeLiveInput(taskId: string): ActiveLiveInput | undefined {
  return liveInputs.get(taskId);
}

export function turnInputMode(taskId: string, turnId: number): TurnInputMode {
  if (liveInputs.get(taskId)?.turnId === turnId) return "steer";
  return liveTurns.get(taskId) === turnId ? "wait" : "interrupt";
}

/** The running turn's input for the task API; null while idle. */
export function turnInput(taskId: string): TurnInput | null {
  const running = runningTurn(taskId);
  if (!running) return null;
  return {
    mode: turnInputMode(taskId, running.id),
    context_n: running.context_n,
    harness: running.harness,
    model: running.requested_model,
    effort: running.requested_effort,
    fast: running.requested_fast !== 0,
  };
}

export function forgetLiveTurn(taskId: string, turnId: number): void {
  if (liveTurns.get(taskId) === turnId) liveTurns.delete(taskId);
}

/** A live process opened `input`'s turn: it is the task's steer channel, and the turn is live until its process exits. */
export function openLiveInput(taskId: string, input: ActiveLiveInput): void {
  liveTurns.set(taskId, input.turnId);
  liveInputs.set(taskId, input);
}

/** The turn is over while its process stays: drop its steer channel and its live mark, without closing anything. */
export function releaseLiveTurn(taskId: string, turnId: number): void {
  if (liveInputs.get(taskId)?.turnId === turnId) liveInputs.delete(taskId);
  forgetLiveTurn(taskId, turnId);
}

export function pendingDelivery(taskId: string): Promise<void> | undefined {
  return pendingDeliveries.get(taskId);
}

export function setPendingDelivery(taskId: string, delivery: Promise<void>): void {
  pendingDeliveries.set(taskId, delivery);
}

export function clearPendingDelivery(taskId: string, delivery: Promise<void>): void {
  if (pendingDeliveries.get(taskId) === delivery) pendingDeliveries.delete(taskId);
}

export async function closeLiveInput(taskId: string, turnId: number): Promise<void> {
  const live = liveInputs.get(taskId);
  if (live?.turnId !== turnId) return;
  liveInputs.delete(taskId);
  // turn_input just went from steer to wait; no state transition will say so
  if (liveTurns.get(taskId) === turnId) notifyTask(taskId);
  await live.close().catch(() => {});
}

function notifyTask(taskId: string): void {
  const task = getTask(taskId);
  if (task) emit({ type: "task", taskId, state: task.state, stateDetail: task.state_detail, seq: task.seq });
}

/** Compatibility sink for live transports whose parser is not recorder-capable. */
export function legacyLiveOutput(outFd: number): LiveOutputSink {
  const line = (value: string): void => {
    writeSync(outFd, `${value}\n`);
  };
  return {
    recordEvent: (event) => line(JSON.stringify(event)),
    recordStdoutLine: line,
    recordNote: line,
    recordFrameDrop: (_source, chars) =>
      line(`· dropped an oversized live protocol frame (${chars} characters); the turn continues`),
  };
}

export { liveCommand };

export type LiveStage = "live input setup" | "live output pump";

/**
 * Which half of a live transport broke. Setup runs once while the turn is
 * starting; the pump runs for the whole turn, so a pump failure reported as
 * "setup" sends whoever reads it to the wrong end of the pipe.
 */
export class LiveTransportError extends Error {
  constructor(readonly stage: LiveStage, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
  }
}

export function staged<T>(stage: LiveStage, work: Promise<T>): Promise<T> {
  return work.catch((error) => {
    throw error instanceof LiveTransportError ? error : new LiveTransportError(stage, error);
  });
}

export function configureLiveTurn(options: ConfigureLiveTurnOptions): Promise<void> {
  liveTurns.set(options.task.id, options.turnId);
  switch (options.def.liveInput) {
    case "claude-stream-json": {
      if (!options.claudeStrategy) throw new Error("Claude live input strategy is unavailable");
      const claude = configureClaude(options, options.claudeStrategy);
      return Promise.all([
        staged("live input setup", claude.start()),
        staged("live output pump", pumpClaude(options.child, claude)),
      ]).then(() => {});
    }
    case "droid-jsonrpc":
      return configureDroid(options);
    case "codex-app-server":
      return configureCodex(options);
    default:
      throw new Error(`unsupported live input strategy: ${String(options.def.liveInput)}`);
  }
}

/** Write one image envelope and close stdin for a non-live attaching turn. */
export function writeImageEnvelope(
  child: ReturnType<typeof Bun.spawn>,
  strategy: ImageInputStrategy,
  def: AdapterDef,
  prompt: string,
  attachments: StoredAttachment[],
): void {
  try {
    const files = envelopeFiles(def, attachments);
    const sink = child.stdin;
    if (!sink || typeof sink === "number") return;
    void Promise.resolve(sink.write(`${strategy.envelope(prompt, files)}\n`)).catch(() => {});
    void Promise.resolve(sink.end()).catch(() => {});
  } catch {
    // The child is already gone; its watcher owns finalization.
  }
}

/**
 * The base64 blocks an image envelope carries. Images only: a pdf or a video
 * has no block type here, and its path is already named in the prompt (A1d).
 */
function envelopeFiles(
  def: AdapterDef,
  attachments: StoredAttachment[],
): { mediaType: string; dataBase64: string }[] {
  return nativeImageAttachments(def, attachments).map((attachment) => ({
    mediaType: attachment.mediaType as string,
    dataBase64: readFileSync(attachment.path).toString("base64"),
  }));
}

function envelopeFor(
  strategy: ImageInputStrategy,
  def: AdapterDef,
  prompt: string,
  attachments: StoredAttachment[],
): string {
  return strategy.envelope(prompt, envelopeFiles(def, attachments));
}

function configureClaude(options: ConfigureLiveTurnOptions, strategy: ImageInputStrategy): ClaudeLiveProcess {
  const sink = options.child.stdin;
  if (!sink || typeof sink === "number") throw new Error("live input process did not expose stdin");
  const claude = new ClaudeLiveProcess(options, strategy, sink);
  lingeringProcesses.set(options.task.id, claude);
  return claude;
}

/**
 * `followOnMs`: how long an answer waits for a model call input written during
 * it may still start. `quietMs`: how long a lingering process with nothing left
 * in the background waits for a call that end may wake before its input closes.
 * `recheckMs`: how often a lingering Droid checks that the commands it waits
 * for still run. `warmMs`: how long a warm Claude process waits for its task's
 * next turn (see `keepWarm`). A test seam; production never changes them.
 */
export const lingerTiming = { followOnMs: 1_500, quietMs: 10_000, recheckMs: 5_000, warmMs: 10 * 60_000 };

/**
 * Claude processes kept WARM: the turn's answer is in, nothing runs in the
 * background, and instead of closing its input the process waits for the
 * task's next turn, which `adopt` hands it as a lingering process's. A
 * resumed spawn costs every turn the CLI's boot before its first call, a
 * cold first call, and its exit after the answer. Measured on claude 2.1.322:
 * spawn to `init` 0.3 s, and 0.5 s from closing its input to its exit; a
 * small session's turn took 0.9 s less at the median through Wisp, and on a
 * 100k-token session the call itself answered about 1 s sooner warm. On a
 * loaded machine the boot alone reached 72 s at p99. An orchestrator's turns
 * come minutes apart (subtask reports, five-minute heartbeats, autopilot), so
 * most of them find their process warm.
 *
 * Bounded both ways. In time, `lingerTiming.warmMs` (10 minutes): long enough
 * for that traffic, short enough that a process does not sit on its memory
 * (about 270 MB each) or on settings, skills or CLAUDE.md edits it read at
 * boot for long. In number, the config's `warmHarnessProcesses` (4) across
 * the daemon, the least recently warmed going first. Only the process
 * changes: the session, the prompt and the harness's own choices are the
 * same either way.
 *
 * Least recently warmed first: a Set keeps insertion order.
 */
const warmProcesses = new Set<ClaudeLiveProcess>();

function keepWarm(process: ClaudeLiveProcess, cap: number): void {
  warmProcesses.delete(process);
  warmProcesses.add(process);
  for (const oldest of warmProcesses) {
    if (warmProcesses.size <= cap) break;
    warmProcesses.delete(oldest);
    oldest.cool();
  }
}

/** How many processes are warm now; a test seam. */
export function warmProcessCount(): number {
  return warmProcesses.size;
}

/**
 * A live harness process that can serve several turn rows: its answer settles
 * the turn while background work it started keeps running, and it LINGERS for
 * that work (ClaudeLiveProcess, DroidLiveProcess). turn-process.ts drives it
 * through this.
 */
export interface LingeringLiveProcess {
  /** `lingering` once the settled turn is recorded and the process may take the next one; `closing` once it may not. */
  readonly phase: "turn" | "settling" | "lingering" | "closing";
  /** The turn this process is serving, or the settled one it last served. */
  readonly turnId: number;
  /** Resolves once no settle is in flight. */
  settled(): Promise<void>;
  /** Take the next turn while lingering: its prompt goes to the live process. */
  adopt(turn: LiveTurn, prompt: string, attachments: StoredAttachment[], messageId?: string): Promise<void>;
  /** The process is going away on purpose: nothing it prints from now on opens a turn. */
  retire(): void;
  /** The process exited: stop every timer and forget it. */
  ended(): void;
  /** Where output goes now: the open turn, or between turns the settled one's transcript. */
  output(): LiveOutputSink;
}

/** Live processes that can linger, by task, from spawn until the runner sees them exit. */
const lingeringProcesses = new Map<string, LingeringLiveProcess>();

/** The task's live Claude, Droid or Codex process, if one is running. */
export function liveProcess(taskId: string): LingeringLiveProcess | undefined {
  return lingeringProcesses.get(taskId);
}

export function registerLiveProcess(taskId: string, process: LingeringLiveProcess): void {
  lingeringProcesses.set(taskId, process);
}

export function forgetLiveProcess(taskId: string, process: LingeringLiveProcess): void {
  if (lingeringProcesses.get(taskId) === process) lingeringProcesses.delete(taskId);
}

/**
 * Wisp's side of one live Claude CLI process, which can serve several turn
 * rows.
 *
 * A turn normally ends by closing stdin, and the process exits. When the answer
 * arrives while work the agent started in the background is still running (a
 * `run_in_background` command, a Monitor, a background agent), closing stdin
 * would make the CLI kill that work after its print-mode grace, so the turn
 * settles here instead and the process LINGERS: alive, stdin open, owned by
 * the task. Its process group stays recorded under the settled turn, which is
 * what makes it the task's background work for Stop, archive and the badge.
 *
 * While it lingers:
 *  - A new message is written to it as a NEW turn (`adopt`), so the CLI keeps
 *    its background work; the runner does that instead of spawning.
 *  - A model call the background work wakes (a completion, a Monitor event)
 *    starts with `system/init` and opens a follow-up turn of its own
 *    (`hooks.wake`): the agent is working again, so the task reads running. The
 *    settled turn never reopens.
 *  - Bookkeeping between turns (a task finishing without waking the model) is
 *    appended to the settled turn's transcript (`hooks.between`).
 *  - When nothing is left in the background and no call follows, stdin closes
 *    and the process exits; the runner then clears the marker.
 *
 * A turn whose answer leaves nothing in the background settles the same way
 * when the process may stay warm (`hooks.warm`, see `keepWarm`): it lingers
 * with nothing to wait for, so the task's next turn is written to it instead
 * of a resumed spawn. Its group is then no background work (task-processes
 * `isBackground`), unless a process a turn left behind no longer descends
 * from it.
 */
export class ClaudeLiveProcess implements LingeringLiveProcess {
  private readonly taskId: string;
  private readonly followUp = createBackgroundFollowUp();
  private current: LiveTurn;
  private phaseValue: "turn" | "settling" | "lingering" = "turn";
  /**
   * Its input is closing or closed: set the moment `close` is asked for, not
   * when the write chain gets to it, so no turn is handed a process that is
   * about to exit. The exit watcher starts the next turn with `--resume`.
   */
  private closing = false;
  private between: LiveOutputSink | null = null;
  /** Lines held while a settle is in flight and a model call has already begun. */
  private held: string[] | null = null;
  private followOn: { turnId: number; timer: ReturnType<typeof setTimeout> } | null = null;
  /** Bumped whenever the follow-on wait is cancelled or re-armed, so a wait already firing can tell. */
  private followOnGeneration = 0;
  private quiet: ReturnType<typeof setTimeout> | null = null;
  private settling: Promise<void> = Promise.resolve();
  /** What the last task notification since the turn settled said, for the follow-up turn's reason. */
  private notice: string | null = null;
  /** The last answer was an error: its process is not kept warm, so the next turn starts on a fresh one. */
  private answerFailed = false;
  private closed = false;
  // Serialized, but a failed write fails only itself: the chain keeps each
  // step's settling, never its rejection, so a later steer is still written
  // and close still ends stdin after an earlier write was refused.
  private chain = Promise.resolve();

  constructor(
    private readonly options: ConfigureLiveTurnOptions,
    private readonly strategy: ImageInputStrategy,
    private readonly sink: import("bun").FileSink,
  ) {
    this.taskId = options.task.id;
    this.current = { turnId: options.turnId, turn: options.turn, sink: options.recorder };
    this.open(this.current, "spawned");
  }

  /**
   * `lingering` once the settled turn is recorded and the process may take the
   * next one; `closing` once its input is closing, when it may not.
   */
  get phase(): "turn" | "settling" | "lingering" | "closing" {
    return this.closing ? "closing" : this.phaseValue;
  }

  /** The turn this process is serving, or the settled one it last served. */
  get turnId(): number {
    return this.current.turnId;
  }

  /**
   * Resolves once no settle is in flight. One settle can start the next: the
   * calls it held back open a follow-up turn, which can linger in turn.
   */
  async settled(): Promise<void> {
    for (let current = this.settling; ; current = this.settling) {
      await current;
      if (current === this.settling) return;
    }
  }

  /** Write the spawning turn's prompt. */
  start(): Promise<void> {
    return this.input(envelopeFor(this.strategy, this.options.def, this.options.prompt, this.options.attachments));
  }

  /** Take the next turn while lingering: its prompt goes to the live process. */
  adopt(turn: LiveTurn, prompt: string, attachments: StoredAttachment[], _messageId?: string): Promise<void> {
    if (this.phase !== "lingering") throw new Error("the live Claude process is not waiting for a turn");
    const settled = this.current;
    const between = this.between;
    this.open(turn, "adopted");
    return this.input(envelopeFor(this.strategy, this.options.def, prompt, attachments)).catch((error) => {
      // It never took the prompt: an exit the watcher has not seen yet, or a
      // process that stopped reading. Back to the settled turn, input closed,
      // so the exit watcher starts the next turn on a resumed process.
      this.closing = true;
      this.clearTimers();
      if (liveInputs.get(this.taskId)?.turnId === turn.turnId) liveInputs.delete(this.taskId);
      if (liveTurns.get(this.taskId) === turn.turnId) liveTurns.delete(this.taskId);
      if (this.current.turnId === turn.turnId) {
        this.current = settled;
        this.between = between;
        this.phaseValue = "lingering";
      }
      throw error;
    });
  }

  /** The process is going away on purpose: nothing it prints from now on opens a turn. */
  retire(): void {
    this.options.linger = undefined;
    this.clearTimers();
  }

  /** The process exited: stop every timer and forget it. */
  ended(): void {
    this.retire();
    if (lingeringProcesses.get(this.taskId) === this) lingeringProcesses.delete(this.taskId);
    clearHarnessBackground(this.current.turnId);
  }

  /** Where output goes now: the open turn, or between turns the settled one's transcript. */
  output(): LiveOutputSink {
    return this.phaseValue === "turn" ? this.current.sink : (this.between ?? this.current.sink);
  }

  /** One stdout line from the process, in order. */
  line(line: string): void {
    if (this.held) {
      this.held.push(line);
      return;
    }
    let event: Record<string, unknown> | null = null;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) event = parsed as Record<string, unknown>;
    } catch {
      // Plain notes and partial/unknown future events are still logged.
    }
    if (event && this.phaseValue !== "turn" && startsModelCall(event)) {
      if (this.phaseValue === "settling" && this.options.linger) {
        this.held = [line];
        return;
      }
      this.wake();
    }
    this.output().recordStdoutLine(line);
    if (!event) return;
    if (this.phaseValue !== "turn" && isSystem(event, "task_notification")) this.notice = noticeText(event);
    this.followUp.observe(event, this.current.turn);
    if (isSystem(event, "init")) this.clearFollowOn();
    if (event.type === "result" && this.phaseValue === "turn") this.decide(event);
    this.checkQuiet();
  }

  private open(turn: LiveTurn, kind: TurnKind): void {
    this.clearTimers();
    this.current = turn;
    this.phaseValue = "turn";
    this.between = null;
    this.notice = null;
    this.followUp.beginTurn(kind);
    liveTurns.set(this.taskId, turn.turnId);
    liveInputs.set(this.taskId, {
      turnId: turn.turnId,
      turn: turn.turn,
      send: async (message) => {
        const files = messageAttachments(this.taskId, message);
        await this.input(envelopeFor(this.strategy, this.options.def, steerText(this.options.def, message, files), files));
        noteDelivery(turn.sink, message, files);
      },
      close: () => this.close(),
    });
  }

  private input(line: string): Promise<void> {
    this.followUp.noteInput();
    // More input, so any wait for the call it may get starts over.
    if (this.followOn) this.armFollowOn(this.followOn.turnId);
    return this.write(line);
  }

  private serialize(step: () => Promise<void>): Promise<void> {
    const next = this.chain.then(step);
    this.chain = next.catch(() => {});
    return next;
  }

  private write(line: string): Promise<void> {
    return this.serialize(async () => {
      if (this.closed) throw new Error("live input already closed");
      await Promise.resolve(this.sink.write(`${line}\n`));
      await Promise.resolve(this.sink.flush());
    });
  }

  private close(): Promise<void> {
    this.closing = true;
    this.clearTimers();
    return this.serialize(async () => {
      if (this.closed) return;
      this.closed = true;
      await Promise.resolve(this.sink.end());
    });
  }

  private decide(result: Record<string, unknown>): void {
    this.answerFailed = result.is_error === true;
    const verdict = this.followUp.closesTurn(result);
    if (verdict === "close") this.finish(this.current.turnId);
    else if (verdict === "linger") this.linger();
    // Input written during this call may still get a call of its own, which
    // starts at once when it does. Settling first would file its answer as
    // background work's.
    else if (verdict === "wait" && this.options.linger && !this.followOn) this.armFollowOn(this.current.turnId);
  }

  private armFollowOn(turnId: number): void {
    this.clearFollowOn();
    const generation = this.followOnGeneration;
    const timer = setTimeout(() => {
      // One more I/O cycle first: a `system/init` already in the pipe is the
      // call starting, and it cancels this wait before anything settles. Input
      // written meanwhile re-arms it; either one bumps the generation.
      setImmediate(() => {
        if (generation !== this.followOnGeneration) return;
        this.followOn = null;
        if (this.phaseValue !== "turn" || this.current.turnId !== turnId) return;
        this.followUp.inputAnswered();
        if (this.followUp.activeCount() > 0) this.linger();
        else this.finish(turnId);
      });
    }, lingerTiming.followOnMs);
    this.followOn = { turnId, timer };
  }

  /**
   * The answer is in and nothing runs in the background. A process that may
   * stay warm settles the turn and waits for the task's next one; any other
   * closes its input and exits, which ends the turn.
   */
  private finish(turnId: number): void {
    if (this.answerFailed || !this.options.linger?.warm?.() || !this.linger()) void closeLiveInput(this.taskId, turnId);
  }

  /** Settle the current turn and keep the process: for its background work, or warm. False when it may not. */
  private linger(): boolean {
    const hooks = this.options.linger;
    const turn = this.current;
    // Without the hooks (or while a Stop owns the turn) the turn stays open
    // as it always did; stdin stays open either way.
    if (!hooks || this.closing || !hooks.canLinger(turn.turnId)) return false;
    this.clearTimers();
    this.phaseValue = "settling";
    this.followUp.inputAnswered();
    // The steer channel belonged to the turn, which is over. A send now is a
    // new turn, which the runner hands back through `adopt`.
    if (liveInputs.get(this.taskId)?.turnId === turn.turnId) liveInputs.delete(this.taskId);
    if (liveTurns.get(this.taskId) === turn.turnId) liveTurns.delete(this.taskId);
    setHarnessBackground(turn.turnId, () => this.followUp.tasks());
    this.between = hooks.between(turn.turnId);
    this.settling = hooks.settle(turn.turnId)
      .catch((error) => console.error(`[wisp] task ${this.taskId}: settling turn ${turn.turn} for its background work failed: ${String(error)}`))
      .then(() => {
        if (this.phaseValue !== "settling") return;
        this.phaseValue = "lingering";
        const held = this.held;
        this.held = null;
        for (const line of held ?? []) this.line(line);
        if (this.phaseValue === "lingering") this.options.linger?.idle();
        this.checkQuiet();
      });
    return true;
  }

  /** Evicted from the warm set: close its input, so it exits and the task's next turn resumes on a fresh one. */
  cool(): void {
    if (this.phaseValue === "lingering" && this.followUp.activeCount() === 0) void this.close().catch(() => {});
  }

  private wake(): void {
    const turn = this.options.linger?.wake(this.wakeReason());
    if (turn) this.open(turn, "follow-up");
  }

  private wakeReason(): string {
    if (this.notice) return `Background update: ${this.notice}`;
    const tasks = this.followUp.tasks();
    return tasks.length === 1 ? `Background update from "${tasks[0]!.name}"` : "Background update";
  }

  /**
   * Nothing left in the background, and no call has started: the process has
   * nothing more to do. Ending its input lets it exit.
   */
  private checkQuiet(): void {
    if (this.phase !== "lingering" || this.followUp.activeCount() > 0) {
      if (this.quiet) clearTimeout(this.quiet);
      this.quiet = null;
      warmProcesses.delete(this);
      return;
    }
    if (this.quiet) return;
    // Warm, it waits for the task's next turn; otherwise only for a call the
    // background work's end may still wake.
    const warm = this.answerFailed ? null : (this.options.linger?.warm?.() ?? null);
    if (warm) keepWarm(this, warm.cap);
    this.quiet = setTimeout(() => {
      this.quiet = null;
      if (this.phase === "lingering" && this.followUp.activeCount() === 0) void this.close().catch(() => {});
    }, warm ? lingerTiming.warmMs : lingerTiming.quietMs);
    this.quiet.unref?.();
  }

  private clearFollowOn(): void {
    this.followOnGeneration += 1;
    if (this.followOn) clearTimeout(this.followOn.timer);
    this.followOn = null;
  }

  private clearTimers(): void {
    this.clearFollowOn();
    if (this.quiet) clearTimeout(this.quiet);
    this.quiet = null;
    warmProcesses.delete(this);
  }
}

async function pumpClaude(child: ReturnType<typeof Bun.spawn>, claude: ClaudeLiveProcess): Promise<void> {
  const stdout = child.stdout;
  if (!stdout || typeof stdout === "number") return;
  const reader = pipeReader(stdout as ReadableStream<Uint8Array>);
  const decoder = new TextDecoder();
  // The drop note goes wherever the process's output goes at that moment.
  const frames = new JsonLineBuffer({ onDrop: (chars) => claude.output().recordFrameDrop("stdout", chars) });
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      for (const line of frames.push(decoder.decode(value, { stream: true }))) claude.line(line);
    }
    for (const line of frames.finish(decoder.decode())) claude.line(line);
  } finally {
    reader.releaseLock();
  }
}

/**
 * An unreadable frame is visible in the turn log rather than fatal to the turn:
 * the harness keeps running and only that one notification is lost.
 */
function frameDropNote(recorder: LiveOutputSink): (chars: number) => void {
  return (chars) => recorder.recordFrameDrop("stdout", chars);
}

/**
 * A steer's text as the harness receives it. A queued message's attachments get
 * the same treatment a turn's prompt does: images that have a native channel
 * ride it, and everything delivered by path is named in the text — otherwise a
 * csv attached mid-turn would reach a live harness as bytes nobody mentioned.
 */
export function steerText(def: AdapterDef, message: TaskMessage, files: StoredAttachment[]): string {
  // a subtask report steered mid-turn is framed from its rows, as one that starts a turn is (runner.ts)
  if (message.origin === "subtask") {
    const framed = reportFraming(message.id);
    return withWispSection(framed.lines, framed.words);
  }
  return deliveredMessage(def, files, message.text, message.origin);
}

export function messageAttachments(taskId: string, message: TaskMessage): StoredAttachment[] {
  return readMessageAttachments(taskId, message.id, parseAttachmentManifest(message.attachments_json));
}

/**
 * The steer's own place in the turn's transcript, written to the harness's log
 * fd once the delivery has been admitted. Ordering on that fd is the ordering
 * the conversation replays, so the message lands between what the harness had
 * already said and whatever it does next — never beside the turn's prompt.
 */
export function noteDelivery(recorder: LiveOutputSink, message: TaskMessage, files: StoredAttachment[]): void {
  recorder.recordNote(formatSteerNote(message.id, message.text));
  if (files.length > 0) recorder.recordNote(formatAttachNote(files));
}

interface JsonLineDriver {
  handle(frame: {
    id?: unknown;
    method?: unknown;
    params?: unknown;
    result?: unknown;
    error?: unknown;
  }): void;
  failPending(message: string): void;
}

export async function pumpJsonLines(
  child: ReturnType<typeof Bun.spawn>,
  recorder: LiveOutputSink,
  driver: JsonLineDriver,
  closedMessage: string,
): Promise<void> {
  const stdout = child.stdout;
  if (!stdout || typeof stdout === "number") return;
  const reader = pipeReader(stdout as ReadableStream<Uint8Array>);
  const decoder = new TextDecoder();
  const frames = new JsonLineBuffer({ onDrop: frameDropNote(recorder) });
  const consume = (line: string): void => {
    if (!line.trim()) return;
    try {
      driver.handle(JSON.parse(line));
    } catch {
      // Malformed stdout is evidence of protocol drift and stays in the log.
      recorder.recordStdoutLine(line);
    }
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      for (const line of frames.push(decoder.decode(value, { stream: true }))) consume(line);
    }
    for (const line of frames.finish(decoder.decode())) consume(line);
  } finally {
    driver.failPending(`${closedMessage} before acknowledging the request`);
    reader.releaseLock();
  }
}
