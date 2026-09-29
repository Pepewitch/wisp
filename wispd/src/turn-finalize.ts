import { readFile } from "node:fs/promises";
import {
  createIncrementalOutcomeReducer,
  errorDetail,
  isLimitError,
  isTransientError,
  parseOutput,
  type AdapterDef,
  type ParsedTurn,
} from "./adapters";
import {
  getTurn,
  latestTurnForTask,
  listTasks,
  runningTurn,
  setTaskContextFields,
  setTurnModel,
  setTurnUsage,
  settleTurn,
  transition,
} from "./store";
import { summarize } from "./text";
import { INTERRUPTED, isUnresolvedInterrupt } from "./interrupt-state";
import type { TaskState, Turn } from "./types";
import { indexTurnProse } from "./turn-texts";
import type { RecorderCheckpoint, RecorderOutcome } from "./recording/turn-recorder";

/**
 * Project this turn's prose for search (turn-texts.ts). Derived data: a
 * failure here costs a search hit, never a turn, so it is logged and dropped.
 */
async function indexProse(
  taskId: string,
  turnId: number,
  def: AdapterDef,
  logFile: string,
  result: string | null,
): Promise<void> {
  try {
    await indexTurnProse({ turnId, taskId, logFile, result, def });
  } catch (error) {
    console.error(`[wisp] turn ${turnId} prose index: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function safeRead(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

function emptyFailedOutcome(): ParsedTurn {
  return {
    result: null,
    session: null,
    needsInput: false,
    isError: true,
    model: null,
    usage: null,
    context: null,
    skills: null,
  };
}

function persistOutcomeMetadata(taskId: string, turnId: number, parsed: ParsedTurn): void {
  const turn = getTurn(turnId);
  if (turn) {
    setTaskContextFields(taskId, turn.context_n, {
      ...(parsed.session ? { session_id: parsed.session } : {}),
      ...(parsed.skills !== null ? { skills_json: JSON.stringify(parsed.skills) } : {}),
      // A turn that made no model call (an interrupt, claude's `/compact`
      // before its boundary event) leaves the last known reading standing
      // rather than erasing it — absent is not zero.
      ...(parsed.context ? { context_tokens: parsed.context.usedTokens } : {}),
    });
  }
  if (parsed.model) setTurnModel(turnId, parsed.model);
  if (parsed.usage != null) setTurnUsage(turnId, JSON.stringify(parsed.usage));
}

/** A recovered recorder turn that settled nothing: no result, and no error of the harness's own. */
const ENDED_WITHOUT_RESULT = "the harness ended without a result while Wisp was restarting";

/** The complete lines of `path` from byte `offset` on; "" when there is nothing past it. */
async function linesFrom(path: string, offset: number): Promise<string[]> {
  if (!Number.isSafeInteger(offset) || offset < 0) return [];
  try {
    const file = Bun.file(path);
    if (file.size <= offset) return [];
    const text = await file.slice(offset).text();
    // A line the old daemon never finished writing is not a record.
    const end = text.lastIndexOf("\n");
    return end < 0 ? [] : text.slice(0, end).split("\n");
  } catch {
    return [];
  }
}

/**
 * Rebuild a recorder turn's outcome after a restart: its last checkpoint,
 * plus whatever the primary transcript received after it. Checkpoints are
 * written on a cadence, so a daemon that died between two of them left
 * records only the transcript holds — the session's first event among them,
 * when it died early in the turn. The checkpoint's transcript mark says where
 * those records start; a checkpoint without one (a degraded capture, or one
 * written before the mark existed) is taken as it stands.
 */
async function restoreRecorderOutcome(
  def: AdapterDef,
  raw: string | null,
  outPath: string,
  errPath: string,
): Promise<RecorderOutcome | null> {
  if (!raw) return null;
  let checkpoint: RecorderCheckpoint;
  let reducer: ReturnType<typeof createIncrementalOutcomeReducer>;
  try {
    checkpoint = JSON.parse(raw) as RecorderCheckpoint;
    reducer = createIncrementalOutcomeReducer(def, checkpoint, { maxFactStringBytes: 64 * 1024 });
  } catch {
    return null;
  }
  if (!reducer) return null;
  const mark = checkpoint.transcript;
  if (mark && typeof mark === "object") {
    for (const line of await linesFrom(outPath, mark.stdout)) reducer.pushStdoutLine(line);
    for (const line of await linesFrom(errPath, mark.stderr)) reducer.pushStderrLine(line);
  }
  return {
    parsed: reducer.outcome("recorder-v1"),
    errorDetail: reducer.errorDetail(),
    checkpoint: reducer.checkpoint(),
  };
}

interface FailedTurnFacts {
  taskId: string;
  turnId: number;
  def: AdapterDef;
  exitCode: number | null;
  result: string | null;
  rawOut: string;
  errPath: string;
  recorderDetail: string | null;
  killReason: string | undefined;
  reportedFailure: boolean;
  exitedCleanly: boolean;
  missingResult: boolean;
}

async function finalizeFailedTurn(facts: FailedTurnFacts): Promise<void> {
  const detail = facts.recorderDetail ?? errorDetail(facts.def, facts.rawOut, await safeRead(facts.errPath));
  const limitPrefix = !facts.killReason && detail !== null && isLimitError(facts.def, detail) ? "limit: " : "";
  const transientPrefix =
    !limitPrefix && !facts.killReason && detail !== null && isTransientError(facts.def, detail) ? "transient: " : "";
  const why = facts.killReason
    ? `turn killed: ${facts.killReason}`
    : facts.reportedFailure && facts.exitedCleanly
      ? `turn reported failure${detail ? `: ${detail.slice(0, 300)}` : ""}`
      : facts.exitedCleanly && facts.missingResult
        ? `turn exited 0 but emitted no parseable result — not done (set allowEmptyResult on the adapter if this harness legitimately exits without one)${detail ? `: ${detail.slice(0, 300)}` : ""}`
        : `turn exited ${facts.exitCode === null ? "unknown" : facts.exitCode}${detail ? `: ${detail.slice(0, 300)}` : ""}`;
  settleTurn(
    facts.turnId,
    { status: "failed", exitCode: facts.exitCode, result: facts.result },
    facts.taskId,
    "failed",
    `${limitPrefix || transientPrefix}${why}`,
  );
}

interface InterruptedTurnFacts {
  recorderMode: boolean;
  recorderErrorDetail: string | null;
  parsed: ParsedTurn;
  def: AdapterDef;
  rawOut: string;
  errPath: string;
}

/**
 * Settle an interrupted turn: the stop's own detail, plus the harness's last
 * words when it reported an error of its own (a startup failure, say). Such a
 * turn must not read as "the stop lost work": the user steering a
 * dead-on-arrival turn otherwise waits on a session that can never answer.
 * The harness's words belong here, never Wisp's checkpoint bookkeeping.
 */
async function finalizeInterruptedTurn(
  taskId: string,
  turnId: number,
  exitCode: number | null,
  interruptDetail: string,
  facts: InterruptedTurnFacts,
): Promise<void> {
  // Every read comes first: the turn and its task settle in one transaction.
  const harnessError = !facts.parsed.isError
    ? null
    : facts.recorderMode
      ? facts.recorderErrorDetail
      : errorDetail(facts.def, facts.rawOut, await safeRead(facts.errPath));
  const settled = harnessError
    ? `${interruptDetail}. The harness last reported: ${harnessError.slice(0, 250)}`
    : interruptDetail;
  // Leader finalization must not turn an incomplete Stop into permission to
  // resume. Keep the retry control visible, including after restart.
  settleTurn(
    turnId,
    { status: "interrupted", exitCode, result: facts.parsed.result },
    taskId,
    isUnresolvedInterrupt(interruptDetail) ? "stuck" : "needs-input",
    settled,
  );
}

/** Finalize from a recorder checkpoint, or from whole files for a durable legacy turn. */
export async function finalizeTurn(
  taskId: string,
  turnId: number,
  def: AdapterDef,
  exitCode: number | null,
  outPath: string,
  errPath: string,
  liveRecorderOutcome?: RecorderOutcome,
): Promise<void> {
  const turn = getTurn(turnId);
  const recorderMode = turn?.capture_mode === "recorder-v1";
  let rawOut = "";
  let recorderDetail: string | null = null;
  /** The harness's own error words from the checkpoint, if it reported any. */
  let recorderErrorDetail: string | null = null;
  let parsed: ParsedTurn;
  if (recorderMode) {
    const restored = liveRecorderOutcome ?? await restoreRecorderOutcome(def, turn?.outcome_json ?? null, outPath, errPath);
    parsed = restored?.parsed ?? emptyFailedOutcome();
    recorderErrorDetail = restored?.errorDetail ?? null;
    recorderDetail = restored
      // A checkpoint that restored cleanly but names no error is not "unreadable".
      ? restored.errorDetail ?? (liveRecorderOutcome ? null : ENDED_WITHOUT_RESULT)
      : turn?.outcome_json ? "outcome checkpoint is unreadable" : "outcome checkpoint is unavailable";
  } else {
    rawOut = await safeRead(outPath);
    parsed = parseOutput(def, rawOut);
  }

  persistOutcomeMetadata(taskId, turnId, parsed);
  // The turn's log is complete now, whatever the outcome turns out to be, so
  // the prose index is written HERE — before the three branches below, each of
  // which returns. An interrupted or failed turn said things worth finding
  // too, and indexing must never be the reason a turn fails to settle.
  await indexProse(taskId, turnId, def, outPath, parsed.result);

  const currentTurn = getTurn(turnId);
  const interruptDetail = currentTurn?.interrupt_detail ?? null;
  const killReason = currentTurn?.kill_detail ?? undefined;
  if (interruptDetail !== null) {
    await finalizeInterruptedTurn(taskId, turnId, exitCode, interruptDetail, {
      recorderMode,
      recorderErrorDetail,
      parsed,
      def,
      rawOut,
      errPath,
    });
    return;
  }

  const missingResult = def.parse.format === "json" && !def.allowEmptyResult && parsed.result === null;
  const exitedCleanly = exitCode === 0 || (exitCode === null && parsed.result !== null);
  const succeeded = !killReason && !parsed.isError && exitedCleanly && !missingResult;
  if (succeeded) {
    settleTurn(
      turnId,
      { status: "done", exitCode, result: parsed.result },
      taskId,
      parsed.needsInput ? "needs-input" : "done",
      parsed.result ? summarize(parsed.result) : null,
    );
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
    recorderDetail,
    killReason,
    reportedFailure: parsed.isError,
    exitedCleanly,
    missingResult,
  });
}

/** What finalization would have left the task in, judged from its settled turn alone. */
function settledState(turn: Turn): { state: TaskState; detail: string | null } {
  if (turn.status === "done") return { state: "done", detail: turn.result ? summarize(turn.result) : null };
  if (turn.status === "interrupted") {
    const detail = turn.interrupt_detail ?? INTERRUPTED;
    return { state: isUnresolvedInterrupt(detail) ? "stuck" : "needs-input", detail };
  }
  return { state: "failed", detail: `turn ${turn.n} failed; Wisp stopped before it recorded why on the task` };
}

/**
 * Boot invariant: a task reads `running` or `stuck` only while one of its
 * turns runs. Recovery visits running turns, so a task whose turn settled
 * without the task following (a crash between the two writes, before they
 * shared a transaction) was never visited, and Stop refused it as having
 * nothing to interrupt. Move each such task to what its latest turn says.
 *
 * A `stuck` task whose latest turn is an unresolved Stop already agrees with
 * it: that state is the retry control, and it stays.
 *
 * Runs after recoverOrphanedTurns, which settles every turn whose process is
 * gone and leaves the rest running.
 */
export function settleStrandedTasks(): void {
  for (const task of listTasks()) {
    if (task.state !== "running" && task.state !== "stuck") continue;
    if (runningTurn(task.id)) continue;
    const turn = latestTurnForTask(task.id);
    if (!turn || turn.status === "running") continue;
    const settled = settledState(turn);
    if (settled.state === task.state) continue;
    console.error(
      `[wisp] task ${task.id}: '${task.state}' with no running turn at startup; settling it from turn ${turn.n} (${turn.status})`,
    );
    transition(task.id, settled.state, settled.detail);
  }
}
