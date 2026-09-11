import { readFile } from "node:fs/promises";
import {
  createIncrementalOutcomeReducer,
  errorDetail,
  isLimitError,
  isTransientError,
  parseOutput,
  type AdapterDef,
  type OutcomeCheckpointV1,
  type ParsedTurn,
} from "./adapters";
import {
  finishTurn,
  getTurn,
  setTaskContextFields,
  setTurnModel,
  setTurnUsage,
  transition,
} from "./store";
import { summarize } from "./text";
import { isUnresolvedInterrupt } from "./interrupt-state";
import { indexTurnProse } from "./turn-texts";
import type { RecorderOutcome } from "./recording/turn-recorder";

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
    skills: null,
  };
}

function persistOutcomeMetadata(taskId: string, turnId: number, parsed: ParsedTurn): void {
  const turn = getTurn(turnId);
  if (turn) {
    setTaskContextFields(taskId, turn.context_n, {
      ...(parsed.session ? { session_id: parsed.session } : {}),
      ...(parsed.skills !== null ? { skills_json: JSON.stringify(parsed.skills) } : {}),
    });
  }
  if (parsed.model) setTurnModel(turnId, parsed.model);
  if (parsed.usage != null) setTurnUsage(turnId, JSON.stringify(parsed.usage));
}

function restoreRecorderOutcome(def: AdapterDef, raw: string | null): RecorderOutcome | null {
  if (!raw) return null;
  try {
    const checkpoint = JSON.parse(raw) as OutcomeCheckpointV1;
    const reducer = createIncrementalOutcomeReducer(def, checkpoint, { maxFactStringBytes: 64 * 1024 });
    if (!reducer) return null;
    return {
      parsed: reducer.outcome("recorder-v1"),
      errorDetail: reducer.errorDetail(),
      checkpoint: reducer.checkpoint(),
    };
  } catch {
    return null;
  }
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
  finishTurn(facts.turnId, "failed", facts.exitCode, facts.result);
  const why = facts.killReason
    ? `turn killed: ${facts.killReason}`
    : facts.reportedFailure && facts.exitedCleanly
      ? `turn reported failure${detail ? `: ${detail.slice(0, 300)}` : ""}`
      : facts.exitedCleanly && facts.missingResult
        ? `turn exited 0 but emitted no parseable result — not done (set allowEmptyResult on the adapter if this harness legitimately exits without one)${detail ? `: ${detail.slice(0, 300)}` : ""}`
        : `turn exited ${facts.exitCode === null ? "unknown" : facts.exitCode}${detail ? `: ${detail.slice(0, 300)}` : ""}`;
  transition(facts.taskId, "failed", `${limitPrefix || transientPrefix}${why}`);
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
  finishTurn(turnId, "interrupted", exitCode, facts.parsed.result);
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
  transition(taskId, isUnresolvedInterrupt(interruptDetail) ? "stuck" : "needs-input", settled);
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
    const restored = liveRecorderOutcome ?? restoreRecorderOutcome(def, turn?.outcome_json ?? null);
    parsed = restored?.parsed ?? emptyFailedOutcome();
    recorderErrorDetail = restored?.errorDetail ?? null;
    recorderDetail =
      restored?.errorDetail ??
      (turn?.outcome_json ? "outcome checkpoint is unreadable" : "outcome checkpoint is unavailable");
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
    recorderDetail,
    killReason,
    reportedFailure: parsed.isError,
    exitedCleanly,
    missingResult,
  });
}
