import { hostname } from "node:os";
import { FACTORY_PROTOCOL_VERSION } from "../../probes";
import type { AdapterDef } from "../types";
import { boundedOutput } from "./bounded-output";
import { JsonRpcPeer, type RpcFrame, type WritableRpcSink } from "./json-rpc";

export interface DroidLiveImage {
  type: "base64";
  data: string;
  mediaType: string;
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
}

function record(value: unknown): Record<string, any> {
  return typeof value === "object" && value !== null ? (value as Record<string, any>) : {};
}

function errorMessage(value: unknown): string {
  const message = record(value).message;
  return typeof message === "string" && message.trim() ? message.trim() : "unknown JSON-RPC error";
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
 * A single long-lived Droid JSON-RPC peer.
 *
 * Session start, completion, actual-model and usage shapes plus the versioned
 * transport envelope were live-reverified on Droid 0.213.0 with gpt-6-astra.
 * Tool results were reverified on 0.215.1: they are standalone `tool_result`
 * notifications rather than content blocks on `create_message`.
 * Steering was last live-probed on 0.205.0. Admission is the
 * response to droid.add_user_message. Completion is agent_turn_completed
 * (any reason) or an AskUser tool_use — both close stdin immediately, the
 * same way Codex closes on turn/completed. Idle is only a fallback if that
 * close raced. A correction admitted while a tool was sleeping completed in
 * the original turn and replaced its requested final answer.
 */
export class DroidLiveDriver {
  readonly ready: Promise<void>;

  private readonly peer: JsonRpcPeer;
  private terminal = false;
  private sessionId: string | null;
  private model: string | null;
  private finalText = "";

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
    await this.call(
      "droid.add_user_message",
      messageParams(
        this.options.initialMessageId,
        this.options.initialText,
        this.options.initialImages,
      ),
    );
  }

  async send(messageId: string, text: string, images: DroidLiveImage[]): Promise<void> {
    await this.ready;
    if (this.terminal) throw new Error("Droid turn already completed");
    await this.call("droid.add_user_message", messageParams(messageId, text, images));
  }

  private call(method: string, params: Record<string, unknown>): Promise<unknown> {
    return this.peer.call(method, params);
  }

  /** Consume one parsed stdout frame. */
  handle(frame: RpcFrame): void {
    if (this.peer.handle(frame)) return;
    if (frame.method !== "droid.session_notification") return;
    this.handleNotification(record(record(frame.params).notification), Date.now());
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
        // Wisp has no reply path for Droid AskUser. End the turn as
        // needs-input so the operator answers with send, rather than waiting
        // forever for a questionnaire nothing can fill in.
        if (block.name === "AskUser") {
          this.emitCompletion({ usage: null, isError: false, needsInput: ["AskUser"] });
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

  close(): Promise<void> {
    return this.peer.close();
  }
}
