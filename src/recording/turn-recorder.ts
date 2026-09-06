import { fstatSync, writeSync } from "node:fs";
import {
  createIncrementalOutcomeReducer,
  type AdapterDef,
  type IncrementalOutcomeReducer,
  type OutcomeCheckpointV1,
  type ParsedTurn,
} from "../adapters";
import { JsonLineBuffer } from "../adapters/live/json-lines";
import { transcriptBudgetBytes, type WispConfig } from "../config";
import { setTurnCaptureCheckpoint } from "../store";
import { boundJsonRecord, SequencedRecordBudget, truncateUtf8 } from "./bounds";
import { closeTurnBroker, openTurnBroker, type TurnBroker } from "./broker";

const CRITICAL_LANE_MAX_BYTES = 16 * 1024;
const MAX_PRIMARY_RECORDS = 100_000;
const MAX_FACT_STRING_BYTES = 64 * 1024;
const CHECKPOINT_RECORD_INTERVAL = 64;
const CHECKPOINT_TIME_INTERVAL_MS = 1_000;

export type RecorderSource = "stdout" | "stderr";

export interface RecorderOutcome {
  parsed: ParsedTurn;
  errorDetail: string | null;
  checkpoint: OutcomeCheckpointV1;
}

function categoryOf(event: Record<string, unknown> | null, source: RecorderSource): string {
  if (source === "stderr") return "stderr";
  if (!event || typeof event.type !== "string") return "text";
  const item = event.item;
  if (item && typeof item === "object" && typeof (item as Record<string, unknown>).type === "string") {
    return `${event.type}:${(item as Record<string, unknown>).type as string}`;
  }
  return event.type;
}

function terminalEvent(event: Record<string, unknown> | null): boolean {
  return event?.type === "result" || event?.type === "completion" || event?.type === "turn.completed" || event?.type === "turn.failed";
}

/**
 * Recorder-owned turns drain both process pipes and project each complete line
 * independently into the outcome checkpoint, bounded primary transcript, and
 * live broker. Storage degradation never stops pipe draining.
 */
export class TurnRecorder {
  private readonly reducer: IncrementalOutcomeReducer;
  private readonly budget: SequencedRecordBudget;
  private readonly broker: TurnBroker;
  private readonly transcriptBudget: number;
  private readonly criticalLaneBytes: number;
  private state: "complete" | "degraded" | "disabled" = "complete";
  private detail: string | null = null;
  private capturedBytes: number;
  private outOffset: number;
  private criticalBytes = 0;
  private dirtyRecords = 0;
  private lastCheckpointAt = Date.now();
  private checkpointFailure: string | null = null;
  private finished = false;

  constructor(
    readonly turnId: number,
    private readonly def: AdapterDef,
    cfg: WispConfig,
    private readonly outFd: number,
    private readonly errFd: number,
  ) {
    const reducer = createIncrementalOutcomeReducer(def, undefined, { maxFactStringBytes: MAX_FACT_STRING_BYTES });
    if (!reducer) throw new Error("adapter has no incremental outcome reducer");
    this.reducer = reducer;
    this.transcriptBudget = transcriptBudgetBytes(cfg);
    this.criticalLaneBytes = Math.min(CRITICAL_LANE_MAX_BYTES, Math.floor(this.transcriptBudget / 10));
    const initialOut = fstatSync(outFd).size;
    const initialErr = fstatSync(errFd).size;
    this.outOffset = initialOut;
    this.capturedBytes = initialOut + initialErr;
    const ordinaryBytes = Math.max(0, this.transcriptBudget - this.criticalLaneBytes - this.capturedBytes);
    this.budget = new SequencedRecordBudget(ordinaryBytes, MAX_PRIMARY_RECORDS);
    this.broker = openTurnBroker(turnId);
    this.broker.setPrimaryOffset(this.outOffset);
    this.persistCheckpoint(true);
  }

  recordEvent(event: Record<string, unknown>): void {
    const projected = boundJsonRecord(event);
    const parsed = projected.value && !Array.isArray(projected.value) && typeof projected.value === "object"
      ? projected.value as Record<string, unknown>
      : null;
    this.recordProjectedLine("stdout", projected.json, parsed, categoryOf(parsed, "stdout"));
  }

  recordStdoutLine(line: string): void {
    let event: Record<string, unknown> | null = null;
    const trimmed = line.trim();
    if (trimmed.startsWith("{")) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) event = parsed as Record<string, unknown>;
      } catch {
        // Protocol noise remains a bounded plain-text record.
      }
    }
    if (event) {
      const projected = boundJsonRecord(event, {}, Buffer.byteLength(line, "utf8"));
      const boundedEvent = projected.value && !Array.isArray(projected.value) && typeof projected.value === "object"
        ? projected.value as Record<string, unknown>
        : null;
      this.recordProjectedLine("stdout", projected.json, boundedEvent, categoryOf(boundedEvent, "stdout"));
      return;
    }
    const projected = truncateUtf8(line, 64 * 1024);
    const text = projected.omittedBytes > 0
      ? `${projected.value} [wisp: ${projected.omittedBytes} bytes omitted]`
      : projected.value;
    this.recordProjectedLine("stdout", text, null, "text");
  }

  recordStderrLine(line: string): void {
    const projected = truncateUtf8(line, 64 * 1024);
    const text = projected.omittedBytes > 0
      ? `${projected.value} [wisp: ${projected.omittedBytes} bytes omitted]`
      : projected.value;
    this.reducer.pushStderrLine(text);
    this.dirtyRecords++;
    this.persistCheckpoint(false);
    this.project("stderr", text, "stderr");
  }

  recordNote(note: string): void {
    this.recordStdoutLine(note);
  }

  recordFrameDrop(source: RecorderSource, chars: number): void {
    const note = `· dropped an oversized ${source} protocol frame (${chars} characters); the turn continues`;
    if (source === "stdout") this.recordNote(note);
    else this.recordStderrLine(note);
  }

  async drain(stream: ReadableStream<Uint8Array> | number | null | undefined, source: RecorderSource): Promise<void> {
    if (!stream || typeof stream === "number") return;
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    const frames = new JsonLineBuffer({ onDrop: (chars) => this.recordFrameDrop(source, chars) });
    const consume = source === "stdout"
      ? (line: string) => this.recordStdoutLine(line)
      : (line: string) => this.recordStderrLine(line);
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const line of frames.push(decoder.decode(value, { stream: true }))) consume(line);
      }
      for (const line of frames.finish(decoder.decode())) consume(line);
    } finally {
      reader.releaseLock();
    }
  }

  currentOutcome(): RecorderOutcome {
    return {
      parsed: this.reducer.outcome("recorder-v1"),
      errorDetail: this.reducer.errorDetail(),
      checkpoint: this.reducer.checkpoint(),
    };
  }

  finish(): RecorderOutcome {
    if (!this.finished) {
      this.finished = true;
      if (this.state === "degraded") this.writeCritical(this.captureSummary());
      this.persistCheckpoint(true);
      closeTurnBroker(this.turnId);
    }
    return this.currentOutcome();
  }

  private recordProjectedLine(
    source: "stdout",
    line: string,
    event: Record<string, unknown> | null,
    category: string,
  ): void {
    this.reducer.pushStdoutLine(line);
    this.dirtyRecords++;
    this.persistCheckpoint(terminalEvent(event));
    this.project(source, line, category);
  }

  private project(source: RecorderSource, line: string, category: string): void {
    const admission = this.budget.offer(line, category, this.state === "complete");
    let stateChanged = false;
    if (admission.retained) {
      const fd = source === "stdout" ? this.outFd : this.errFd;
      if (!this.writePrimary(fd, `${line}\n`, source)) {
        this.state = "disabled";
        this.detail ??= "primary transcript write failed; the turn continued";
        stateChanged = true;
      }
    } else if (this.state === "complete") {
      this.state = "degraded";
      this.detail = `primary transcript reached its ${this.transcriptBudget} byte budget; later activity is not retained`;
      this.writeCritical(`· ${this.detail}; the turn continues`);
      stateChanged = true;
    }
    if (source === "stdout") this.broker.publish({ sequence: admission.sequence, source, line });
    this.persistCheckpoint(stateChanged);
  }

  private writePrimary(fd: number, text: string, source: RecorderSource): boolean {
    try {
      const buffer = Buffer.from(text);
      let offset = 0;
      while (offset < buffer.length) offset += writeSync(fd, buffer, offset);
      this.capturedBytes += buffer.length;
      if (source === "stdout") {
        this.outOffset += buffer.length;
        this.broker.setPrimaryOffset(this.outOffset);
      }
      return true;
    } catch (error) {
      this.detail = `primary transcript disabled: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300);
      console.error(`[wisp] turn ${this.turnId}: ${this.detail}`);
      return false;
    }
  }

  private writeCritical(line: string): void {
    const available = Math.max(0, this.criticalLaneBytes - this.criticalBytes);
    if (available <= 1 || this.state === "disabled") return;
    const bounded = truncateUtf8(`${line}\n`, available);
    if (!bounded.value) return;
    if (this.writePrimary(this.outFd, bounded.value, "stdout")) this.criticalBytes += Buffer.byteLength(bounded.value, "utf8");
  }

  private captureSummary(): string {
    const snapshot = this.budget.snapshot();
    return `· transcript capture summary: ${snapshot.omittedRecords} records / ${snapshot.omittedBytes} bytes omitted`;
  }

  private persistCheckpoint(force: boolean): void {
    if (this.checkpointFailure) return;
    const now = Date.now();
    if (!force && this.dirtyRecords < CHECKPOINT_RECORD_INTERVAL && now - this.lastCheckpointAt < CHECKPOINT_TIME_INTERVAL_MS) {
      return;
    }
    const snapshot = this.budget.snapshot();
    try {
      setTurnCaptureCheckpoint(this.turnId, {
        state: this.state,
        capturedBytes: this.capturedBytes,
        omittedBytes: snapshot.omittedBytes,
        omittedRecords: snapshot.omittedRecords,
        categoriesJson: JSON.stringify(snapshot.omittedByCategory),
        detail: this.detail,
        outcomeJson: JSON.stringify(this.reducer.checkpoint()),
      });
      this.dirtyRecords = 0;
      this.lastCheckpointAt = now;
    } catch (error) {
      this.checkpointFailure = error instanceof Error ? error.message : String(error);
      console.error(`[wisp] turn ${this.turnId}: outcome checkpoint failed: ${this.checkpointFailure}`);
    }
  }
}
