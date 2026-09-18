import { hostname } from "node:os";
import { FACTORY_PROTOCOL_VERSION } from "../../probes";
import type { AdapterDef } from "../types";
import { boundedOutput } from "./bounded-output";
import { DroidSubagentStream } from "./droid-subagents";
import { JsonRpcPeer, type RpcFrame, type WritableRpcSink } from "./json-rpc";

export interface DroidLiveImage {
  type: "base64";
  data: string;
  mediaType: string;
}

/** One question as Droid poses it over `droid.ask_user`. */
export interface DroidQuestion {
  index: number;
  topic: string | null;
  question: string;
  multiSelect: boolean;
  options: string[];
}

export interface QuestionAnswer {
  index: number;
  answer: string;
}

interface PendingQuestion {
  /** Droid's own frame id, which its result has to echo. */
  frameId: unknown;
  toolCallId: string;
  questions: DroidQuestion[];
}

interface DroidLiveOptions {
  sink: WritableRpcSink;
  def: AdapterDef;
  cwd: string;
  sessionId: string | null;
  model: string | null;
  effort: string | null;
  initialMessageId: string;
  initialText: string;
  initialImages: DroidLiveImage[];
  emit: (event: Record<string, unknown>) => void;
  onTerminal: () => void;
  /**
   * The turn is now waiting on a person, or has stopped waiting. Distinct from
   * onTerminal: the turn is still open either way, so only the task's STATE
   * moves — which is also what keeps stuck-detection off a turn that is idle
   * on purpose.
   */
  onWaiting?: (waiting: boolean) => void;
  /** Test seam for ASK_USER_GRACE_MS; production never sets it. */
  askUserGraceMs?: number;
}

function record(value: unknown): Record<string, any> {
  return typeof value === "object" && value !== null ? (value as Record<string, any>) : {};
}

function errorMessage(value: unknown): string {
  const message = record(value).message;
  return typeof message === "string" && message.trim() ? message.trim() : "unknown JSON-RPC error";
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

/**
 * Droid's questions, defensively. A question with no options is not a
 * questionnaire the UI can render, so it is dropped rather than shown as an
 * empty list; if that leaves nothing, the caller falls back to ending the turn.
 */
function droidQuestions(value: unknown): DroidQuestion[] {
  if (!Array.isArray(value)) return [];
  const questions: DroidQuestion[] = [];
  for (const [position, entry] of value.entries()) {
    const raw = record(entry);
    const question = str(raw.question);
    const options = Array.isArray(raw.options)
      ? raw.options.map((option) => str(option)).filter((option): option is string => option !== null)
      : [];
    if (!question || options.length === 0) continue;
    questions.push({
      index: typeof raw.index === "number" ? raw.index : position + 1,
      topic: str(raw.topic),
      question,
      multiSelect: raw.multiSelect === true,
      options,
    });
  }
  return questions;
}

function droidUsage(value: unknown): Record<string, number> | null {
  const usage = record(value);
  const pairs: [string, unknown][] = [
    ["input_tokens", usage.inputTokens],
    ["output_tokens", usage.outputTokens],
    ["cache_creation_input_tokens", usage.cacheCreationTokens],
    ["cache_read_input_tokens", usage.cacheReadTokens],
    ["thinking_tokens", usage.thinkingTokens],
    ["factory_credits", usage.factoryCredits],
  ];
  const normalized: Record<string, number> = {};
  for (const [name, amount] of pairs) {
    if (typeof amount === "number") normalized[name] = amount;
  }
  return Object.keys(normalized).length > 0 ? normalized : null;
}

function initParams(options: DroidLiveOptions): Record<string, unknown> {
  const params: Record<string, unknown> = {
    machineId: `wisp:${hostname()}`,
    cwd: options.cwd,
    skipPermissionsUnsafe: options.def.exec.includes("--skip-permissions-unsafe"),
  };
  if (options.model) params.modelId = options.model;
  if (options.effort) params.reasoningEffort = options.effort;
  const auto = options.def.exec.indexOf("--auto");
  if (auto >= 0) {
    params.interactionMode = "auto";
    const level = options.def.exec[auto + 1];
    if (level && !level.startsWith("-")) params.autonomyLevel = level;
  }
  return params;
}

function messageParams(
  messageId: string,
  text: string,
  images: DroidLiveImage[],
): Record<string, unknown> {
  return {
    messageId,
    text,
    ...(images.length > 0 ? { images } : {}),
    queuePlacement: "end_of_turn",
  };
}

/**
 * How long an AskUser tool_use waits for its `droid.ask_user` request before
 * the turn ends as needs-input instead. The two arrive together in practice;
 * this only catches a Droid that does not speak the request at all.
 */
const ASK_USER_GRACE_MS = 10_000;

/** What a superseded questionnaire tells the model, in place of an answer. */
const DEFERRED_ANSWER = "(no selection — see the message that follows)";

/**
 * A single long-lived Droid JSON-RPC peer.
 *
 * Session start, completion, actual-model and usage shapes plus the versioned
 * transport envelope were live-reverified on Droid 0.213.0 with gpt-6-astra.
 * Tool results were reverified on 0.215.1: they are standalone `tool_result`
 * notifications rather than content blocks on `create_message`.
 * Steering was last live-probed on 0.205.0. Admission is the
 * response to droid.add_user_message. Completion is agent_turn_completed
 * (any reason), which closes stdin immediately, the same way Codex closes on
 * turn/completed. Idle is only a fallback if that close raced. A correction
 * admitted while a tool was sleeping completed in the original turn and
 * replaced its requested final answer.
 *
 * AskUser is the one tool that suspends rather than ends the turn: Droid
 * follows the tool_use with a `droid.ask_user` REQUEST and blocks on our
 * reply, so the turn stays open, idle, until the operator answers. Wisp used
 * to end the turn there because `JsonRpcPeer.handle` swallowed the request.
 * A harness that never sends it (or sends nothing we can render) still gets
 * the old behaviour, via ASK_USER_GRACE_MS.
 */
export class DroidLiveDriver {
  readonly ready: Promise<void>;

  private readonly peer: JsonRpcPeer;
  private terminal = false;
  private sessionId: string | null;
  private model: string | null;
  private finalText = "";
  private subagents: DroidSubagentStream | null = null;
  private readonly questions = new Map<string, PendingQuestion>();
  private askUserGrace: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: DroidLiveOptions) {
    this.sessionId = options.sessionId;
    this.model = options.model;
    this.peer = new JsonRpcPeer({
      sink: options.sink,
      label: "Droid JSON-RPC",
      errorMessage,
      requestFrame: (id, method, params) => ({
        jsonrpc: "2.0",
        type: "request",
        factoryApiVersion: "1.0.0",
        factoryProtocolVersion: FACTORY_PROTOCOL_VERSION,
        id,
        method,
        params,
      }),
      responseFrame: (id, result) => ({
        jsonrpc: "2.0",
        type: "response",
        factoryApiVersion: "1.0.0",
        factoryProtocolVersion: FACTORY_PROTOCOL_VERSION,
        id,
        result,
      }),
    });
    this.ready = this.boot().catch(async (error) => {
      const message = error instanceof Error ? error.message : String(error);
      this.options.emit({ type: "error", source: "agent_loop", message });
      this.options.emit({
        type: "completion",
        finalText: message,
        session_id: this.sessionId,
        model: this.model,
        usage: null,
        isError: true,
      });
      this.terminal = true;
      await this.close();
      throw error;
    });
  }

  private async boot(): Promise<void> {
    let opened: Record<string, any>;
    if (this.sessionId) {
      opened = record(await this.call("droid.load_session", { sessionId: this.sessionId }));
      const settings: Record<string, unknown> = {};
      if (this.options.model) settings.modelId = this.options.model;
      if (this.options.effort) settings.reasoningEffort = this.options.effort;
      if (Object.keys(settings).length > 0) await this.call("droid.update_session_settings", settings);
    } else {
      opened = record(await this.call("droid.initialize_session", initParams(this.options)));
      if (typeof opened.sessionId !== "string" || !opened.sessionId) {
        throw new Error("Droid initialized without returning a sessionId");
      }
      this.sessionId = opened.sessionId;
    }
    const settings = record(opened.settings);
    if (!this.model && typeof settings.modelId === "string") this.model = settings.modelId;
    this.options.emit({
      type: "system",
      subtype: "init",
      cwd: this.options.cwd,
      session_id: this.sessionId,
      model: this.model,
      reasoning_effort: this.options.effort ?? settings.reasoningEffort ?? null,
    });
    this.subagents = new DroidSubagentStream({
      parentSessionId: this.sessionId,
      emit: this.options.emit,
    });
    await this.call(
      "droid.add_user_message",
      messageParams(
        this.options.initialMessageId,
        this.options.initialText,
        this.options.initialImages,
      ),
    );
  }

  /**
   * Steering while a questionnaire is open answers it by other means: "none of
   * those — do X instead" is a legitimate reply, and the operator is never
   * required to use the card. Droid is BLOCKED inside the AskUser tool though,
   * so the request has to be released first or the message it queues can never
   * be reached.
   */
  async send(messageId: string, text: string, images: DroidLiveImage[]): Promise<void> {
    await this.ready;
    if (this.terminal) throw new Error("Droid turn already completed");
    await this.deferQuestionsToMessage();
    await this.call("droid.add_user_message", messageParams(messageId, text, images));
  }

  private call(method: string, params: Record<string, unknown>): Promise<unknown> {
    return this.peer.call(method, params);
  }

  /** Consume one parsed stdout frame. */
  handle(frame: RpcFrame): void {
    if (this.peer.handle(frame)) return;
    if (frame.method === "droid.ask_user") {
      this.handleAskUser(frame);
      return;
    }
    if (frame.method !== "droid.session_notification") return;
    this.handleNotification(record(record(frame.params).notification), Date.now());
  }

  /**
   * Droid is blocked on us. Publish the questionnaire and leave the turn open;
   * `answer` or `close` is what unblocks it. A request we cannot render is
   * declined at once rather than left hanging.
   */
  private handleAskUser(frame: RpcFrame): void {
    const params = record(frame.params);
    const questions = droidQuestions(params.questions);
    const toolCallId = str(params.toolCallId) ?? String(frame.id);
    if (questions.length === 0 || this.terminal) {
      void this.peer.respond(frame.id, { cancelled: true, answers: [] }).catch(() => {});
      if (!this.terminal) this.endAsNeedsInput();
      return;
    }
    this.clearAskUserGrace();
    // Keyed, not single: Droid forwards ask-user requests for every session on
    // the one channel, so a subagent can raise a second while the parent's is
    // still open. Overwriting would leave the first frame unanswered — Droid
    // blocked forever on a card that never settles, and nothing to notice it,
    // because a task parked in needs-input is skipped by stuck detection.
    this.questions.set(toolCallId, { frameId: frame.id, toolCallId, questions });
    this.options.onWaiting?.(true);
    this.options.emit({
      type: "question",
      phase: "asked",
      id: toolCallId,
      questions,
      timestamp: Date.now(),
      session_id: this.sessionId,
    });
  }

  /** The questionnaire the route may still answer; the oldest if several. */
  pendingQuestion(): { id: string; questions: DroidQuestion[] } | null {
    const pending = this.questions.values().next().value;
    return pending ? { id: pending.toolCallId, questions: pending.questions } : null;
  }

  /**
   * Hand Droid the operator's answers. Every question must be answered —
   * Droid validates completeness and would reject a partial result — so the
   * caller's list is matched against the questions we published.
   */
  async answer(questionId: string, answers: QuestionAnswer[]): Promise<void> {
    const pending = this.questions.get(questionId);
    if (!pending) throw new Error("that question is no longer waiting for an answer");
    const byIndex = new Map(answers.map((entry) => [entry.index, entry.answer]));
    const resolved = pending.questions.map((question) => ({
      index: question.index,
      question: question.question,
      answer: (byIndex.get(question.index) ?? "").trim(),
    }));
    const missing = resolved.filter((entry) => !entry.answer);
    if (missing.length > 0) {
      throw new Error(`answer every question first (${missing.length} still empty)`);
    }
    await this.release(pending, { answers: resolved }, {
      phase: "answered",
      answers: resolved.map(({ index, answer }) => ({ index, answer })),
    });
  }

  /**
   * Release Droid and record what became of the questionnaire, in that order.
   * The write comes FIRST because until it lands nothing has changed for the
   * harness: clearing our own state first would strand an operator whose
   * answer failed to write — no pending question to retry, a task already
   * moved off needs-input, and Droid still blocked with no button left.
   */
  private async release(
    pending: PendingQuestion,
    result: Record<string, unknown>,
    settled: { phase: "answered" | "cancelled"; reason?: "superseded" | "stopped"; answers?: QuestionAnswer[] },
  ): Promise<void> {
    await this.peer.respond(pending.frameId, result);
    this.questions.delete(pending.toolCallId);
    if (this.questions.size === 0 && settled.reason !== "stopped") this.options.onWaiting?.(false);
    this.options.emit({
      type: "question",
      id: pending.toolCallId,
      timestamp: Date.now(),
      session_id: this.sessionId,
      ...settled,
    });
  }

  /**
   * Answer every open questionnaire by pointing at the message the operator
   * sent instead. NOT `cancelled: true`: in Droid that is the operator hitting
   * Escape on the form — it raises ToolAbortError, which its ToolExecutor
   * treats as "cancelled by user" and takes the interrupt path, so a steer
   * would tear down the turn it was meant to steer. Droid validates only that
   * the answer count matches, never the text, so an honest pointer releases
   * the tool and leaves the real instruction to the message right behind it.
   */
  private async deferQuestionsToMessage(): Promise<void> {
    for (const pending of [...this.questions.values()]) {
      await this.release(
        pending,
        {
          answers: pending.questions.map((question) => ({
            index: question.index,
            question: question.question,
            answer: DEFERRED_ANSWER,
          })),
        },
        { phase: "cancelled", reason: "superseded" },
      );
    }
  }

  /**
   * Abandon every open questionnaire. Here `cancelled: true` IS what happened —
   * the operator stopped the agent — and leaving it unsent keeps a pending
   * request in Droid's daemon that a resume then trips over.
   */
  private async cancelQuestions(): Promise<void> {
    for (const pending of [...this.questions.values()]) {
      await this.release(pending, { cancelled: true, answers: [] }, {
        phase: "cancelled",
        reason: "stopped",
      }).catch(() => {
        // The channel is already gone; the turn is ending either way.
        this.questions.delete(pending.toolCallId);
      });
    }
  }

  private clearAskUserGrace(): void {
    if (!this.askUserGrace) return;
    clearTimeout(this.askUserGrace);
    this.askUserGrace = null;
  }

  /** The pre-0.193 behaviour: no reply path, so the operator answers by sending. */
  private endAsNeedsInput(): void {
    this.clearAskUserGrace();
    this.emitCompletion({ usage: null, isError: false, needsInput: ["AskUser"] });
  }

  private handleNotification(notification: Record<string, any>, receivedAt: number): void {
    switch (notification.type) {
      case "create_message":
        this.handleMessage(record(notification.message));
        return;
      case "tool_result":
        // Standalone results carry no source timestamp, so preserve their
        // receipt time for subagent durations and terminal event ordering.
        this.emitToolResult(notification, receivedAt);
        return;
      case "agent_turn_completed": {
        if (this.terminal) return;
        const reason = typeof notification.reason === "string" ? notification.reason : "unknown";
        const isError = reason !== "completed";
        if (isError) {
          this.options.emit({ type: "error", source: "agent_loop", message: `Droid turn ${reason}` });
        }
        this.emitCompletion({
          usage: droidUsage(notification.tokenUsage),
          isError,
        });
        return;
      }
      case "droid_working_state_changed":
        // Fallback: completion already closed stdin; a late idle is idempotent.
        if (notification.newState === "idle" && this.terminal) this.options.onTerminal();
        return;
    }
  }

  private emitToolResult(result: Record<string, any>, timestamp?: unknown): void {
    this.options.emit({
      type: "tool_result",
      id: result.toolUseId,
      value: boundedOutput(result.content),
      isError: result.isError === true,
      ...(timestamp !== undefined ? { timestamp } : {}),
      session_id: this.sessionId,
    });
  }

  /** Last assistant prose is the conclusion; error copy lives on the error event, not here. */
  private emitCompletion(options: {
    usage: Record<string, number> | null;
    isError: boolean;
    needsInput?: string[];
  }): void {
    if (this.terminal) return;
    this.clearAskUserGrace();
    this.options.emit({
      type: "completion",
      finalText: this.finalText,
      session_id: this.sessionId,
      model: this.model,
      usage: options.usage,
      isError: options.isError,
      ...(options.needsInput && options.needsInput.length > 0 ? { needs_input: options.needsInput } : {}),
    });
    this.terminal = true;
    this.options.onTerminal();
  }

  private handleMessage(message: Record<string, any>): void {
    const content = Array.isArray(message.content) ? message.content.map(record) : [];
    if (message.role === "assistant") {
      const texts = content
        .filter((block) => block.type === "text" && typeof block.text === "string")
        .map((block) => block.text as string);
      if (texts.length > 0) {
        const text = texts.join("\n");
        this.finalText = text;
        if (typeof message.modelId === "string") this.model = message.modelId;
        this.options.emit({
          type: "message",
          id: message.id,
          role: "assistant",
          text,
          timestamp: message.createdAt,
          session_id: this.sessionId,
        });
      }
    }
    for (const block of content) {
      if (block.type === "tool_use") {
        this.options.emit({
          type: "tool_call",
          id: block.id,
          toolName: block.name,
          parameters: record(block.input),
          timestamp: message.createdAt,
          session_id: this.sessionId,
        });
        if (block.name === "Task" && typeof block.id === "string") {
          this.subagents?.follow(block.id);
        }
        // The turn suspends here rather than ending: `droid.ask_user` is on
        // its way with the same questions in a shape the UI can render. Only
        // if it never arrives does the turn fall back to needs-input, so a
        // Droid without the request never leaves the task waiting forever.
        if (block.name === "AskUser" && this.questions.size === 0 && !this.askUserGrace) {
          this.askUserGrace = setTimeout(() => {
            this.askUserGrace = null;
            if (this.questions.size === 0) this.endAsNeedsInput();
          }, this.options.askUserGraceMs ?? ASK_USER_GRACE_MS);
          this.askUserGrace.unref?.();
        }
      } else if (block.type === "tool_result") {
        this.emitToolResult(block, message.createdAt);
      } else if (
        (block.type === "reasoning" || block.type === "thinking") &&
        typeof block.text === "string"
      ) {
        this.options.emit({
          type: "reasoning",
          id: message.id,
          text: block.text,
          timestamp: message.createdAt,
          session_id: this.sessionId,
        });
      }
    }
  }

  failPending(message: string): void {
    this.peer.failPending(message);
  }

  async close(): Promise<void> {
    this.clearAskUserGrace();
    await this.cancelQuestions();
    if (this.subagents) await this.subagents.close();
    await this.peer.close();
  }
}
