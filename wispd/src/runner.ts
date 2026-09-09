import { openSync, writeSync } from "node:fs";
import { join } from "node:path";
import {
  buildArgv,
  hasIncrementalOutcomeReducer,
  IMAGE_DELIVERY_STRATEGIES,
  IMAGE_INPUT_STRATEGIES,
  type AdapterDef,
  type ImageInputStrategy,
} from "./adapters";
import {
  attachmentManifest,
  formatAttachNote,
  parseAttachmentManifest,
  promoteMessageAttachments,
  removeMessageAttachments,
  restoreMessageAttachments,
  taskMessageAttachmentsFingerprint,
  type DecodedAttachment,
  type StoredAttachment,
  writeMessageAttachments,
} from "./attachments";
import { LOG_DIR, transcriptBudgetBytes, type WispConfig } from "./config";
import {
  activeLiveInput,
  clearPendingDelivery,
  closeLiveInput,
  configureLiveTurn,
  liveCommand,
  LiveTransportError,
  pendingDelivery,
  setPendingDelivery,
  writeImageEnvelope,
  type LiveOutputSink,
} from "./live-input";
import { assertExecutableAllowed } from "./launch-policy";
import { assertTaskNotStopping, interruptTaskTurn, isTaskStopping, turnFinalized, waitForInterrupt } from "./turn-interrupt";
import { closeDescriptors, fileOverCap, pidIdentity, startReAdoptionPoll, type PidIdentity } from "./process-watch";
import { assertGroupEnded, forgetOwnedGroupIfEmpty, ownsGroup, rememberOwnedGroup, signalProcessTree } from "./process-tree";
import { processStartTime } from "./procid";
import {
  createTurn,
  createTaskMessage,
  claimTaskMessageForStart,
  claimTaskMessageForSteering,
  creatingTasks,
  finishTurn,
  getTask,
  getTaskMessage,
  getTurn,
  latestTurnForTask,
  listTasks,
  markTaskMessageDelivered,
  newTaskMessageId,
  nextTurnNumber,
  nextQueuedMessage,
  releaseOrphanedTaskMessageClaims,
  releaseTaskMessageClaim,
  runningTurns,
  runningTurn,
  setTaskFields,
  setTurnInterrupt,
  setTurnKillDetail,
  transition,
  turnForTask,
} from "./store";
import { TurnRecorder } from "./recording/turn-recorder";
import { finalizeTurn } from "./turn-finalize";
import type { SendResult, Task, TaskMessage, Turn } from "./types";

export { startStuckLoop, stuckTick } from "./stuck";
export { finalizeTurn } from "./turn-finalize";
/** Live children by turn id — for interrupts. Re-adopted turns (post-restart) fall back to pid. */
const liveChildren = new Map<number, ReturnType<typeof Bun.spawn>>();
/** Grace period between SIGTERM and SIGKILL escalation (a prior audit). */
const KILL_GRACE_MS = 5000;

export { pidIdentity };
export type { PidIdentity };

/**
 * Mark a turn as user-interrupted; finalize reports "interrupted" over any
 * exit outcome. Persisted on the turn row (a prior audit), not daemon memory,
 * so the intent survives a daemon crash between the kill and the finalize.
 */
export function markInterrupted(turnId: number, detail: string): void {
  setTurnInterrupt(turnId, detail);
}

/** Record why wisp itself killed a turn (e.g. log cap); finalize reports it over any exit code. */
export function recordKillReason(turnId: number, reason: string): void {
  setTurnKillDetail(turnId, reason);
}

export function taskEnv(task: Task): Record<string, string> {
  return {
    WISP_TASK_ID: task.id,
    WISP_TASK_SLOT: String(task.slot),
    WISP_WORKTREE: task.worktree_path ?? "",
    WISP_REPO: task.repo_path,
  };
}

function preamble(task: Task): string {
  return [
    `You are working on task ${task.id}, managed by Wisp, in a dedicated git worktree.`,
    `Worktree: ${task.worktree_path} (branch ${task.branch}). Work ONLY inside this directory.`,
    `When you finish the requested work, commit your changes to this branch with a clear message. Do not push unless asked.`,
    ``,
    `Task:`,
  ].join("\n");
}

function deliveredMessage(def: AdapterDef, attachments: StoredAttachment[], message: string): string {
  if (
    attachments.length === 0 ||
    !def.imageDelivery ||
    def.liveInput === "droid-jsonrpc" ||
    def.liveInput === "codex-app-server"
  ) {
    return message;
  }
  const delivery = IMAGE_DELIVERY_STRATEGIES[def.imageDelivery];
  return delivery ? `${delivery.preamble(attachments.map((attachment) => attachment.path))}\n\n${message}` : message;
}

function inputStrategyFor(
  def: AdapterDef,
  hasImages: boolean,
): ImageInputStrategy | undefined {
  const name = def.liveInput === "claude-stream-json" ? def.liveInput : hasImages ? def.imageInput : undefined;
  return name ? IMAGE_INPUT_STRATEGIES[name] : undefined;
}

interface StartedCapture {
  recorder: TurnRecorder | null;
  sink: LiveOutputSink;
  stderrPump: Promise<void>;
}

function startCapture(
  enabled: boolean,
  turnId: number,
  def: AdapterDef,
  cfg: WispConfig,
  child: ReturnType<typeof Bun.spawn>,
  outFd: number,
  errFd: number,
  attachments: StoredAttachment[],
): StartedCapture {
  if (!enabled) return { recorder: null, sink: legacyLiveOutput(outFd), stderrPump: Promise.resolve() };
  const recorder = new TurnRecorder(turnId, def, cfg, outFd, errFd);
  if (attachments.length > 0) recorder.recordNote(formatAttachNote(attachments));
  return { recorder, sink: recorder, stderrPump: recorder.drain(child.stderr, "stderr") };
}

/**
 * Spawn one harness turn (D7/D20). One-shot output goes fd-direct to the log;
 * a verified live protocol is pumped and normalized while stdin stays open.
 * Either way the pid is persisted for restart reconciliation.
 *
 * SYNC ON PURPOSE (the event-loop safety rule): the only I/O here is
 * spawn-time-cheap — two fd opens, one tiny attach-note write, and one tiny
 * ps/proc read — and the block from spawn through createTurn must not yield
 * the event loop, or two racing `send` requests could both pass
 * hasRunningTurn and spawn two harnesses for the same turn number.
 *
 * `attachments` are this turn's stored image files (S3): they belong to
 * exactly this turn, and one honest `· attached: …` line lands in the log
 * BEFORE any harness output (a plain-text line every adapter's parse skips
 * and the human stream renders). The argv/stdin mechanics of getting them to
 * the harness are the adapter's image/imageInput fields (buildArgv owns the
 * argv side).
 */
export function startTurn(
  task: Task,
  message: string,
  def: AdapterDef,
  cfg: WispConfig,
  attachments: StoredAttachment[] = [],
  sourceMessageId?: string,
): void {
  assertTaskNotStopping(task.id);
  const n = task.turn_count + 1;
  // A1c: a delivery adapter gets its images by having their paths named in the
  // prompt, so the strategy's sentence goes immediately before the user's
  // message — inside the first turn's task preamble, not in front of it.
  const body = deliveredMessage(def, attachments, message);
  const prompt = n === 1 ? `${preamble(task)}\n${body}` : body;
  const outPath = join(LOG_DIR, `${task.id}-turn${n}.out.log`);
  const errPath = join(LOG_DIR, `${task.id}-turn${n}.err.log`);
  const images = attachments.map((a) => a.path);
  // buildArgv owns the argv side of an image turn (template expansion, or the
  // strategy's extra argv + omitted prompt positional for stdin-envelope turns)
  const argv =
    liveCommand(def) ??
    buildArgv(def, {
      prompt,
      session: task.session_id,
      model: task.model,
      effort: task.effort,
      images,
      live: def.liveInput === "claude-stream-json",
    });
  // A live strategy keeps stdin open for safe-boundary messages. The older
  // attachment-only strategy still writes one envelope and closes immediately.
  const stdinStrategy = inputStrategyFor(def, images.length > 0);
  const isLive = Boolean(def.liveInput);
  const recorderEligible = isLive && hasIncrementalOutcomeReducer(def);
  const outFd = openSync(outPath, "a");
  let errFd: number;
  try {
    errFd = openSync(errPath, "a");
  } catch (error) {
    closeDescriptors([outFd]);
    throw error;
  }
  let child: ReturnType<typeof Bun.spawn>;
  try {
    // Recorder-owned pipes are not drained until after the row/recorder exists,
    // so their note can be written immediately afterward and still lead output.
    if (!recorderEligible && attachments.length > 0) writeSync(outFd, `${formatAttachNote(attachments)}\n`);
    // Fails closed under a fixtures-only launch policy: an ordinary test must
    // not reach the operator's installed harness. The throw lands in the catch
    // below, which is already the "this turn never started" path.
    assertExecutableAllowed(argv, `task ${task.id} turn ${n} harness '${task.harness}'`, task.worktree_path ?? undefined);
    child = Bun.spawn({
      cmd: argv,
      cwd: task.worktree_path!,
      stdout: isLive ? "pipe" : outFd,
      stderr: recorderEligible ? "pipe" : errFd,
      stdin: isLive || stdinStrategy ? "pipe" : "ignore",
      env: { ...process.env, ...taskEnv(task) },
      // Its own process GROUP, so a stop reaches the builds, servers, and
      // sub-agents the harness starts — not just the harness (ENG-03). The
      // pid is unchanged, so `exited`, the persisted pid, and the identity
      // check all still address this process; `-pid` now addresses its tree.
      //
      // The trade this makes deliberately: the harness no longer dies from a
      // signal aimed at the daemon's own group (a Ctrl-C in a foreground
      // `wisp serve`). It keeps running and the next daemon re-adopts the
      // turn, which is the durability model the runner already implements.
      detached: true,
    });
  } catch (e) {
    closeDescriptors([outFd, errFd]);
    const turnId = createTurn(task.id, n, message, null, outPath, null, attachmentManifest(attachments));
    finishTurn(turnId, "failed", null, null);
    setTaskFields(task.id, { turn_count: n });
    transition(task.id, "failed", `spawn failed: ${String(e instanceof Error ? e.message : e).slice(0, 300)}`);
    return;
  }
  // pid + start time = identity (H1): a restarted daemon must be able to tell
  // this process from a stranger that got the same pid. null (child already
  // exited before ps could see it) degrades to bare-liveness re-adoption.
  let turnId: number;
  try {
    turnId = createTurn(
      task.id,
      n,
      message,
      child.pid,
      outPath,
      processStartTime(child.pid),
      // the manifest is written with the turn row, in the same sync block as the
      // spawn: a crash between them would otherwise leave bytes on disk that no
      // turn admits to owning
      attachmentManifest(attachments),
      recorderEligible ? "recorder-v1" : null,
    );
  } catch (error) {
    // No turn row exists for a watcher to reconcile or escalate this child, so
    // this is the only chance to stop it — and the group is what it started.
    killChildTree(child, "SIGKILL");
    closeDescriptors([outFd, errFd]);
    throw error;
  }
  liveChildren.set(turnId, child);
  rememberOwnedGroup(child.pid);
  const capture = startCapture(recorderEligible, turnId, def, cfg, child, outFd, errFd, attachments);
  const { recorder, sink, stderrPump } = capture;
  // stderr must be drained independently of the stdout protocol pump. A noisy
  // stderr can otherwise fill its OS pipe and stall an otherwise healthy turn.
  if (recorder) {
    void stderrPump.catch((error) =>
      failLiveTurn(child, turnId, sink, new LiveTransportError("live output pump", error)));
  }
  let outputPump = Promise.resolve();
  if (isLive) {
    try {
      outputPump = configureLiveTurn({
        child,
        task,
        def,
        turnId,
        turn: n,
        recorder: sink,
        prompt,
        attachments,
        initialMessageId: sourceMessageId ?? `wisp-${task.id}-turn-${n}`,
        claudeStrategy: stdinStrategy,
      });
    } catch (error) {
      failLiveTurn(child, turnId, sink, error);
    }
    void outputPump.catch((error) => failLiveTurn(child, turnId, sink, error));
  }
  if (stdinStrategy && !isLive) writeImageEnvelope(child, stdinStrategy, prompt, attachments);
  setTaskFields(task.id, { turn_count: n });
  transition(task.id, "running", `turn ${n}`);
  void watchTurn(
    child,
    task.id,
    turnId,
    def,
    cfg,
    outPath,
    errPath,
    [outFd, errFd],
    outputPump,
    stderrPump,
    recorder,
  );
}

/** Persist first, then deliver without ever interrupting the active process. */
export async function submitTaskMessage(
  task: Task,
  text: string,
  def: AdapterDef,
  cfg: WispConfig,
  attachments: DecodedAttachment[] = [],
  clientMessageId?: string,
): Promise<SendResult> {
  const currentTask = getTask(task.id);
  if (!currentTask || currentTask.archived) throw new Error("task is archived — archived tasks are read-only");
  if (currentTask.state === "creating") throw new Error("task is still being created");
  assertTaskNotStopping(task.id);
  task = currentTask;
  const id = clientMessageId ?? newTaskMessageId();
  const attachmentHash = taskMessageAttachmentsFingerprint(attachments);
  const existing = getTaskMessage(id);
  let message: TaskMessage;
  if (existing) {
    if (
      existing.task_id !== task.id ||
      existing.text !== text ||
      (existing.attachment_hash !== "" && existing.attachment_hash !== attachmentHash)
    ) {
      throw new Error(`message id ${id} was already used for different content`);
    }
    if (existing.status === "queued" && existing.claim !== null) {
      await pendingDelivery(task.id);
    }
    const current = getTaskMessage(id)!;
    if (current.status === "cancelled") {
      throw new Error(`message id ${id} was cancelled`);
    }
    if (current.status !== "queued") {
      return { disposition: current.delivery ?? "queued-next", message: current };
    }
    message = current;
  } else {
    try {
      // A daemon can die after staging bytes but before inserting the message
      // row. No row owns that directory, so a stable-ID retry must replace it
      // rather than suffixing every filename and changing the manifest.
      removeMessageAttachments(task.id, id);
      const stored = attachments.length > 0 ? writeMessageAttachments(task.id, id, attachments) : [];
      message = createTaskMessage({
        id,
        taskId: task.id,
        text,
        attachmentHash,
        attachmentsJson: attachmentManifest(stored),
      });
    } catch (error) {
      if (!getTaskMessage(id)) removeMessageAttachments(task.id, id);
      throw error;
    }
  }
  try {
    const running = hasRunningTurn(task.id);
    const live = activeLiveInput(task.id);
    if (running && live?.turnId === running.id) {
      const claimed = claimTaskMessageForSteering(message.id, task.id, live.turn);
      if (!claimed) return { disposition: "queued-next", message: getTaskMessage(message.id)! };
      const previous = pendingDelivery(task.id) ?? Promise.resolve();
      const delivery = previous
        .then(() => live.send(claimed))
        .then(() => {
          markTaskMessageDelivered(id, "steered", live.turn);
        })
        .catch((error) => {
          releaseTaskMessageClaim(id, task.id, true);
          console.warn(`[wisp] task ${task.id}: live delivery failed; keeping ${id} queued: ${String(error)}`);
        });
      setPendingDelivery(task.id, delivery);
      await delivery;
      clearPendingDelivery(task.id, delivery);
      const delivered = getTaskMessage(id)!;
      if (delivered.delivery === "steered") return { disposition: "steered", message: delivered };
      return { disposition: "queued-next", message: delivered };
    }
    if (!running) {
      const started = startNextQueuedMessage(task.id, def, cfg);
      if (started?.id === id) return { disposition: "started", message: started };
    }
    return { disposition: "queued-next", message };
  } catch (error) {
    if (!getTaskMessage(id)) removeMessageAttachments(task.id, id);
    throw error;
  }
}

/** Start exactly one FIFO message when a task has no running turn. */
export function startNextQueuedMessage(taskId: string, def: AdapterDef, cfg: WispConfig): TaskMessage | null {
  if (isTaskStopping(taskId)) return null;
  const task = getTask(taskId);
  if (
    !task ||
    task.archived ||
    task.state_detail?.includes("force-archive") ||
    !task.worktree_path ||
    hasRunningTurn(taskId)
  ) {
    return null;
  }
  const message = nextQueuedMessage(taskId);
  if (!message) return null;
  // Recovery may find a legacy/incomplete row whose denormalized turn_count
  // lagged the actual turns table. Never reuse a turn number.
  const turn = nextTurnNumber(taskId, task.turn_count);
  const current = turn === task.turn_count + 1 ? task : { ...task, turn_count: turn - 1 };
  const claimed = claimTaskMessageForStart(message.id, task.id, turn);
  if (!claimed) return null;
  const records = parseAttachmentManifest(message.attachments_json);
  try {
    const attachments = promoteMessageAttachments(taskId, message.id, turn, records);
    startTurn(current, message.text, def, cfg, attachments, message.id);
    if (!turnForTask(taskId, turn)) {
      restoreMessageAttachments(taskId, message.id, turn);
      releaseTaskMessageClaim(message.id, taskId);
      return null;
    }
    return markTaskMessageDelivered(message.id, "started", turn);
  } catch (error) {
    if (!turnForTask(taskId, turn)) restoreMessageAttachments(taskId, message.id, turn);
    releaseTaskMessageClaim(message.id, taskId);
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`[wisp] task ${taskId}: queued message could not start: ${detail}`);
    if (!getTask(taskId)?.archived) {
      transition(taskId, "failed", `queued message could not start: ${detail}`.slice(0, 300));
    }
    return null;
  }
}

async function watchTurn(
  child: ReturnType<typeof Bun.spawn>,
  taskId: string,
  turnId: number,
  def: AdapterDef,
  cfg: WispConfig,
  outPath: string,
  errPath: string,
  fds: number[],
  outputPump: Promise<void> = Promise.resolve(),
  stderrPump: Promise<void> = Promise.resolve(),
  recorder: TurnRecorder | null = null,
): Promise<void> {
  let capTermAt: number | null = null;
  let capChecking = false;
  const capTick = async (): Promise<void> => {
    if (capChecking) return;
    capChecking = true;
    try {
      const budget = transcriptBudgetBytes(cfg);
      const hit = await fileOverCap([outPath, errPath], budget);
      if (!hit) return;
      if (capTermAt === null) {
        capTermAt = Date.now();
        console.error(`[wisp] task ${taskId}: log cap exceeded (${hit}), killing turn`);
        recordKillReason(turnId, `log cap exceeded (${budget} bytes)`);
        // The whole group, for the same reason the re-adoption poll's cap kill
        // signals one: the harness's own children are what filled this log, and
        // killing only the leader leaves them writing to it (ENG-03). This is
        // the common path — a non-recorder turn owned by THIS daemon.
        killChildTree(child, "SIGTERM");
      } else if (Date.now() - capTermAt >= KILL_GRACE_MS && childRunning(child)) {
        // M3: a harness that traps SIGTERM must not keep the turn alive forever
        console.error(`[wisp] task ${taskId}: turn survived SIGTERM, escalating to SIGKILL`);
        recordKillReason(turnId, `log cap exceeded (${budget} bytes); escalated to SIGKILL after SIGTERM was trapped`);
        killChildTree(child, "SIGKILL");
      }
    } finally {
      capChecking = false;
    }
  };
  // detached tick, same idiom as `void watchTurn`: interval callbacks can't be awaited
  const capTimer = recorder ? null : setInterval(() => void capTick(), 5000);
  const exitCode = await child.exited;
  if (capTimer !== null) clearInterval(capTimer);
  await waitForInterrupt(turnId);
  liveChildren.delete(turnId);
  // The common case: the harness took its children with it, so there is no
  // group left to protect an archive from.
  forgetOwnedGroupIfEmpty(child.pid);
  await closeLiveInput(taskId, turnId);
  await pendingDelivery(taskId)?.catch(() => {});
  await outputPump.catch(() => {});
  await stderrPump.catch(() => {});
  const recorderOutcome = recorder?.finish();
  for (const fd of fds) {
    closeDescriptors([fd]);
  }
  await waitForInterrupt(turnId);
  await finalizeTurn(taskId, turnId, def, exitCode, outPath, errPath, recorderOutcome);
  if (!getTurn(turnId)?.interrupt_detail?.includes("force-archive")) startNextQueuedMessage(taskId, def, cfg);
}

/**
 * Restart reconciliation for turns left 'running' by a previous daemon. Dead
 * or reused pid (identity mismatch, H1) → finalize from the durable log now; a
 * pid validated as OUR process → poll until it exits, then finalize. One-shot
 * children keep writing fd-direct. A duplex child normally exits when its
 * daemon-owned pipes close; any normalized events written before the crash
 * remain available, and queued messages remain in SQLite.
 *
 * Awaited by serve() before the port opens, so a request never observes a
 * half-finished sweep.
 */
export async function recoverOrphanedTurns(adapters: Record<string, AdapterDef>, cfg: WispConfig): Promise<void> {
  releaseOrphanedTaskMessageClaims();
  for (const turn of runningTurns()) {
    const task = getTask(turn.task_id);
    if (!task) continue;
    const def = adapters[task.harness];
    const errPath = turn.log_file.replace(/\.out\.log$/, ".err.log");
    if (!def) {
      finishTurn(turn.id, "failed", null, null);
      transition(task.id, "failed", `unknown harness after restart: ${task.harness}`);
      continue;
    }
    const identity = turn.pid ? await pidIdentity(turn.pid, turn.pid_start_time) : "dead";
    if (identity === "alive") {
      console.error(`[wisp] re-adopted task ${task.id} turn ${turn.n} (pid ${turn.pid} still running)`);
      startReAdoptionPoll({
        pid: turn.pid!,
        pidStartTime: turn.pid_start_time,
        paths: [turn.log_file, errPath],
        maxBytes: turn.capture_mode === "recorder-v1" ? null : transcriptBudgetBytes(cfg),
        killGraceMs: KILL_GRACE_MS,
        onKillReason: (reason) => recordKillReason(turn.id, reason),
        onEnded: async () => {
          await waitForInterrupt(turn.id);
          await finalizeTurn(task.id, turn.id, def, null, turn.log_file, errPath);
          if (!getTurn(turn.id)?.interrupt_detail?.includes("force-archive")) {
            startNextQueuedMessage(task.id, def, cfg);
          }
        },
      });
    } else {
      const why =
        identity === "gone"
          ? `pid ${turn.pid} was reused by another process — never signaling it`
          : "ended while daemon was down";
      console.error(`[wisp] finalizing task ${task.id} turn ${turn.n} (${why})`);
      await waitForInterrupt(turn.id);
      await finalizeTurn(task.id, turn.id, def, null, turn.log_file, errPath);
      if (!getTurn(turn.id)?.interrupt_detail?.includes("force-archive")) {
        startNextQueuedMessage(task.id, def, cfg);
      }
    }
  }
  // Messages survive a daemon restart independently of turn rows. Start any
  // FIFO head that was waiting while the daemon was unavailable.
  for (const task of listTasks()) {
    const def = adapters[task.harness];
    if (def && !hasRunningTurn(task.id)) startNextQueuedMessage(task.id, def, cfg);
  }
}

/**
 * Startup sweep for tasks wedged in 'creating' (a prior audit): the row was
 * inserted but the daemon died before startTurn, and creation runs in-process,
 * so nothing will ever advance it — `send` would 409 "still being created"
 * forever. recoverOrphanedTurns sweeps turns; this sweeps tasks. Always fails loudly.
 */
export function failStaleCreatingTasks(): void {
  for (const task of creatingTasks()) {
    console.error(`[wisp] failing task ${task.id}: still 'creating' at startup (previous daemon died mid-creation)`);
    transition(
      task.id,
      "failed",
      "daemon died while this task was being created (still 'creating' at startup); create a new task to retry",
    );
  }
}

export function hasRunningTurn(taskId: string): Turn | null { return runningTurn(taskId); }

function childRunning(child: ReturnType<typeof Bun.spawn>): boolean {
  return child.exitCode === null && child.signalCode === null;
}

/** Compatibility sink for live transports whose parser is not recorder-capable. */
function legacyLiveOutput(outFd: number): LiveOutputSink {
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

/** Kill a live turn whose transport broke, naming the half that failed (LiveTransportError). */
function failLiveTurn(
  child: ReturnType<typeof Bun.spawn>,
  turnId: number,
  sink: LiveOutputSink,
  error: unknown,
): void {
  if (!childRunning(child)) return;
  const stage = error instanceof LiveTransportError ? error.stage : "live input setup";
  const detail = `${stage} failed: ${error instanceof Error ? error.message : String(error)}`;
  sink.recordNote(`· ${detail}`);
  recordKillReason(turnId, detail);
  killChildTree(child, "SIGTERM");
  const timer = setTimeout(() => childRunning(child) && killChildTree(child, "SIGKILL"), KILL_GRACE_MS);
  timer.unref?.();
  void child.exited.finally(() => clearTimeout(timer));
}

/**
 * Signal a turn's process, preferring the live child handle; no live child =
 * re-adopted turn, fall back to the persisted pid — its poll loop finalizes
 * once the pid dies. Identity-check before every pid signal (H1): a reused
 * pid is not our process.
 */
async function signalTurn(turn: Turn, sig: "SIGTERM" | "SIGKILL"): Promise<void> {
  const child = liveChildren.get(turn.id);
  if (child) {
    killChildTree(child, sig);
  } else if (turn.pid && (await pidIdentity(turn.pid, turn.pid_start_time)) === "alive") {
    // A re-adopted turn: identity-checked above, then the same group-first
    // signal. A turn started before groups were owned leads none, so the
    // group attempt reports `gone` and the pid signal below is what runs.
    signalProcessTree(turn.pid, sig, () => process.kill(turn.pid!, sig));
  }
}

/**
 * Signal a live child's whole group, falling back to the child handle. Bun's
 * `child.kill` is preferred as the fallback because it also keeps the
 * subprocess object's own bookkeeping straight.
 */
function killChildTree(child: ReturnType<typeof Bun.spawn>, sig: "SIGTERM" | "SIGKILL"): void {
  signalProcessTree(child.pid, sig, (signal) => child.kill(signal));
}

/** Explicit interruption; normal message delivery never calls this operation. */
export function interruptTurn(taskId: string, graceMs = KILL_GRACE_MS): Promise<void> {
  return interruptTaskTurn(taskId, graceMs, (turnId) => liveChildren.get(turnId));
}

/**
 * Force-archive support (a prior audit): kill the running turn and wait until
 * its row is finalized, so the worktree is never removed under a live process.
 * SIGTERM first, SIGKILL after a grace period (a harness may trap SIGTERM).
 * Throws if the process refuses to die — the caller must NOT archive then,
 * or the turn row would stay 'running' forever.
 */
export async function killTurnForArchive(taskId: string, graceMs = KILL_GRACE_MS): Promise<void> {
  assertTaskNotStopping(taskId);
  const turn = hasRunningTurn(taskId);
  if (!turn) {
    // No LIVE turn is not the same as nothing running. A harness that exited
    // without waiting for something it started leaves that process in the
    // turn's group, and this is the gate in front of deleting the worktree it
    // is sitting in — the early return here used to let archive proceed (a
    // review asked for the missing test and the test found the hole).
    const latest = latestTurnForTask(taskId);
    if (latest?.pid && ownsGroup(latest.pid)) await assertGroupEnded(latest.pid, `turn ${latest.n}`, graceMs);
    return;
  }
  markInterrupted(turn.id, "turn interrupted by force-archive");
  await closeLiveInput(taskId, turn.id);
  await signalTurn(turn, "SIGTERM");
  // wait on the turn ROW, not the process: finalize must have run before archive proceeds
  if (!(await turnFinalized(turn.id, graceMs))) {
    markInterrupted(turn.id, "turn interrupted by force-archive (escalated to SIGKILL after SIGTERM was trapped)");
    await signalTurn(turn, "SIGKILL");
    // re-adopted turns are finalized by a 3s poll, so allow at least one full tick
    if (!(await turnFinalized(turn.id, Math.max(graceMs, 4000)))) {
      throw new Error(`turn ${turn.n} (pid ${turn.pid ?? "unknown"}) survived SIGKILL; refusing to archive`);
    }
  }
  if (turn.pid) await assertGroupEnded(turn.pid, `turn ${turn.n}`, graceMs);
}
