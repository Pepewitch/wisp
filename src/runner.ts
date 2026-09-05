import { openSync, writeSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  buildArgv,
  errorDetail,
  IMAGE_DELIVERY_STRATEGIES,
  IMAGE_INPUT_STRATEGIES,
  isLimitError,
  isTransientError,
  parseOutput,
  type AdapterDef,
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
import { LOG_DIR, type WispConfig } from "./config";
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
} from "./live-input";
import { closeDescriptors, fileOverCap, pidIdentity, startReAdoptionPoll, type PidIdentity } from "./process-watch";
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
  setTurnModel,
  setTurnUsage,
  transition,
  turnForTask,
} from "./store";
import { summarize } from "./text";
import type { SendResult, Task, TaskMessage, Turn } from "./types";

export { startStuckLoop, stuckTick } from "./stuck";
/** Live children by turn id — for interrupts. Re-adopted turns (post-restart) fall back to pid. */
const liveChildren = new Map<number, ReturnType<typeof Bun.spawn>>();
/** Why wisp itself killed a turn (e.g. log cap) — surfaced in state_detail. */
const killReasons = new Map<number, string>();

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
  killReasons.set(turnId, reason);
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

/** Async (M1): logs can be multi-MB even capped, and finalize runs on the daemon's only thread. */
async function safeRead(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
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
  const n = task.turn_count + 1;
  // A1c: a delivery adapter gets its images by having their paths named in the
  // prompt, so the strategy's sentence goes immediately before the user's
  // message — inside the first turn's task preamble, not in front of it.
  const delivery =
    attachments.length > 0 &&
    def.imageDelivery &&
    def.liveInput !== "droid-jsonrpc" &&
    def.liveInput !== "codex-app-server"
      ? IMAGE_DELIVERY_STRATEGIES[def.imageDelivery]
      : undefined;
  const body = delivery ? `${delivery.preamble(attachments.map((a) => a.path))}\n\n${message}` : message;
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
  const inputStrategyName =
    def.liveInput === "claude-stream-json"
      ? def.liveInput
      : images.length > 0
        ? def.imageInput
        : undefined;
  const stdinStrategy = inputStrategyName ? IMAGE_INPUT_STRATEGIES[inputStrategyName] : undefined;
  const isLive = Boolean(def.liveInput);
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
    // the attach note precedes harness output on the same fd, so ordering is guaranteed
    if (attachments.length > 0) writeSync(outFd, `${formatAttachNote(attachments)}\n`);
    child = Bun.spawn({
      cmd: argv,
      cwd: task.worktree_path!,
      stdout: isLive ? "pipe" : outFd,
      stderr: errFd,
      stdin: isLive || stdinStrategy ? "pipe" : "ignore",
      env: { ...process.env, ...taskEnv(task) },
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
    );
  } catch (error) {
    // No turn row exists for a watcher to reconcile or escalate this child.
    child.kill("SIGKILL");
    closeDescriptors([outFd, errFd]);
    throw error;
  }
  liveChildren.set(turnId, child);
  let outputPump = Promise.resolve();
  if (isLive) {
    try {
      outputPump = configureLiveTurn({
        child,
        task,
        def,
        turnId,
        turn: n,
        outFd,
        prompt,
        attachments,
        initialMessageId: sourceMessageId ?? `wisp-${task.id}-turn-${n}`,
        claudeStrategy: stdinStrategy,
      });
    } catch (error) {
      failLiveTurn(child, turnId, outFd, error);
    }
    void outputPump.catch((error) => failLiveTurn(child, turnId, outFd, error));
  }
  if (stdinStrategy && !isLive) writeImageEnvelope(child, stdinStrategy, prompt, attachments);
  setTaskFields(task.id, { turn_count: n });
  transition(task.id, "running", `turn ${n}`);
  void watchTurn(child, task.id, turnId, def, cfg, outPath, errPath, [outFd, errFd], outputPump);
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
): Promise<void> {
  let capTermAt: number | null = null;
  let capChecking = false;
  const capTick = async (): Promise<void> => {
    if (capChecking) return;
    capChecking = true;
    try {
      const hit = await fileOverCap([outPath, errPath], cfg.logMaxBytes);
      if (!hit) return;
      if (capTermAt === null) {
        capTermAt = Date.now();
        console.error(`[wisp] task ${taskId}: log cap exceeded (${hit}), killing turn`);
        recordKillReason(turnId, `log cap exceeded (${cfg.logMaxBytes} bytes)`);
        child.kill();
      } else if (Date.now() - capTermAt >= KILL_GRACE_MS && childRunning(child)) {
        // M3: a harness that traps SIGTERM must not keep the turn alive forever
        console.error(`[wisp] task ${taskId}: turn survived SIGTERM, escalating to SIGKILL`);
        recordKillReason(turnId, `log cap exceeded (${cfg.logMaxBytes} bytes); escalated to SIGKILL after SIGTERM was trapped`);
        child.kill("SIGKILL");
      }
    } finally {
      capChecking = false;
    }
  };
  // detached tick, same idiom as `void watchTurn`: interval callbacks can't be awaited
  const capTimer = setInterval(() => void capTick(), 5000);
  const exitCode = await child.exited;
  clearInterval(capTimer);
  liveChildren.delete(turnId);
  await closeLiveInput(taskId, turnId);
  await pendingDelivery(taskId)?.catch(() => {});
  await outputPump.catch(() => {});
  for (const fd of fds) {
    closeDescriptors([fd]);
  }
  await finalizeTurn(taskId, turnId, def, exitCode, outPath, errPath);
  if (!getTurn(turnId)?.interrupt_detail?.includes("force-archive")) startNextQueuedMessage(taskId, def, cfg);
}

export async function finalizeTurn(
  taskId: string,
  turnId: number,
  def: AdapterDef,
  exitCode: number | null,
  outPath: string,
  errPath: string,
): Promise<void> {
  const rawOut = await safeRead(outPath);
  const parsed = parseOutput(def, rawOut);
  if (parsed.session) setTaskFields(taskId, { session_id: parsed.session });
  // the session's skill list (A4, claude's init event; SP2) — refreshed on
  // every turn that announces one, so a CLI upgrade that adds a skill shows
  // up on the next turn without any probe at all
  if (parsed.skills !== null) setTaskFields(taskId, { skills_json: JSON.stringify(parsed.skills) });
  // the model the turn ACTUALLY ran on (P5b), parsed from the harness's own events
  if (parsed.model) setTurnModel(turnId, parsed.model);
  // the harness's own usage report (Theme B), persisted raw — success and
  // failure paths alike: the tokens were spent either way. A field update,
  // not a transition; the freeze holds.
  if (parsed.usage != null) setTurnUsage(turnId, JSON.stringify(parsed.usage));
  // interrupt intent is read from the turn row (M2): a daemon that crashed
  // between the kill and this finalize still reports "interrupted", not "failed"
  const interruptDetail = getTurn(turnId)?.interrupt_detail ?? null;
  const killReason = killReasons.get(turnId);
  killReasons.delete(turnId);
  if (interruptDetail !== null) {
    finishTurn(turnId, "interrupted", exitCode, parsed.result);
    transition(taskId, "needs-input", interruptDetail);
    return;
  }
  // Spawn contract rule 3 (a prior audit): done requires a positive signal. For
  // json adapters that signal is a parsed result payload — bare exit 0 is the
  // orca bug we swore off. allowEmptyResult on the adapter is the explicit
  // opt-out for harnesses that legitimately exit result-less.
  const missingResult = def.parse.format === "json" && !def.allowEmptyResult && parsed.result === null;
  const exitedCleanly = exitCode === 0 || (exitCode === null && parsed.result !== null);
  const succeeded = !killReason && !parsed.isError && exitedCleanly && !missingResult;
  if (succeeded) {
    finishTurn(turnId, "done", exitCode, parsed.result);
    transition(taskId, parsed.needsInput ? "needs-input" : "done", parsed.result ? summarize(parsed.result) : null);
    return;
  }
  await finalizeFailedTurn({
    taskId,
    turnId,
    def,
    exitCode,
    result: parsed.result,
    rawOut,
    errPath,
    killReason,
    reportedFailure: parsed.isError,
    exitedCleanly,
    missingResult,
  });
}

async function finalizeFailedTurn({
  taskId,
  turnId,
  def,
  exitCode,
  result,
  rawOut,
  errPath,
  killReason,
  reportedFailure,
  exitedCleanly,
  missingResult,
}: {
  taskId: string;
  turnId: number;
  def: AdapterDef;
  exitCode: number | null;
  result: string | null;
  rawOut: string;
  errPath: string;
  killReason: string | undefined;
  reportedFailure: boolean;
  exitedCleanly: boolean;
  missingResult: boolean;
}): Promise<void> {
  // stderr alone can't be trusted to name the cause: codex reports turn
  // failures on STDOUT, and droid buries the cause under help text.
  const detail = errorDetail(def, rawOut, await safeRead(errPath));
  const limitPrefix = !killReason && detail !== null && isLimitError(def, detail) ? "limit: " : "";
  const transientPrefix =
    !limitPrefix && !killReason && detail !== null && isTransientError(def, detail) ? "transient: " : "";
  finishTurn(turnId, "failed", exitCode, result);
  const why = killReason
    ? `turn killed: ${killReason}`
    : reportedFailure && exitedCleanly
      ? `turn reported failure${detail ? `: ${detail.slice(0, 300)}` : ""}`
    : exitedCleanly && missingResult
      ? `turn exited 0 but emitted no parseable result — not done (set allowEmptyResult on the adapter if this harness legitimately exits without one)${detail ? `: ${detail.slice(0, 300)}` : ""}`
      : `turn exited ${exitCode === null ? "unknown" : exitCode}${detail ? `: ${detail.slice(0, 300)}` : ""}`;
  transition(taskId, "failed", `${limitPrefix || transientPrefix}${why}`);
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
        maxBytes: cfg.logMaxBytes,
        killGraceMs: KILL_GRACE_MS,
        onKillReason: (reason) => recordKillReason(turn.id, reason),
        onEnded: async () => {
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

/** Kill a live turn whose transport broke, naming the half that failed (LiveTransportError). */
function failLiveTurn(child: ReturnType<typeof Bun.spawn>, turnId: number, outFd: number, error: unknown): void {
  if (!childRunning(child)) return;
  const stage = error instanceof LiveTransportError ? error.stage : "live input setup";
  const detail = `${stage} failed: ${error instanceof Error ? error.message : String(error)}`;
  writeSync(outFd, `· ${detail}\n`);
  recordKillReason(turnId, detail);
  child.kill();
  const timer = setTimeout(() => childRunning(child) && child.kill("SIGKILL"), KILL_GRACE_MS);
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
    child.kill(sig);
  } else if (turn.pid && (await pidIdentity(turn.pid, turn.pid_start_time)) === "alive") {
    try {
      process.kill(turn.pid, sig);
    } catch {
      /* already gone; the watcher finalizes it */
    }
  }
}

/** Wait up to ms for the turn ROW to leave 'running' — i.e. finalize has run. */
async function turnFinalized(turnId: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (getTurn(turnId)?.status !== "running") return true;
    await Bun.sleep(100);
  }
  return getTurn(turnId)?.status !== "running";
}

/**
 * Interrupt the task's running turn: the process is killed, the harness
 * session survives (session ids are salvaged from early stream events), and
 * the next `send` resumes it with a correction. SIGTERM first; a harness that
 * traps SIGTERM gets SIGKILL after graceMs (M3), recorded in the detail.
 */
export async function interruptTurn(taskId: string, graceMs = KILL_GRACE_MS): Promise<void> {
  const turn = hasRunningTurn(taskId);
  if (!turn) throw new Error("no running turn to interrupt");
  const child = liveChildren.get(turn.id);
  if (child) {
    markInterrupted(turn.id, "turn interrupted — session kept, send a correction");
    child.kill();
  } else if (turn.pid) {
    // re-adopted turn from before a daemon restart: the poll loop will finalize
    // it. Signal only a validated identity (H1) — a reused pid is a stranger.
    if ((await pidIdentity(turn.pid, turn.pid_start_time)) !== "alive") {
      throw new Error(`turn process (pid ${turn.pid}) is already gone; it will finalize shortly`);
    }
    markInterrupted(turn.id, "turn interrupted — session kept, send a correction");
    try {
      process.kill(turn.pid, "SIGTERM");
    } catch {
      setTurnInterrupt(turn.id, null); // exited between check and signal — let finalize judge the real outcome
      throw new Error(`turn process (pid ${turn.pid}) is already gone; it will finalize shortly`);
    }
  } else {
    throw new Error("running turn has no pid to signal");
  }
  await escalateIfNotFinalized(
    turn,
    graceMs,
    "turn interrupted (escalated to SIGKILL after SIGTERM was trapped) — session kept, send a correction",
  );
  // A steer follows this request with /send. Do not acknowledge the interrupt
  // while the old row can still make that send lose the hasRunningTurn race.
  // Re-adopted turns finalize on a 3s poll, so leave room for one full tick
  // after an escalation.
  if (await turnFinalized(turn.id, Math.max(graceMs, 4000))) return;
  throw new Error(`turn ${turn.n} (pid ${turn.pid ?? "unknown"}) survived the interrupt`);
}

/** SIGKILL a turn whose row is still 'running' after graceMs, updating its interrupt detail first (M3). */
async function escalateIfNotFinalized(turn: Turn, graceMs: number, detail: string): Promise<void> {
  if (await turnFinalized(turn.id, graceMs)) return;
  markInterrupted(turn.id, detail);
  await signalTurn(turn, "SIGKILL");
}

/**
 * Force-archive support (a prior audit): kill the running turn and wait until
 * its row is finalized, so the worktree is never removed under a live process.
 * SIGTERM first, SIGKILL after a grace period (a harness may trap SIGTERM).
 * Throws if the process refuses to die — the caller must NOT archive then,
 * or the turn row would stay 'running' forever.
 */
export async function killTurnForArchive(taskId: string, graceMs = KILL_GRACE_MS): Promise<void> {
  const turn = hasRunningTurn(taskId);
  if (!turn) return;
  markInterrupted(turn.id, "turn interrupted by force-archive");
  await signalTurn(turn, "SIGTERM");
  // wait on the turn ROW, not the process: finalize must have run before archive proceeds
  if (await turnFinalized(turn.id, graceMs)) return;
  markInterrupted(turn.id, "turn interrupted by force-archive (escalated to SIGKILL after SIGTERM was trapped)");
  await signalTurn(turn, "SIGKILL");
  // re-adopted turns are finalized by a 3s poll, so allow at least one full tick
  if (await turnFinalized(turn.id, Math.max(graceMs, 4000))) return;
  throw new Error(`turn ${turn.n} (pid ${turn.pid ?? "unknown"}) survived SIGKILL; refusing to archive`);
}
