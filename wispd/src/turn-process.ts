import { appendFileSync, openSync } from "node:fs";
import { join } from "node:path";
import type { AdapterDef } from "./adapters";
import { attachmentManifest, formatAttachNote, restoreMessageAttachments, type StoredAttachment } from "./attachments";
import { LOG_DIR, transcriptBudgetBytes, type WispConfig } from "./config";
import { emit } from "./events";
import { backgroundPass, homeIsDraining } from "./home-lifetime";
import {
  closeLiveInput,
  forgetLiveTurn,
  LiveTransportError,
  pendingDelivery,
  type ClaudeLingerHooks,
  type ClaudeLiveProcess,
  type LiveOutputSink,
  type LiveTurn,
} from "./live-input";
import { closeDescriptors, fileOverCap, pidIdentity } from "./process-watch";
import { settlePipes } from "./pipe-drain";
import { processGroupEnded, signalProcessTree } from "./process-tree";
import type { LineTarget } from "./recording/turn-recorder";
import { TurnRecorder } from "./recording/turn-recorder";
import {
  createTurn,
  db,
  getTask,
  getTurn,
  nextTurnNumber,
  reconcileTaskState,
  requeueStartedTaskMessage,
  runningTurn,
  setTaskFields,
  setTurnKillDetail,
  transition,
} from "./store";
import { processStop, processStopPending, refreshProcessGroups, settledGroupLeaders, transferProcessGroup } from "./task-processes";
import { finalizeTurn } from "./turn-finalize";
import { isTaskStopping, waitForInterrupt } from "./turn-interrupt";
import type { TurnNotes } from "./autopilot/store";
import type { Task, TurnOrigin } from "./types";

/**
 * A spawned harness process and the turn rows it serves.
 *
 * Every process serves one turn, except a live Claude process whose answer
 * arrived while work it started in the background is still running: that turn
 * settles, and the process lingers for the work (see live-input's
 * ClaudeLiveProcess). The next message becomes a turn ON it (`adoptTurn`), a
 * model call the work wakes becomes a follow-up turn (`openFollowUpTurn`), and
 * a message for another agent ends it (`endLingeringProcess`). The runner
 * spawns and owns the message queue; this module owns the process from then
 * until its exit watcher (`watchTurn`) has settled whatever it was serving.
 */

/** Live children by turn id — for interrupts. Re-adopted turns (post-restart) fall back to pid. */
export const liveChildren = new Map<number, ReturnType<typeof Bun.spawn>>();

/** The agent a harness process was started with; a turn for any other cannot reuse it. */
export interface TurnAgent {
  context_n: number;
  harness: string;
  model: string | null;
  effort: string | null;
  fast: boolean;
}

/**
 * One turn a process is serving: its row, its transcript files, its capture.
 * A live Claude process can serve several turn rows one after another (see
 * live-input's ClaudeLiveProcess); every other process serves exactly one.
 */
export interface TurnSlot {
  turnId: number;
  n: number;
  outPath: string;
  errPath: string;
  fds: number[];
  recorder: TurnRecorder | null;
  sink: LiveOutputSink;
}

/** A spawned harness process and the turn it serves now. */
export interface TurnProcess {
  taskId: string;
  child: ReturnType<typeof Bun.spawn>;
  def: AdapterDef;
  cfg: WispConfig;
  agent: TurnAgent;
  /** Start the task's next queued message, once nothing holds the task back (runner's startNextQueuedMessage). */
  startQueue: () => void;
  pidStartTime: string | null;
  slot: TurnSlot;
  /** Its Claude protocol side, when the process can outlive a turn. */
  claude?: ClaudeLiveProcess;
  /** `slot` has settled, and the process lingers for background work it started. */
  settled: boolean;
  /** Being stopped so a turn for another agent can start. */
  ending: boolean;
  /**
   * A turn being handed to the lingering process: settles once its prompt is
   * written, or once the turn is undone because the process could not take it.
   * The exit watcher waits for it before reading which turn it was serving.
   */
  adopting?: Promise<void>;
}

/** Live Claude processes that may linger past a turn and take the next one, by task. */
export const turnProcesses = new Map<string, TurnProcess>();
/** Room for what a lingering process prints between turns, in the settled turn's transcript. */
const BETWEEN_TURNS_MAX_BYTES = 256 * 1024;

/** Grace period between SIGTERM and SIGKILL escalation (a prior audit). */
export const KILL_GRACE_MS = 5000;
/** How long a turn's output pipes may stay open after the harness exits (see settlePipes). */
const PIPE_DRAIN_GRACE_MS = 2000;
/** Interrupt details written by force-archive, and the only reading of them. */
export const FORCE_ARCHIVE_DETAIL = "turn interrupted by force-archive";
export const FORCE_ARCHIVE_ESCALATED_DETAIL = `${FORCE_ARCHIVE_DETAIL} (escalated to SIGKILL after SIGTERM was trapped)`;

/** Was this turn killed to clear the way for an archive? Then its queue stays put. */
export function killedForArchive(turnId: number): boolean {
  return getTurn(turnId)?.interrupt_detail?.startsWith(FORCE_ARCHIVE_DETAIL) === true;
}

/**
 * A pipe drain that writes to whichever sink the process's output goes to
 * NOW, so a process that outlives one turn's recorder keeps its stderr with
 * the turn it is serving.
 */
export function followingSink(current: () => LiveOutputSink): LineTarget {
  return {
    recordStdoutLine: (line) => current().recordStdoutLine(line),
    recordStderrLine: (line) => {
      const sink = current();
      if (sink.recordStderrLine) sink.recordStderrLine(line);
      else sink.recordNote(line);
    },
    recordFrameDrop: (source, chars) => current().recordFrameDrop(source, chars),
  };
}

export function agentOf(task: Task): TurnAgent {
  return { context_n: task.context_n, harness: task.harness, model: task.model, effort: task.effort, fast: task.fast === 1 };
}

export function sameAgent(a: TurnAgent, b: TurnAgent): boolean {
  return a.context_n === b.context_n && a.harness === b.harness && a.model === b.model && a.effort === b.effort && a.fast === b.fast;
}

/**
 * The task's lingering Claude process, when it can take a turn for `task`'s
 * agent. Anything else that is still alive refuses: callers go through
 * startNextQueuedMessage, which ends or waits for such a process first.
 */
export function lingeringProcess(task: Task): TurnProcess | null {
  const proc = turnProcesses.get(task.id);
  if (!proc) return null;
  if (adoptable(proc) && sameAgent(proc.agent, agentOf(task))) return proc;
  throw new Error(`an earlier ${proc.agent.harness} process of this task is still running`);
}

/**
 * Lingering and still alive. A process that has exited belongs to its watcher
 * until the watcher is done with it, and the watcher starts the queue then.
 */
export function adoptable(proc: TurnProcess): boolean {
  return proc.settled && !proc.ending && childRunning(proc.child) && proc.claude?.phase === "lingering";
}

/**
 * Open a new turn row on a process that already runs, and move its capture
 * and process group there. Sync on purpose, like startTurn's spawn block: the
 * row and the move must not be split by the event loop.
 */
export function openSlot(
  proc: TurnProcess,
  taskId: string,
  n: number,
  prompt: string,
  attachments: StoredAttachment[],
  origin: TurnOrigin | null = null,
): TurnSlot {
  const outPath = join(LOG_DIR, `${taskId}-turn${n}.out.log`);
  const errPath = join(LOG_DIR, `${taskId}-turn${n}.err.log`);
  const outFd = openSync(outPath, "a");
  let errFd: number;
  try {
    errFd = openSync(errPath, "a");
  } catch (error) {
    closeDescriptors([outFd]);
    throw error;
  }
  let turnId: number;
  try {
    turnId = db.transaction(() => {
      const id = createTurn(taskId, n, prompt, proc.child.pid, outPath, proc.pidStartTime, attachmentManifest(attachments), "recorder-v1", proc.agent, origin);
      transferProcessGroup(proc.slot.turnId, id);
      return id;
    })();
  } catch (error) {
    closeDescriptors([outFd, errFd]);
    throw error;
  }
  const recorder = new TurnRecorder(turnId, proc.def, proc.cfg, outFd, errFd);
  if (attachments.length > 0) recorder.recordNote(formatAttachNote(attachments));
  liveChildren.delete(proc.slot.turnId);
  liveChildren.set(turnId, proc.child);
  proc.slot = { turnId, n, outPath, errPath, fds: [outFd, errFd], recorder, sink: recorder };
  proc.settled = false;
  return proc.slot;
}

/**
 * A message's turn on the lingering process: written to its stdin, as a steer
 * would be, but as a turn of its own. When the process cannot take it after
 * all (it exited as the prompt was written, before the watcher saw the exit),
 * the turn is undone and the message goes back to the queue, so the exit
 * watcher starts it on a resumed process instead of failing it.
 */
export function adoptTurn(
  proc: TurnProcess,
  task: Task,
  n: number,
  message: string,
  prompt: string,
  attachments: StoredAttachment[],
  autopilot: TurnNotes | null,
  messageId: string | undefined,
): void {
  const settled = proc.slot;
  const before = getTask(task.id);
  const slot = openSlot(proc, task.id, n, message, attachments);
  setTaskFields(task.id, { turn_count: n });
  transition(task.id, "running", `turn ${n}`);
  const turn: LiveTurn = { turnId: slot.turnId, turn: n, sink: slot.sink };
  // In the same tick as the row: the next line the process prints is this turn's.
  let write: Promise<void>;
  try {
    write = proc.claude!.adopt(turn, prompt, attachments);
  } catch (error) {
    write = Promise.reject(error);
  }
  proc.adopting = write.then(
    () => autopilot?.delivered(),
    (error) => {
      if (messageId && proc.slot === slot && undoAdoption(proc, settled, slot, messageId, before)) {
        console.error(`[wisp] task ${task.id}: the lingering harness could not take turn ${n} (${String(error)}); message ${messageId} is queued again`);
        return;
      }
      failLiveTurn(proc.child, slot.turnId, slot.sink, new LiveTransportError("live input setup", error));
    },
  );
}

/**
 * Take back a turn the harness never received: its row goes, its message and
 * attachments return to the queue, and the task reads what the settled turn
 * left it. The next turn reuses its number, as after a failed start.
 */
function undoAdoption(proc: TurnProcess, settled: TurnSlot, slot: TurnSlot, messageId: string, before: Task | null): boolean {
  slot.recorder?.finish();
  closeDescriptors(slot.fds);
  const requeued = db.transaction(() => {
    const message = requeueStartedTaskMessage(messageId, proc.taskId, slot.n);
    if (!message) return false;
    transferProcessGroup(slot.turnId, settled.turnId);
    // Nothing in it happened, so the row goes rather than settling as a failure.
    db.run(`DELETE FROM turns WHERE id = ? AND status = 'running'`, [slot.turnId]);
    setTaskFields(proc.taskId, { turn_count: slot.n - 1 });
    return true;
  })();
  if (!requeued) return false;
  restoreMessageAttachments(proc.taskId, messageId, slot.n);
  liveChildren.delete(slot.turnId);
  liveChildren.set(settled.turnId, proc.child);
  proc.slot = settled;
  proc.settled = true;
  if (before) reconcileTaskState(proc.taskId, before.state, before.state_detail);
  // Alive but deaf: stop it, so its exit watcher starts the message on a resumed process.
  if (childRunning(proc.child)) endLingeringProcess(proc, "it could not take the next message");
  return true;
}

export function lingerHooks(proc: TurnProcess): ClaudeLingerHooks {
  return {
    canLinger: (turnId) => lingerAllowed(proc, turnId),
    settle: (turnId) => settleLingeringTurn(proc, turnId),
    between: () => betweenTurnsSink(proc.slot),
    wake: (reason) => openFollowUpTurn(proc, reason),
    idle: () => proc.startQueue(),
  };
}

/** Only a turn nothing else owns may settle early: not one being stopped, killed, archived, or outlived by its process. */
function lingerAllowed(proc: TurnProcess, turnId: number): boolean {
  if (!childRunning(proc.child) || proc.ending || proc.slot.turnId !== turnId || homeIsDraining()) return false;
  const turn = getTurn(turnId);
  const task = getTask(proc.taskId);
  return turn?.status === "running" && turn.interrupt_detail === null && turn.kill_detail === null &&
    task !== null && !task.archived && !isTaskStopping(proc.taskId) && !processStopPending(proc.taskId) &&
    !waitForInterrupt(turnId);
}

/**
 * Settle a turn whose answer is in while its process lingers. The same
 * finalization as an exit, from what the recorder holds now; the turn has no
 * exit code, because its process has not exited.
 */
async function settleLingeringTurn(proc: TurnProcess, turnId: number): Promise<void> {
  const slot = proc.slot;
  if (slot.turnId !== turnId) return;
  proc.settled = true;
  const outcome = slot.recorder?.finish();
  closeDescriptors(slot.fds);
  await finalizeTurn(proc.taskId, turnId, proc.def, null, slot.outPath, slot.errPath, outcome);
}

/**
 * A model call the background work woke, after its turn settled: a turn of its
 * own, named for what woke it. Null leaves it with the settled turn's
 * transcript — nothing may start a turn during a Stop, an archive, or a
 * shutdown.
 */
function openFollowUpTurn(proc: TurnProcess, reason: string): LiveTurn | null {
  const task = getTask(proc.taskId);
  // Only over a task that is done: one that needs the person or failed says
  // so until the person acts, and a call nobody asked for must not clear that.
  if (!task || task.archived || task.state !== "done" || proc.ending || !childRunning(proc.child) || homeIsDraining() ||
    isTaskStopping(task.id) || processStopPending(task.id) || runningTurn(task.id)) return null;
  const n = nextTurnNumber(task.id, task.turn_count);
  let slot: TurnSlot;
  try {
    slot = openSlot(proc, task.id, n, reason, [], "background");
  } catch (error) {
    console.error(`[wisp] task ${task.id}: could not record a background follow-up as turn ${n}: ${String(error)}`);
    return null;
  }
  setTaskFields(task.id, { turn_count: n });
  transition(task.id, "running", `turn ${n}`);
  return { turnId: slot.turnId, turn: n, sink: slot.sink };
}

/**
 * What a lingering process prints while no turn is open — a background task
 * finishing, mostly — appended to the transcript of the turn it last served,
 * which is where that task started. Bounded: past the budget one note says so.
 */
function betweenTurnsSink(slot: TurnSlot): LiveOutputSink {
  let room = BETWEEN_TURNS_MAX_BYTES;
  let full = false;
  const append = (path: string, line: string): void => {
    if (full) return;
    const text = `${line}\n`;
    const bytes = Buffer.byteLength(text);
    const write = (target: string, value: string): void => {
      try {
        appendFileSync(target, value);
      } catch {
        // Best effort between turns; the turn itself is already recorded.
      }
    };
    if (bytes > room) {
      full = true;
      write(slot.outPath, "· Wisp kept no more of what this process printed between turns\n");
      return;
    }
    room -= bytes;
    write(path, text);
  };
  return {
    recordEvent: (event) => append(slot.outPath, JSON.stringify(event)),
    recordStdoutLine: (line) => append(slot.outPath, line),
    recordNote: (note) => append(slot.outPath, note),
    recordFrameDrop: (source, chars) =>
      append(source === "stdout" ? slot.outPath : slot.errPath, `· dropped an oversized ${source} protocol frame (${chars} characters)`),
    recordStderrLine: (line) => append(slot.errPath, line),
  };
}

/**
 * A message for another agent cannot ride the lingering process, and a second
 * harness beside it would split its session. Stop it as Stop stops background
 * work, the group first; its exit starts the message.
 */
export function endLingeringProcess(proc: TurnProcess, why: string): void {
  if (proc.ending) return;
  proc.ending = true;
  proc.claude?.output().recordNote(`· Wisp stopped the background work this turn left running: ${why}`);
  proc.claude?.retire();
  killChildTree(proc.child, "SIGTERM");
  const timer = setTimeout(() => childRunning(proc.child) && killChildTree(proc.child, "SIGKILL"), KILL_GRACE_MS);
  timer.unref?.();
  void proc.child.exited.finally(() => clearTimeout(timer));
}

/**
 * Boot: stop every harness an earlier daemon kept alive past its turn for
 * background work. This daemon cannot write to its stdin, so it can never take
 * the next message; a send would start `--resume` beside it while it keeps
 * writing the background work's own calls into the same session. Only a
 * leader whose identity is confirmed is signalled, and never one this daemon
 * started itself. Its group goes with it, as Stop would take it.
 */
export async function stopOrphanedHarnesses(graceMs = KILL_GRACE_MS): Promise<void> {
  const leaders = settledGroupLeaders();
  if (!leaders.length) return;
  await Promise.all(leaders.map(({ turnId, taskId }) => stopOrphanedHarness(turnId, taskId, graceMs)));
  await refreshProcessGroups();
}

async function stopOrphanedHarness(turnId: number, taskId: string, graceMs: number): Promise<void> {
  const turn = getTurn(turnId);
  const pid = turn?.pid;
  if (!turn || !pid || liveChildren.has(turnId) || turnProcesses.get(taskId)?.child.pid === pid) return;
  const ours = async (): Promise<boolean> => (await pidIdentity(pid, turn.pid_start_time, turn.started_at)) === "alive";
  if (!(await ours())) return;
  console.error(
    `[wisp] task ${taskId}: turn ${turn.n}'s harness (pid ${pid}) outlived the previous daemon for the background work it started; ` +
      "stopping it, so the next turn does not run beside it in the same session",
  );
  try {
    appendFileSync(turn.log_file, "· Wisp restarted and stopped the background work this turn left running: the new daemon could not give its process the next message\n");
  } catch {
    // The log line is a courtesy; the stop is what matters.
  }
  const signal = async (sig: "SIGTERM" | "SIGKILL"): Promise<void> => {
    if (await ours()) signalProcessTree(pid, sig, () => process.kill(pid, sig));
  };
  await signal("SIGTERM");
  if (await processGroupEnded(pid, graceMs)) return;
  await signal("SIGKILL");
  await processGroupEnded(pid, Math.max(graceMs, 1000));
}

export function childRunning(child: ReturnType<typeof Bun.spawn>): boolean {
  return child.exitCode === null && child.signalCode === null;
}

/** Kill a live turn whose transport broke, naming the half that failed (LiveTransportError). */
export function failLiveTurn(
  child: ReturnType<typeof Bun.spawn>,
  turnId: number,
  sink: LiveOutputSink,
  error: unknown,
): void {
  if (!childRunning(child)) return;
  const stage = error instanceof LiveTransportError ? error.stage : "live input setup";
  const detail = `${stage} failed: ${error instanceof Error ? error.message : String(error)}`;
  sink.recordNote(`· ${detail}`);
  setTurnKillDetail(turnId, detail);
  killChildTree(child, "SIGTERM");
  const timer = setTimeout(() => childRunning(child) && killChildTree(child, "SIGKILL"), KILL_GRACE_MS);
  timer.unref?.();
  void child.exited.finally(() => clearTimeout(timer));
}

/**
 * Signal a live child's whole group, falling back to the child handle. Bun's
 * `child.kill` is preferred as the fallback because it also keeps the
 * subprocess object's own bookkeeping straight.
 */
export function killChildTree(child: ReturnType<typeof Bun.spawn>, sig: "SIGTERM" | "SIGKILL"): void {
  signalProcessTree(child.pid, sig, (signal) => child.kill(signal));
}

function notifyTask(taskId: string): void {
  const task = getTask(taskId);
  if (task) emit({ type: "task", taskId, state: task.state, stateDetail: task.state_detail, seq: task.seq });
}

/**
 * Wait for a spawned harness to exit, then settle the turn it was serving.
 * A process that lingered past its last turn's answer has nothing left to
 * settle: its exit only ends the background work it was kept for.
 */
export async function watchTurn(
  proc: TurnProcess,
  outputPump: Promise<void> = Promise.resolve(),
  stderrPump: Promise<void> = Promise.resolve(),
): Promise<void> {
  const { child, taskId, def, cfg } = proc;
  // A process that can span turns is recorder-captured, and only a capture
  // without a recorder needs the cap check, so this is always the one turn.
  const first = proc.slot;
  let capTermAt: number | null = null;
  let capChecking = false;
  const capTick = async (): Promise<void> => {
    if (capChecking) return;
    capChecking = true;
    try {
      const budget = transcriptBudgetBytes(cfg);
      const hit = await fileOverCap([first.outPath, first.errPath], budget);
      if (!hit) return;
      if (capTermAt === null) {
        capTermAt = Date.now();
        console.error(`[wisp] task ${taskId}: log cap exceeded (${hit}), killing turn`);
        setTurnKillDetail(first.turnId, `log cap exceeded (${budget} bytes)`);
        // The whole group, for the same reason the re-adoption poll's cap kill
        // signals one: the harness's own children are what filled this log, and
        // killing only the leader leaves them writing to it (ENG-03). This is
        // the common path — a non-recorder turn owned by THIS daemon.
        killChildTree(child, "SIGTERM");
      } else if (Date.now() - capTermAt >= KILL_GRACE_MS && childRunning(child)) {
        // M3: a harness that traps SIGTERM must not keep the turn alive forever
        console.error(`[wisp] task ${taskId}: turn survived SIGTERM, escalating to SIGKILL`);
        setTurnKillDetail(first.turnId, `log cap exceeded (${budget} bytes); escalated to SIGKILL after SIGTERM was trapped`);
        killChildTree(child, "SIGKILL");
      }
    } finally {
      capChecking = false;
    }
  };
  // detached tick, same idiom as `void watchTurn`: interval callbacks can't be awaited
  const capTimer = first.recorder ? null : setInterval(() => void backgroundPass(`log cap check for task ${taskId}`, capTick), 5000);
  const exitCode = await child.exited;
  if (capTimer !== null) clearInterval(capTimer);
  // A settle in flight records its turn (and may open the follow-up a held
  // call belongs to), and a turn being handed over is taken or undone, before
  // anything below reads which turn this was.
  await proc.claude?.settled();
  await proc.adopting;
  const slot = proc.slot;
  await refreshProcessGroups(taskId, slot.turnId);
  await waitForInterrupt(slot.turnId);
  liveChildren.delete(slot.turnId);
  forgetLiveTurn(taskId, slot.turnId);
  await closeLiveInput(taskId, slot.turnId);
  await pendingDelivery(taskId)?.catch(() => {});
  // Bounded: a process the harness left behind can hold its pipes open for as
  // long as it lives, and the turn must not wait on it to settle.
  if (await settlePipes([child.stdout, child.stderr], [outputPump, stderrPump], PIPE_DRAIN_GRACE_MS)) {
    console.error(`[wisp] task ${taskId}: turn ${slot.turnId} settled without waiting for a process that still holds its output open`);
    if (!proc.settled) slot.recorder?.recordNote("· the harness exited while a process it started still held its output open; the turn settled without waiting for it");
  }
  proc.claude?.ended();
  if (turnProcesses.get(taskId) === proc) turnProcesses.delete(taskId);
  if (proc.settled) {
    // It outlived its last turn's answer, and that turn is already settled:
    // what ended here is the background work it was kept for.
    notifyTask(taskId);
    await processStop(taskId)?.catch(() => {});
    proc.startQueue();
    return;
  }
  const recorderOutcome = slot.recorder?.finish();
  closeDescriptors(slot.fds);
  await waitForInterrupt(slot.turnId);
  await finalizeTurn(taskId, slot.turnId, def, exitCode, slot.outPath, slot.errPath, recorderOutcome);
  await processStop(taskId)?.catch(() => {});
  if (!killedForArchive(slot.turnId)) proc.startQueue();
}
