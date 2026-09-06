import type { AdapterDef } from "../types";
import { boundedOutput } from "./bounded-output";
import { JsonRpcPeer, type RpcFrame, type WritableRpcSink } from "./json-rpc";

export interface CodexLiveInput {
  type: "text" | "localImage";
  text?: string;
  text_elements?: [];
  path?: string;
}

interface CodexLiveOptions {
  sink: WritableRpcSink;
  def: AdapterDef;
  cwd: string;
  sessionId: string | null;
  model: string | null;
  effort: string | null;
  initialMessageId: string;
  initialInput: CodexLiveInput[];
  emit: (event: Record<string, unknown>) => void;
  onTerminal: () => void;
}

function record(value: unknown): Record<string, any> {
  return typeof value === "object" && value !== null ? (value as Record<string, any>) : {};
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

/** The child's final `agentMessage` in a completed turn's item summary, if the payload carried one. */
function lastAgentMessage(items: unknown): string | null {
  if (!Array.isArray(items)) return null;
  for (let index = items.length - 1; index >= 0; index--) {
    const item = record(items[index]);
    if (item.type === "agentMessage" && str(item.text)) return boundedOutput(item.text) as string;
  }
  return null;
}

function rpcError(value: unknown): string {
  const message = record(value).message;
  return typeof message === "string" && message.trim() ? message.trim() : "unknown app-server error";
}

function threadOptions(options: CodexLiveOptions): Record<string, unknown> {
  const params: Record<string, unknown> = { cwd: options.cwd };
  if (options.model) params.model = options.model;
  if (options.def.exec.includes("--dangerously-bypass-approvals-and-sandbox")) {
    params.approvalPolicy = "never";
    params.sandbox = "danger-full-access";
  }
  return params;
}

function snakeItem(value: unknown): Record<string, unknown> {
  const item = record(value);
  switch (item.type) {
    case "userMessage":
      return { id: item.id, type: "user_message", client_id: item.clientId, content: item.content };
    case "agentMessage":
      return { id: item.id, type: "agent_message", text: item.text, phase: item.phase };
    case "commandExecution":
      return {
        id: item.id,
        type: "command_execution",
        command: item.command,
        status: item.status,
        aggregated_output: boundedOutput(item.aggregatedOutput),
        exit_code: item.exitCode,
        duration_ms: item.durationMs,
      };
    case "fileChange":
      return { id: item.id, type: "file_change", changes: item.changes, status: item.status };
    case "mcpToolCall":
      return {
        id: item.id,
        type: "mcp_tool_call",
        server: item.server,
        tool: item.tool,
        status: item.status,
        arguments: item.arguments,
        result: item.result,
        error: item.error,
      };
    case "dynamicToolCall":
      return {
        id: item.id,
        type: "dynamic_tool_call",
        namespace: item.namespace,
        tool: item.tool,
        arguments: item.arguments,
        status: item.status,
        content_items: item.contentItems,
        success: item.success,
      };
    case "collabAgentToolCall":
      return {
        id: item.id,
        type: "collab_tool_call",
        tool: item.tool,
        status: item.status,
        prompt: item.prompt,
        model: item.model,
        sender_thread_id: item.senderThreadId,
        receiver_thread_ids: item.receiverThreadIds,
        reasoning_effort: item.reasoningEffort,
        agents_states: item.agentsStates,
      };
    case "subAgentActivity":
      return {
        id: item.id,
        type: "subagent_activity",
        kind: item.kind,
        agent_thread_id: item.agentThreadId,
        agent_path: item.agentPath,
      };
    case "webSearch":
      return { ...item, type: "web_search" };
    case "imageView":
      return { id: item.id, type: "image_view", path: item.path };
    case "imageGeneration":
      return { ...item, type: "image_generation" };
    case "contextCompaction":
      return { id: item.id, type: "context_compaction" };
    case "reasoning":
      return {
        id: item.id,
        type: "reasoning",
        summary: Array.isArray(item.summary) ? item.summary.join("\n") : item.summary,
        text: Array.isArray(item.content) ? item.content.join("\n") : item.content,
      };
    default:
      return item;
  }
}

function snakeUsage(value: unknown): Record<string, number> | null {
  const usage = record(value);
  const fields: [string, unknown][] = [
    ["total_tokens", usage.totalTokens],
    ["input_tokens", usage.inputTokens],
    ["cached_input_tokens", usage.cachedInputTokens],
    ["cache_write_input_tokens", usage.cacheWriteInputTokens],
    ["output_tokens", usage.outputTokens],
    ["reasoning_output_tokens", usage.reasoningOutputTokens],
  ];
  const normalized: Record<string, number> = {};
  for (const [name, amount] of fields) {
    if (typeof amount === "number") normalized[name] = amount;
  }
  return Object.keys(normalized).length > 0 ? normalized : null;
}

/**
 * Long-lived Codex app-server turn.
 *
 * `turn/steer` is guarded by the active turn id and accepts a stable client
 * message id. Start/completion and usage were live-reverified on 0.153.4
 * with gpt-6-astra, and all shapes were checked against its generated schema.
 * Steering was last live-probed on 0.149.0 during a shell sleep.
 *
 * Child threads (Multi-Agent V2 on 0.153.4): the app-server attaches this
 * connection to every thread the turn spawns, so a child's items, and its own
 * `turn/completed`, arrive here tagged with the child's `threadId`. Each item
 * is forwarded with that `thread_id` so the activity stream can nest it, a
 * child's turn completion becomes `subagent.completed` rather than the
 * parent's terminal, and one metadata-only `thread/read` per child supplies
 * the model, effort and role that the spawn marker lacks.
 */
export class CodexLiveDriver {
  readonly ready: Promise<void>;

  private readonly peer: JsonRpcPeer;
  private terminal = false;
  private threadId: string | null;
  private turnId: string | null = null;
  private model: string | null;
  private usage: Record<string, number> | null = null;
  private readonly children = new Set<string>();

  constructor(private readonly options: CodexLiveOptions) {
    this.threadId = options.sessionId;
    this.model = options.model;
    this.peer = new JsonRpcPeer({
      sink: options.sink,
      label: "Codex app-server",
      errorMessage: rpcError,
    });
    this.ready = this.boot().catch(async (error) => {
      const message = error instanceof Error ? error.message : String(error);
      this.options.emit({ type: "error", message });
      this.options.emit({ type: "turn.failed", error: { message } });
      this.terminal = true;
      await this.close();
      throw error;
    });
  }

  private async boot(): Promise<void> {
    await this.call("initialize", {
      clientInfo: { name: "wisp", title: "Wisp", version: "0.4" },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    await this.notify("initialized");

    const opened = record(
      await this.call(
        this.threadId ? "thread/resume" : "thread/start",
        this.threadId ? { threadId: this.threadId, ...threadOptions(this.options) } : threadOptions(this.options),
      ),
    );
    const thread = record(opened.thread);
    if (typeof thread.id !== "string" || !thread.id) throw new Error("Codex opened without returning a thread id");
    this.threadId = thread.id;
    if (typeof opened.model === "string") this.model = opened.model;
    this.options.emit({ type: "thread.started", thread_id: this.threadId, model: this.model });

    const turnParams: Record<string, unknown> = {
      threadId: this.threadId,
      clientUserMessageId: this.options.initialMessageId,
      input: this.options.initialInput,
      cwd: this.options.cwd,
    };
    if (this.options.model) turnParams.model = this.options.model;
    if (this.options.effort) turnParams.effort = this.options.effort;
    const started = record(await this.call("turn/start", turnParams));
    const turn = record(started.turn);
    if (typeof turn.id !== "string" || !turn.id) throw new Error("Codex started without returning a turn id");
    this.turnId = turn.id;
  }

  async send(messageId: string, input: CodexLiveInput[]): Promise<void> {
    await this.ready;
    if (this.terminal || !this.threadId || !this.turnId) throw new Error("Codex turn already completed");
    const steered = record(
      await this.call("turn/steer", {
        threadId: this.threadId,
        expectedTurnId: this.turnId,
        clientUserMessageId: messageId,
        input,
      }),
    );
    if (steered.turnId !== this.turnId) throw new Error("Codex acknowledged steering for a different turn");
  }

  private call(method: string, params: Record<string, unknown>): Promise<unknown> {
    return this.peer.call(method, params);
  }

  private notify(method: string): Promise<void> {
    return this.peer.notify(method);
  }

  handle(frame: RpcFrame): void {
    if (this.peer.handle(frame)) return;
    if (typeof frame.method !== "string") return;
    const params = record(frame.params);
    switch (frame.method) {
      case "item/started":
      case "item/completed": {
        const item = record(params.item);
        if (item.type === "userMessage") return;
        const threadId = str(params.threadId);
        this.options.emit({
          type: frame.method === "item/started" ? "item.started" : "item.completed",
          item: snakeItem(params.item),
          timestamp: params.startedAtMs ?? params.completedAtMs ?? null,
          ...(threadId ? { thread_id: threadId } : {}),
        });
        if (item.type === "subAgentActivity" && item.kind === "started" && str(item.agentThreadId)) {
          void this.describeChild(item.agentThreadId as string);
        }
        return;
      }
      case "thread/tokenUsage/updated":
        if (!this.turnId || params.turnId === this.turnId) this.usage = snakeUsage(record(params.tokenUsage).last);
        return;
      case "turn/completed": {
        if (this.terminal) return;
        const turn = record(params.turn);
        const threadId = str(params.threadId);
        if (threadId && this.threadId && threadId !== this.threadId) {
          // A child's turn settling is that card's outcome, never ours.
          this.options.emit({
            type: "subagent.completed",
            thread_id: threadId,
            status: str(turn.status),
            error: str(record(turn.error).message),
            result: lastAgentMessage(turn.items),
            duration_ms: typeof turn.durationMs === "number" ? turn.durationMs : null,
            timestamp: typeof turn.completedAt === "number" ? turn.completedAt * 1000 : null,
          });
          return;
        }
        if (this.turnId && turn.id !== this.turnId) return;
        if (turn.status !== "completed") {
          this.options.emit({
            type: "turn.failed",
            error: record(turn.error).message
              ? turn.error
              : { message: `Codex turn ${String(turn.status ?? "failed")}` },
            usage: this.usage,
          });
        } else {
          this.options.emit({ type: "turn.completed", usage: this.usage });
        }
        this.terminal = true;
        this.options.onTerminal();
        return;
      }
      case "error":
        if (typeof record(params.error).message === "string") {
          this.options.emit({ type: "error", message: record(params.error).message });
        }
        return;
    }
  }

  /**
   * A V2 spawn marker names only the child's thread and agent path; the
   * model, effort and role live on its Thread record. One metadata-only read
   * per child, no history hydration. Failure is silent: the card simply stays
   * unlabelled, and nothing here may throw into the frame pump.
   */
  private async describeChild(threadId: string): Promise<void> {
    if (this.children.has(threadId)) return;
    this.children.add(threadId);
    try {
      const response = record(await this.call("thread/read", { threadId, includeTurns: false }));
      const thread = record(response.thread);
      if (this.terminal) return;
      this.options.emit({
        type: "thread.child",
        thread_id: threadId,
        parent_thread_id: str(thread.parentThreadId),
        model: str(thread.model),
        reasoning_effort: str(thread.reasoningEffort),
        agent_role: str(thread.agentRole),
        agent_nickname: str(thread.agentNickname),
      });
    } catch {
      // The child still renders from its markers and items.
    }
  }

  failPending(message: string): void {
    this.peer.failPending(message);
  }

  close(): Promise<void> {
    return this.peer.close();
  }
}
