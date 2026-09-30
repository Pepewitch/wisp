import { assertTaskCapacity } from "./task-admission";
import { pauseTaskWorkflows } from "./workflows/store";
import { backgroundPass, homeIsDraining } from "./home-lifetime";
import { openSync, writeSync } from "node:fs";
import { join } from "node:path";
import {
  buildArgv,
  hasIncrementalOutcomeReducer,
  type AdapterDef,
} from "./adapters";
import {
  attachmentManifest,
  formatAttachNote,
  parseAttachmentManifest,
  promoteMessageAttachments,
  restoreMessageAttachments,
  type DecodedAttachment,
  type StoredAttachment,
} from "./attachments";
import { LOG_DIR, transcriptBudgetBytes, type WispConfig } from "./config";
import {
  closeLiveInput,
  configureLiveTurn,
  legacyLiveOutput,
  liveClaudeProcess,
  liveCommand,
  LiveTransportError,
  writeImageEnvelope,
  type LiveOutputSink,
} from "./live-input";
import { assertExecutableAllowed } from "./launch-policy";
import { assertTaskNotStopping, interruptForMessage, interruptTaskTurn, isTaskStopping, turnFinalized, waitForInterrupt } from "./turn-interrupt";
import { assertTaskProcessesEnded, backgroundWork, processStop, processStopPending, recordProcessGroup, recordedGroupRebooted, refreshProcessGroups, stopRecordedGroups, withProcessStop } from "./task-processes";
import { closeDescriptors, pidIdentity, startReAdoptionPoll, type PidIdentity } from "./process-watch";
import { signalProcessTree } from "./process-tree";
import { processStartTime } from "./procid";
import {
  db,
  createTurn,
  claimTaskMessageForStart,
  creatingTasks,
  getTask,
  getTaskContext,
  getTaskMessage,
  listTasks,
  markTaskMessageDelivered,
  nextTurnNumber,
  nextQueuedMessage,
  releaseOrphanedTaskMessageClaims,
  releaseTaskMessageClaim,
  releaseTaskMessageHold,
  runningTurns,
  runningTurn,
  setTaskFields,
  setTurnInterrupt,
  setTurnKillDetail,
  settleTurn,
  transition,
  turnForTask,
  type TaskAgentSelection,
} from "./store";
import { recordAudit } from "./task-audit";
import { drainLines, TurnRecorder } from "./recording/turn-recorder";
import {
  agentOf,
  adoptable,
  adoptTurn,
  endLingeringProcess,
  failLiveTurn,
  followingSink,
  killChildTree,
  KILL_GRACE_MS,
  lingerHooks,
  lingeringProcess,
  liveChildren,
  FORCE_ARCHIVE_DETAIL,
  FORCE_ARCHIVE_ESCALATED_DETAIL,
  killedForArchive,
  sameAgent,
  stopOrphanedHarnesses,
  turnProcesses,
  watchTurn,
  type TurnProcess,
  type TurnSlot,
} from "./turn-process";
import { isTaskMerging } from "./autopilot/merging";
import { autopilotTurnNotes, noteTurnSigning, type TurnNotes } from "./autopilot/store";
import { deliverToRunningTurn, persistTaskSubmission } from "./task-submit";
import { finalizeTurn } from "./turn-finalize";
import { pendingBriefRun, recordBriefRun } from "./brief-store";
import { markPendingAnswersUncertain } from "./brief-inputs";
import {
  AGENT_TURN_ENV,
  BRIEF_RUN_ENV,
  briefReminder,
  attachmentLines,
  envForCwd,
  framedMessage,
  inputStrategyFor,
  nativeImageAttachments,
  taskEnv,
  taskPreambleLines,
  withWispSection,
} from "./turn-input";
import type { SendResult, Task, TaskMessage, Turn } from "./types";

export { startStuckLoop, stuckTick } from "./stuck";
export { finalizeTurn } from "./turn-finalize";
export { taskEnv } from "./turn-input";
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
  stderrTo?: () => LiveOutputSink,
): StartedCapture {
  if (!enabled) return { recorder: null, sink: legacyLiveOutput(outFd), stderrPump: Promise.resolve() };
  const recorder = new TurnRecorder(turnId, def, cfg, outFd, errFd);
  if (attachments.length > 0) recorder.recordNote(formatAttachNote(attachments));
  return { recorder, sink: recorder, stderrPump: drainLines(child.stderr, "stderr", stderrTo ? followingSink(stderrTo) : recorder) };
}

/** Who wrote a queued message, for its framing at delivery (turn-input framedMessage); a direct turn is the person's. */
function messageOrigin(sourceMessageId: string | undefined) {
  return sourceMessageId ? getTaskMessage(sourceMessageId)?.origin : undefined;
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
 * `attachments` are this turn's stored files (S3/A1d): they belong to
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
  adapters: Readonly<Record<string, AdapterDef>> = { [task.harness]: def },
): void {
  assertTaskNotStopping(task.id);
  assertTaskCapacity(cfg, task.id);
  const n = task.turn_count + 1;
  // A1c/A1d: what wisp cannot hand over through a native channel is named in
  // the prompt, beside the task preamble and the notes, as ONE Wisp section
  // before the person's words.
  const attached = attachmentLines(def, attachments);
  // Wisp's own standing instructions travel with the harness input, like the
  // task preamble, and are not written into the user's message. Auto-merge
  // needs one: arming it IS asking for a push, which the preamble forbids.
  // Never in front of a later turn's slash command — a harness only treats the
  // prompt as a command when it STARTS with `/` — so it waits for a plain turn.
  const command = n > 1 && message.trimStart().startsWith("/");
  // A Claude process still alive for background work it started takes this
  // turn itself: a second process would split its session, and ending it
  // would kill the work it was kept for.
  const lingering = lingeringProcess(task);
  const autopilot = standingNotes(task.id, n, command);
  // A task brief is asked for once per eligible turn, through this same
  // standing-note path: never in the user's message, never on a steer, and
  // never in front of a command. Its binding is chosen now, before the spawn,
  // because the turn row it names does not exist until after it. A reused
  // process keeps the environment it was spawned with, so it cannot carry a
  // new binding; the brief waits for the next spawned turn.
  const brief = lingering ? null : pendingBriefRun(task.id, def, command);
  const notes = [...(autopilot?.notes ?? []), ...(brief ? [briefReminder()] : [])];
  const framed = framedMessage(messageOrigin(sourceMessageId), message);
  const prompt = withWispSection([...(n === 1 ? taskPreambleLines(task) : []), ...notes, ...framed.lines, ...attached], framed.words);
  if (lingering) {
    adoptTurn(lingering, task, n, message, prompt, attachments, autopilot, sourceMessageId);
    return;
  }
  const outPath = join(LOG_DIR, `${task.id}-turn${n}.out.log`);
  const errPath = join(LOG_DIR, `${task.id}-turn${n}.err.log`);
  // Only IMAGES have an argv/stdin channel; pdf, text and video reached the
  // harness through the attached-files note in the prompt, and would
  // fail inside the harness if they went into codex's `-i` (A1d).
  const images = nativeImageAttachments(def, attachments).map((a) => a.path);
  // buildArgv owns the argv side of an image turn (template expansion, or the
  // strategy's extra argv + omitted prompt positional for stdin-envelope turns)
  const argv =
    liveCommand(def) ??
    buildArgv(def, {
      prompt,
      session: task.session_id,
      model: task.model,
      effort: task.effort,
      fast: task.fast === 1,
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
      env: {
        ...envForCwd({ ...process.env, ...taskEnv(task) }, task.worktree_path!),
        // only this turn's own bindings: envForCwd has already dropped any inherited ones
        [AGENT_TURN_ENV]: "1",
        ...(brief ? { [BRIEF_RUN_ENV]: brief.runId } : {}),
      },
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
    const turnId = createTurn(
      task.id,
      n,
      message,
      null,
      outPath,
      null,
      attachmentManifest(attachments),
      null,
      { context_n: task.context_n, harness: task.harness, model: task.model, effort: task.effort, fast: task.fast === 1 },
    );
    setTaskFields(task.id, { turn_count: n });
    settleTurn(
      turnId,
      { status: "failed", exitCode: null, result: null },
      task.id,
      "failed",
      `spawn failed: ${String(e instanceof Error ? e.message : e).slice(0, 300)}`,
    );
    return;
  }
  autopilot?.delivered();
  // pid + start time = identity (H1): a restarted daemon must be able to tell
  // this process from a stranger that got the same pid. null (child already
  // exited before ps could see it) degrades to bare-liveness re-adoption.
  let turnId: number;
  const pidStartTime = processStartTime(child.pid);
  try {
    turnId = db.transaction(() => {
      const id = createTurn(
        task.id,
        n,
        message,
        child.pid,
        outPath,
        pidStartTime,
        // the manifest is written with the turn row, in the same sync block as the
        // spawn: a crash between them would otherwise leave bytes on disk that no
        // turn admits to owning
        attachmentManifest(attachments),
        recorderEligible ? "recorder-v1" : null,
        { context_n: task.context_n, harness: task.harness, model: task.model, effort: task.effort, fast: task.fast === 1 },
      );
      recordProcessGroup(id);
      // same transaction as the turn row: no request can see one without the other
      if (brief) recordBriefRun(brief, { taskId: task.id, turnId: id, n, contextN: task.context_n }, cfg.instanceId);
      return id;
    })();
  } catch (error) {
    // No turn row exists for a watcher to reconcile or escalate this child, so
    // this is the only chance to stop it — and the group is what it started.
    killChildTree(child, "SIGKILL");
    closeDescriptors([outFd, errFd]);
    throw error;
  }
  liveChildren.set(turnId, child);
  const slot: TurnSlot = { turnId, n, outPath, errPath, fds: [outFd, errFd], recorder: null, sink: legacyLiveOutput(outFd) };
  const proc: TurnProcess = {
    taskId: task.id, child, def, cfg, agent: agentOf(task), pidStartTime, slot, settled: false, ending: false,
    startQueue: () => void startNextQueuedMessage(task.id, adapters, cfg),
  };
  const { outputPump, stderrPump } = attachCapture(proc, task, {
    recorderEligible,
    attachments,
    prompt,
    initialMessageId: sourceMessageId ?? `wisp-${task.id}-turn-${n}`,
    claudeStrategy: isLive ? stdinStrategy : undefined,
  });
  if (stdinStrategy && !isLive) writeImageEnvelope(child, stdinStrategy, def, prompt, attachments);
  setTaskFields(task.id, { turn_count: n });
  transition(task.id, "running", `turn ${n}`);
  // Detached: the turn settles on its own. A watcher that fails must still
  // leave a trace, and must never reject unhandled. Recoverable: a daemon
  // that is exiting leaves the harness running for boot recovery to re-adopt.
  void backgroundPass(`turn watcher for task ${task.id} turn ${n}`, () => watchTurn(proc, outputPump, stderrPump), { recoverable: true });
}

/**
 * Capture a freshly spawned process's output and, for a live harness, start
 * its protocol. Only a recorder-captured Claude turn can outlive its answer:
 * its process stays for the background work it started and takes the next
 * turn, so its stderr follows it from turn to turn.
 */
function attachCapture(
  proc: TurnProcess,
  task: Task,
  input: {
    recorderEligible: boolean;
    attachments: StoredAttachment[];
    prompt: string;
    initialMessageId: string;
    claudeStrategy: ReturnType<typeof inputStrategyFor>;
  },
): { outputPump: Promise<void>; stderrPump: Promise<void> } {
  const { child, def, cfg, slot } = proc;
  const isLive = Boolean(def.liveInput);
  const lingers = def.liveInput === "claude-stream-json" && input.recorderEligible;
  const stderrTo = lingers ? () => proc.claude?.output() ?? proc.slot.sink : undefined;
  const capture = startCapture(input.recorderEligible, slot.turnId, def, cfg, child, slot.fds[0]!, slot.fds[1]!, input.attachments, stderrTo);
  const { recorder, sink, stderrPump } = capture;
  slot.recorder = recorder;
  slot.sink = sink;
  // stderr must be drained independently of the stdout protocol pump. A noisy
  // stderr can otherwise fill its OS pipe and stall an otherwise healthy turn.
  // A failure is the turn's the process is serving when it happens.
  if (recorder) {
    void stderrPump.catch((error) =>
      failLiveTurn(child, proc.slot.turnId, proc.slot.sink, new LiveTransportError("live output pump", error)));
  }
  let outputPump = Promise.resolve();
  if (!isLive) return { outputPump, stderrPump };
  try {
    outputPump = configureLiveTurn({
      child,
      task,
      def,
      turnId: slot.turnId,
      turn: slot.n,
      recorder: sink,
      prompt: input.prompt,
      attachments: input.attachments,
      initialMessageId: input.initialMessageId,
      claudeStrategy: input.claudeStrategy,
      linger: lingers ? lingerHooks(proc) : undefined,
    });
    // Every Claude process has its protocol side, which the exit watcher
    // forgets; only one with the hooks can outlive a turn and take the next.
    if (def.liveInput === "claude-stream-json") proc.claude = liveClaudeProcess(task.id);
    if (lingers) turnProcesses.set(task.id, proc);
  } catch (error) {
    failLiveTurn(child, slot.turnId, sink, error);
  }
  void outputPump.catch((error) => failLiveTurn(child, proc.slot.turnId, proc.slot.sink, error));
  return { outputPump, stderrPump };
}

/**
 * How a submission may reach the agent. `allow-steer` steers when it can and
 * otherwise waits for the next turn; `next-turn-only` never steers (a native
 * compaction); `hold` also never steers and lets later unheld messages go
 * first; `now` steers when it can and otherwise stops the running turn so the
 * message starts, unless that turn is already ending on its own.
 */
export type DeliveryPolicy = "allow-steer" | "next-turn-only" | "hold" | "now";

/** Persist first, then deliver; only the `now` policy ever interrupts the active process. */
export async function submitTaskMessage(
  task: Task,
  text: string,
  def: AdapterDef,
  cfg: WispConfig,
  attachments: DecodedAttachment[] = [],
  clientMessageId?: string,
  adapters: Readonly<Record<string, AdapterDef>> = { [task.harness]: def },
  agent?: TaskAgentSelection,
  deliveryPolicy: DeliveryPolicy = "allow-steer",
): Promise<SendResult> {
  const currentTask = getTask(task.id);
  if (!currentTask || currentTask.archived) throw new Error("task is archived — archived tasks are read-only");
  if (currentTask.state === "creating") throw new Error("task is still being created");
  assertTaskNotStopping(task.id);
  task = currentTask;
  const existing = clientMessageId ? getTaskMessage(clientMessageId) : null;
  if (!existing) assertTaskCapacity(cfg, task.id);
  const persisted = await persistTaskSubmission(task, text, attachments, clientMessageId, agent, deliveryPolicy === "hold");
  task = persisted.task;
  const message = persisted.message;
  if (message.status !== "queued") {
    return { disposition: message.delivery ?? "queued-next", message };
  }
  assertTaskCapacity(cfg, task.id);
  // Prompt-based compaction is admitted only while idle. The HTTP route
  // refuses the ordinary active case before persistence; this second guard
  // closes the concurrency window without ever delivering the command as a
  // live steer. A request that loses that race remains durably next in line.
  if (deliveryPolicy === "next-turn-only" && hasRunningTurn(task.id)) {
    return { disposition: "queued-next", message };
  }
  return deliverQueuedMessage(task, message, adapters, cfg, deliveryPolicy === "now");
}

/**
 * Deliver a queued message the person now wants sent without waiting: lift
 * its next-turn hold, then steer it, or stop a turn that cannot take it.
 */
export async function sendQueuedMessageNow(
  taskId: string,
  messageId: string,
  adapters: Readonly<Record<string, AdapterDef>>,
  cfg: WispConfig,
): Promise<SendResult | null> {
  const task = getTask(taskId);
  if (!task || task.archived) throw new Error("task is archived — archived tasks are read-only");
  assertTaskNotStopping(taskId);
  const message = releaseTaskMessageHold(messageId, taskId);
  if (!message) return null;
  return deliverQueuedMessage(task, message, adapters, cfg, true);
}

async function deliverQueuedMessage(
  task: Task,
  message: TaskMessage,
  adapters: Readonly<Record<string, AdapterDef>>,
  cfg: WispConfig,
  interrupt: boolean,
): Promise<SendResult> {
  const delivery = await deliverToRunningTurn(task, message);
  if (delivery.result) return delivery.result;
  const interrupted =
    delivery.running && interrupt && (await interruptForMessage(task.id, message.id, KILL_GRACE_MS, (id) => liveChildren.get(id)));
  if (!delivery.running || interrupted) {
    const started = startNextQueuedMessage(task.id, adapters, cfg);
    const current = started?.id === message.id ? started : getTaskMessage(message.id)!;
    // the interrupted turn's own watcher may have started it first
    if (current.delivery === "started") return { disposition: "started", message: current, ...(interrupted ? { interrupted } : {}) };
    warnIfNothingWillRun(task.id, message.id, started);
    return { disposition: "queued-next", message: current, ...(interrupted ? { interrupted } : {}) };
  }
  return { disposition: "queued-next", message };
}

/**
 * "queued for the next turn" with no next turn coming is a wedge, and the
 * client cannot tell the two apart. Say so in the daemon log — but only for
 * the real thing, never for the ordinary FIFO case where an older message
 * took the turn.
 */
function warnIfNothingWillRun(taskId: string, messageId: string, started: TaskMessage | null): void {
  if (started || hasRunningTurn(taskId) || turnProcesses.has(taskId)) return;
  console.warn(`[wisp] task ${taskId}: message ${messageId} stays queued with no turn running`);
}

/**
 * Start exactly one FIFO message when a task has no running turn.
 *
 * Force-archive is judged on the killed TURN, never on the task's
 * `state_detail`: that field also carries the harness's own last words, so a
 * task whose summary happened to discuss archiving would wedge its queue
 * forever. Archive flips `archived` before teardown kills anything, so the
 * archived check already closes that window.
 */
export function startNextQueuedMessage(
  taskId: string,
  adapters: Readonly<Record<string, AdapterDef>>,
  cfg: WispConfig,
  workflowMessageId = "",
): TaskMessage | null {
  if (homeIsDraining()) return null;
  // A merge in flight holds new turns back: one could push onto the branch
  // being merged. The guard's release starts whatever queued meanwhile.
  if (isTaskStopping(taskId) || processStopPending(taskId) || isTaskMerging(taskId)) return null;
  const task = getTask(taskId);
  if (!task || task.archived || !task.worktree_path || hasRunningTurn(taskId)) {
    return null;
  }
  const message = nextQueuedMessage(taskId, workflowMessageId);
  if (!message) return null;
  const def = adapters[message.harness];
  if (!def) {
    transition(taskId, "failed", `queued message names unknown harness: ${message.harness}`);
    return null;
  }
  const context = getTaskContext(taskId, message.context_n);
  if (!context) {
    transition(taskId, "failed", `queued message names missing context ${message.context_n}`);
    return null;
  }
  // Recovery may find a legacy/incomplete row whose denormalized turn_count
  // lagged the actual turns table. Never reuse a turn number.
  const turn = nextTurnNumber(taskId, task.turn_count);
  const lingering = turnProcesses.get(taskId);
  if (lingering) {
    // Still settling its last answer, or exited and not yet let go by its
    // watcher: either one starts the queue itself when it is done.
    if (!adoptable(lingering)) return null;
    const agent = { context_n: message.context_n, harness: message.harness, model: message.model, effort: message.effort, fast: message.fast === 1 };
    if (!sameAgent(lingering.agent, agent)) {
      endLingeringProcess(lingering, `turn ${turn} asks for another agent`);
      return null;
    }
  }
  const current: Task = {
    ...task,
    turn_count: turn - 1,
    context_n: message.context_n,
    harness: message.harness,
    model: message.model,
    effort: message.effort,
    fast: message.fast,
    session_id: context.session_id,
    skills_json: context.skills_json,
  };
  const claimed = claimTaskMessageForStart(message.id, task.id, turn);
  if (!claimed) return null;
  const records = parseAttachmentManifest(message.attachments_json);
  try {
    const attachments = promoteMessageAttachments(taskId, message.id, turn, records);
    startTurn(current, message.text, def, cfg, attachments, message.id, adapters);
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
  await refreshProcessGroups();
  // before any queued message can start a turn beside one of them
  await stopOrphanedHarnesses();
  releaseOrphanedTaskMessageClaims();
  // an answer recorded but not settled before the crash may or may not have arrived
  markPendingAnswersUncertain();
  for (const turn of runningTurns()) {
    const task = getTask(turn.task_id);
    if (!task) continue;
    const def = adapters[turn.harness];
    const errPath = turn.log_file.replace(/\.out\.log$/, ".err.log");
    if (!def) {
      settleTurn(turn.id, { status: "failed", exitCode: null, result: null }, task.id, "failed", `unknown harness after restart: ${turn.harness}`);
      continue;
    }
    const identity = turn.pid && !recordedGroupRebooted(turn.id)
      ? await pidIdentity(turn.pid, turn.pid_start_time, turn.started_at)
      : "dead";
    // `unknown` is a process with this pid that could not be proven ours or
    // someone else's. Finalizing would fail a turn that may still be running
    // and let the next send start a second harness in the same worktree, so
    // wait on it like a live one; the poll signals only a verified identity.
    if (identity === "alive" || identity === "unknown") {
      console.error(
        identity === "alive"
          ? `[wisp] re-adopted task ${task.id} turn ${turn.n} (pid ${turn.pid} still running)`
          : `[wisp] re-adopted task ${task.id} turn ${turn.n} (pid ${turn.pid} is running but its identity could not be verified — waiting for it, never signaling it)`,
      );
      startReAdoptionPoll({
        pid: turn.pid!,
        pidStartTime: turn.pid_start_time,
        launchedAt: turn.started_at,
        paths: [turn.log_file, errPath],
        maxBytes: turn.capture_mode === "recorder-v1" ? null : transcriptBudgetBytes(cfg),
        killGraceMs: KILL_GRACE_MS,
        onKillReason: (reason) => recordKillReason(turn.id, reason),
        onEnded: async () => {
          await waitForInterrupt(turn.id);
          await finalizeTurn(task.id, turn.id, def, null, turn.log_file, errPath);
          await processStop(task.id)?.catch(() => {});
          if (!killedForArchive(turn.id)) startNextQueuedMessage(task.id, adapters, cfg);
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
      if (!killedForArchive(turn.id)) startNextQueuedMessage(task.id, adapters, cfg);
    }
  }
  // Messages survive a daemon restart independently of turn rows. Start any
  // FIFO head that was waiting while the daemon was unavailable.
  for (const task of listTasks()) {
    if (!hasRunningTurn(task.id)) startNextQueuedMessage(task.id, adapters, cfg);
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
    transition(task.id, "failed", "daemon died while this task was being created (still 'creating' at startup); create a new task to retry");
    recordAudit(task.id, "fail", "system", "still being created when the daemon started");
  }
}

export function hasRunningTurn(taskId: string): Turn | null { return runningTurn(taskId); }

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
  } else if (turn.pid && (await pidIdentity(turn.pid, turn.pid_start_time, turn.started_at)) === "alive") {
    // A re-adopted turn: identity-checked above, then the same group-first
    // signal. A turn started before groups were owned leads none, so the
    // group attempt reports `gone` and the pid signal below is what runs.
    signalProcessTree(turn.pid, sig, () => process.kill(turn.pid!, sig));
  }
}

/**
 * Autopilot's standing notes for turn `n`; none in front of a slash command.
 * Auto-fix tells the agent's GitHub posts by their signature, so a turn never
 * asked to sign is remembered.
 */
function standingNotes(taskId: string, n: number, command: boolean): TurnNotes | null {
  const notes = command ? null : autopilotTurnNotes(taskId);
  noteTurnSigning(taskId, n, notes?.marked === true);
  return notes;
}

/** Explicit Stop. A `now` send that has to stop a turn uses interruptForMessage, which keeps workflows and background work. */
export function interruptTurn(taskId: string, graceMs = KILL_GRACE_MS): Promise<void> {
  pauseTaskWorkflows(taskId);
  const hadBackground = backgroundWork(taskId).groups > 0;
  return withProcessStop(taskId, async () => {
    await refreshProcessGroups(taskId);
    if (hasRunningTurn(taskId) || isTaskStopping(taskId)) {
      await interruptTaskTurn(taskId, graceMs, (turnId) => liveChildren.get(turnId));
    } else if (!hadBackground && backgroundWork(taskId).groups === 0) {
      throw new Error("no running turn or background work to interrupt");
    }
    await stopRecordedGroups(taskId, graceMs);
  });
}

/**
 * Force-archive support (a prior audit): kill the running turn and wait until
 * its row is finalized, so the worktree is never removed under a live process.
 * SIGTERM first, SIGKILL after a grace period (a harness may trap SIGTERM).
 * Throws if the process refuses to die — the caller must NOT archive then,
 * or the turn row would stay 'running' forever.
 */
export async function killTurnForArchive(taskId: string, graceMs = KILL_GRACE_MS): Promise<void> {
  assertTaskNotStopping(taskId, true);
  const turn = hasRunningTurn(taskId);
  if (!turn) {
    // No LIVE turn is not the same as nothing running. A harness that exited
    // without waiting for something it started leaves that process in the
    // turn's group, and this is the gate in front of deleting the worktree it
    // is sitting in — the early return here used to let archive proceed (a
    // review asked for the missing test and the test found the hole).
    await stopRecordedGroups(taskId, graceMs);
    await assertTaskProcessesEnded(taskId);
    return;
  }
  // Nothing below may run on a pid that cannot be proven ours: it would signal
  // nothing, then mark a turn that is still running as killed for archive.
  if (!liveChildren.has(turn.id) && turn.pid &&
    (await pidIdentity(turn.pid, turn.pid_start_time, turn.started_at)) === "unknown") {
    throw new Error(`could not verify pid ${turn.pid} is still turn ${turn.n}'s process; refusing to archive`);
  }
  markInterrupted(turn.id, FORCE_ARCHIVE_DETAIL);
  await closeLiveInput(taskId, turn.id);
  await signalTurn(turn, "SIGTERM");
  // wait on the turn ROW, not the process: finalize must have run before archive proceeds
  if (!(await turnFinalized(turn.id, graceMs))) {
    markInterrupted(turn.id, FORCE_ARCHIVE_ESCALATED_DETAIL);
    await signalTurn(turn, "SIGKILL");
    // re-adopted turns are finalized by a 3s poll, so allow at least one full tick
    if (!(await turnFinalized(turn.id, Math.max(graceMs, 4000)))) {
      throw new Error(`turn ${turn.n} (pid ${turn.pid ?? "unknown"}) survived SIGKILL; refusing to archive`);
    }
  }
  await stopRecordedGroups(taskId, graceMs);
  await assertTaskProcessesEnded(taskId);
}
