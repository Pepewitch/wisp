import type { AdapterDef, ParsedTurn } from "./types";
import { isRecord } from "../validate";

export type OutcomePolicy = "legacy" | "recorder-v1";
type ReducerKind = "codex-jsonl" | "cursor-stream-json" | "mapped-json";

export interface OutcomeCheckpointV1 {
  version: 1;
  kind: ReducerKind;
  stdoutLines: number;
  earlySession: string | null;
  earlyModel: string | null;
  earlySkills: string[] | null;
  resultEvent: Record<string, unknown> | null;
  candidateResult: string | null;
  settled: boolean;
  failed: boolean;
  usage: unknown | null;
  claudeError: string | null;
  codexTerminalError: string | null;
  codexEventError: string | null;
  codexWarningError: string | null;
  droidAgentLoopError: string | null;
  droidOtherError: string | null;
  droidCompletionError: string | null;
  firstStderr: string | null;
  stderrTail: string[];
}

function nestedErrorMessage(message: string): string {
  try {
    const inner: unknown = JSON.parse(message);
    if (isRecord(inner)) {
      const candidate = isRecord(inner.error) ? inner.error.message : inner.message;
      if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
    }
  } catch {
    // Plain text after all.
  }
  return message.trim();
}

function textParts(event: Record<string, any>): string | null {
  const content: unknown[] = Array.isArray(event.message?.content) ? event.message.content : [];
  const parts = content
    .filter((part: any) => part?.type === "text" && typeof part.text === "string" && part.text.trim())
    .map((part: any) => part.text.trim());
  return parts.length > 0 ? parts.join("\n") : null;
}

function reducerKind(def: AdapterDef): ReducerKind | null {
  if (def.parse.strategy === "codex-jsonl") return "codex-jsonl";
  if (def.parse.strategy === "cursor-stream-json") return "cursor-stream-json";
  if (!def.parse.strategy && def.parse.format === "json") return "mapped-json";
  return null;
}

/**
 * Incrementally collects only the facts needed to settle a turn. It owns no
 * transcript bytes and can therefore keep running after primary capture
 * degrades. The same reducer is used to fold legacy files during migration.
 */
export class IncrementalOutcomeReducer {
  private readonly kind: ReducerKind;
  private stdoutLines = 0;
  private earlySession: string | null = null;
  private earlyModel: string | null = null;
  private earlySkills: string[] | null = null;
  private resultEvent: Record<string, unknown> | null = null;
  private candidateResult: string | null = null;
  private settled = false;
  private failed = false;
  private usage: unknown | null = null;
  private claudeError: string | null = null;
  private codexTerminalError: string | null = null;
  private codexEventError: string | null = null;
  private codexWarningError: string | null = null;
  private droidAgentLoopError: string | null = null;
  private droidOtherError: string | null = null;
  private droidCompletionError: string | null = null;
  private firstStderr: string | null = null;
  private stderrTail: string[] = [];

  constructor(
    private readonly def: AdapterDef,
    checkpoint?: OutcomeCheckpointV1,
  ) {
    const kind = reducerKind(def);
    if (!kind) throw new Error("adapter has no incremental outcome reducer");
    this.kind = kind;
    if (checkpoint) this.restore(checkpoint);
  }

  pushStdoutLine(line: string): void {
    const ordinal = this.stdoutLines++;
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) return;
    let event: Record<string, any>;
    try {
      event = JSON.parse(trimmed) as Record<string, any>;
    } catch {
      return;
    }

    if (ordinal < 10) {
      const sessionField = this.def.parse.session;
      if (this.earlySession === null && sessionField && typeof event[sessionField] === "string") {
        this.earlySession = event[sessionField];
      }
      const modelField = this.def.parse.model;
      if (this.earlyModel === null && modelField && typeof event[modelField] === "string") {
        this.earlyModel = event[modelField];
      }
      const skillsField = this.def.parse.skills;
      const skills = skillsField ? event[skillsField] : undefined;
      if (this.earlySkills === null && Array.isArray(skills) && skills.every((skill) => typeof skill === "string")) {
        this.earlySkills = skills;
      }
      // Cursor's named strategy owns these fields, so they are intentionally
      // absent from the declarative parse mapping.
      if (this.kind === "cursor-stream-json") {
        if (this.earlySession === null && typeof event.session_id === "string") this.earlySession = event.session_id;
        if (this.earlyModel === null && typeof event.model === "string") this.earlyModel = event.model;
      }
    }

    if (this.kind === "codex-jsonl") this.pushCodex(event);
    else if (this.kind === "cursor-stream-json") this.pushCursor(event);
    else this.pushMapped(event);
    this.pushErrorEvent(event);
  }

  pushStderrLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    this.firstStderr ??= trimmed;
    this.stderrTail.push(trimmed);
    if (this.stderrTail.length > 3) this.stderrTail.shift();
  }

  outcome(policy: OutcomePolicy = "legacy"): ParsedTurn {
    if (this.kind === "codex-jsonl") {
      const positivelySettled = policy === "legacy" || this.settled;
      const isError = this.failed || !positivelySettled;
      return {
        result: isError ? null : this.candidateResult,
        session: this.earlySession,
        needsInput: false,
        isError,
        model: this.earlyModel,
        usage: this.usage,
        skills: null,
      };
    }

    if (this.kind === "cursor-stream-json") {
      if (!this.resultEvent) {
        return {
          result: null,
          session: this.earlySession,
          needsInput: false,
          isError: true,
          model: this.earlyModel,
          usage: null,
          skills: null,
        };
      }
      const rawResult = this.resultEvent.result;
      const fallback = typeof rawResult === "string" && rawResult ? rawResult : null;
      return {
        result: this.candidateResult ?? fallback,
        session:
          typeof this.resultEvent.session_id === "string" ? this.resultEvent.session_id : this.earlySession,
        needsInput: false,
        isError: this.resultEvent.is_error === true,
        model: this.earlyModel,
        usage: isRecord(this.resultEvent.usage) ? this.resultEvent.usage : null,
        skills: null,
      };
    }

    const event = this.resultEvent;
    if (!event) {
      return {
        result: null,
        session: this.earlySession,
        needsInput: false,
        isError: false,
        model: this.earlyModel,
        usage: null,
        skills: this.earlySkills,
      };
    }
    const rawResult = this.def.parse.result ? event[this.def.parse.result] : null;
    const result = typeof rawResult === "string" ? rawResult : rawResult != null ? JSON.stringify(rawResult) : null;
    const rawSession = this.def.parse.session ? event[this.def.parse.session] : null;
    const rawModel = this.def.parse.model ? event[this.def.parse.model] : null;
    const needsInputField = this.def.parse.needsInput;
    const rawUsage = this.def.parse.usage ? event[this.def.parse.usage] : null;
    return {
      result,
      session: typeof rawSession === "string" ? rawSession : null,
      needsInput: needsInputField ? Array.isArray(event[needsInputField]) && event[needsInputField].length > 0 : false,
      isError: event.isError === true || event.is_error === true,
      model: typeof rawModel === "string" ? rawModel : this.earlyModel,
      usage: isRecord(rawUsage) ? rawUsage : null,
      skills: this.earlySkills,
    };
  }

  errorDetail(): string | null {
    let detail: string | null = null;
    if (this.def.errors === "claude-stream-json") detail = this.claudeError;
    else if (this.def.errors === "codex-jsonl") {
      detail = this.codexTerminalError ?? this.codexEventError ?? this.codexWarningError;
    } else if (this.def.errors === "droid-stream-json") {
      detail = this.droidAgentLoopError ?? this.droidOtherError ?? this.droidCompletionError ?? this.firstStderr;
    }
    return detail?.trim() || this.stderrTail.join(" | ") || null;
  }

  checkpoint(): OutcomeCheckpointV1 {
    return {
      version: 1,
      kind: this.kind,
      stdoutLines: this.stdoutLines,
      earlySession: this.earlySession,
      earlyModel: this.earlyModel,
      earlySkills: this.earlySkills,
      resultEvent: this.resultEvent,
      candidateResult: this.candidateResult,
      settled: this.settled,
      failed: this.failed,
      usage: this.usage,
      claudeError: this.claudeError,
      codexTerminalError: this.codexTerminalError,
      codexEventError: this.codexEventError,
      codexWarningError: this.codexWarningError,
      droidAgentLoopError: this.droidAgentLoopError,
      droidOtherError: this.droidOtherError,
      droidCompletionError: this.droidCompletionError,
      firstStderr: this.firstStderr,
      stderrTail: [...this.stderrTail],
    };
  }

  private restore(checkpoint: OutcomeCheckpointV1): void {
    if (checkpoint.version !== 1 || checkpoint.kind !== this.kind) {
      throw new Error(`outcome checkpoint is incompatible with ${this.kind}`);
    }
    this.stdoutLines = checkpoint.stdoutLines;
    this.earlySession = checkpoint.earlySession;
    this.earlyModel = checkpoint.earlyModel;
    this.earlySkills = checkpoint.earlySkills;
    this.resultEvent = checkpoint.resultEvent;
    this.candidateResult = checkpoint.candidateResult;
    this.settled = checkpoint.settled;
    this.failed = checkpoint.failed;
    this.usage = checkpoint.usage;
    this.claudeError = checkpoint.claudeError;
    this.codexTerminalError = checkpoint.codexTerminalError;
    this.codexEventError = checkpoint.codexEventError;
    this.codexWarningError = checkpoint.codexWarningError;
    this.droidAgentLoopError = checkpoint.droidAgentLoopError;
    this.droidOtherError = checkpoint.droidOtherError;
    this.droidCompletionError = checkpoint.droidCompletionError;
    this.firstStderr = checkpoint.firstStderr;
    this.stderrTail = checkpoint.stderrTail.slice(-3);
  }

  private pushCodex(event: Record<string, any>): void {
    switch (event.type) {
      case "thread.started":
        if (typeof event.thread_id === "string") this.earlySession ??= event.thread_id;
        if (typeof event.model === "string") this.earlyModel ??= event.model;
        break;
      case "turn.started":
        this.failed = false;
        this.settled = false;
        break;
      case "turn.failed":
        this.failed = true;
        if (event.usage !== undefined && event.usage !== null) this.usage = event.usage;
        break;
      case "item.completed":
        if (event.item?.type === "agent_message" && typeof event.item.text === "string") {
          this.candidateResult = event.item.text;
        }
        break;
      case "turn.completed":
        this.settled = true;
        if (event.usage !== undefined && event.usage !== null) this.usage = event.usage;
        break;
    }
  }

  private pushCursor(event: Record<string, any>): void {
    if (event.type === "result") {
      this.resultEvent = event;
      this.settled = true;
    } else if (event.type === "assistant") {
      const text = textParts(event);
      if (text) this.candidateResult = text;
    }
  }

  private pushMapped(event: Record<string, any>): void {
    if (!this.def.parse.resultType || event.type === this.def.parse.resultType) {
      this.resultEvent = event;
      this.settled = true;
    }
  }

  private pushErrorEvent(event: Record<string, any>): void {
    if (this.def.errors === "claude-stream-json") this.pushClaudeError(event);
    else if (this.def.errors === "codex-jsonl") this.pushCodexError(event);
    else if (this.def.errors === "droid-stream-json") this.pushDroidError(event);
  }

  private pushClaudeError(event: Record<string, any>): void {
    if (
      event.type === "result" &&
      (event.is_error === true || (typeof event.subtype === "string" && event.subtype.startsWith("error"))) &&
      typeof event.result === "string" &&
      event.result.trim()
    ) {
      this.claudeError = event.result.trim();
    } else if (event.type === "assistant" && typeof event.error === "string") {
      this.claudeError = textParts(event) ?? this.claudeError ?? event.error;
    }
  }

  private pushCodexError(event: Record<string, any>): void {
    if (event.type === "turn.failed" && typeof event.error?.message === "string" && event.error.message.trim()) {
      this.codexTerminalError = nestedErrorMessage(event.error.message);
    } else if (event.type === "error" && typeof event.message === "string" && event.message.trim()) {
      this.codexEventError = nestedErrorMessage(event.message);
    } else if (
      event.type === "item.completed" &&
      event.item?.type === "error" &&
      typeof event.item.message === "string"
    ) {
      this.codexWarningError ??= event.item.message.trim();
    }
  }

  private pushDroidError(event: Record<string, any>): void {
    if (event.type === "error" && typeof event.message === "string" && event.message.trim()) {
      if (event.source === "agent_loop") this.droidAgentLoopError = event.message.trim();
      else this.droidOtherError = event.message.trim();
    } else if (event.type === "completion" && event.isError === true && typeof event.finalText === "string") {
      if (event.finalText.trim()) this.droidCompletionError = event.finalText.trim();
    }
  }
}

export function hasIncrementalOutcomeReducer(def: AdapterDef): boolean {
  return reducerKind(def) !== null;
}

export function createIncrementalOutcomeReducer(
  def: AdapterDef,
  checkpoint?: OutcomeCheckpointV1,
): IncrementalOutcomeReducer | null {
  return hasIncrementalOutcomeReducer(def) ? new IncrementalOutcomeReducer(def, checkpoint) : null;
}

export function foldIncrementalOutcome(
  def: AdapterDef,
  stdout: string,
  stderr = "",
  policy: OutcomePolicy = "legacy",
): { outcome: ParsedTurn; errorDetail: string | null; checkpoint: OutcomeCheckpointV1 } | null {
  const reducer = createIncrementalOutcomeReducer(def);
  if (!reducer) return null;
  for (const line of stdout.split("\n")) reducer.pushStdoutLine(line);
  for (const line of stderr.split("\n")) reducer.pushStderrLine(line);
  return { outcome: reducer.outcome(policy), errorDetail: reducer.errorDetail(), checkpoint: reducer.checkpoint() };
}
