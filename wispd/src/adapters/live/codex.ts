import { speedTier } from "../argv";
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
  /** Run in the harness's fast lane (def.fastMode); the driver resolves the tier value. */
  fast: boolean;
  initialMessageId: string;
  initialInput: CodexLiveInput[];
  emit: (event: Record<string, unknown>) => void;
  onTerminal: () => void;
  /** The usage JSON Wisp stored for the previous turn, when resuming. */
  previousUsage?: string | null;
  /**
   * The turn's usage report so far, after each update that changed it. Wisp
   * stores it on the turn, so a turn that never reaches `turn/completed` (a
   * killed process, a daemon restart) still leaves the thread's total for the
   * next resume to start from.
   */
  onUsage?: (usage: Record<string, unknown>) => void;
  /**
   * The app-server started a turn of its own on this thread after ours ended:
   * an active Goal continuing (`thread/goal/*`). The driver serves it from
   * here on (its events, usage and terminal follow); the caller decides where
   * they are recorded.
   */
  onContinuation?: (turnId: string) => void;
  /** The thread's goal changed: its status, or null once it was cleared. */
  onGoal?: (goal: CodexGoal | null) => void;
}

/** A thread's Codex Goal as `thread/goal/updated` reports it (experimental API, 0.164.0). */
export interface CodexGoal {
  objective: string;
  /** active | paused | blocked | usageLimited | budgetLimited | complete */
  status: string;
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
  // `serviceTier` (thread/start, thread/resume and turn/start all take it,
  // per codex's own generated schema) rather than `serviceTierForTurn`: a
  // Wisp task's tier is sticky until the user toggles it, and the thread-level
  // field is the one whose meaning is "this turn and subsequent turns".
  const tier = speedTier(options.def, options.fast);
  if (tier) params.serviceTier = tier;
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

/** The app-server's counter names, and the snake_case names Wisp stores them under. */
const USAGE_NAMES: [camel: string, snake: string][] = [
  ["totalTokens", "total_tokens"],
  ["inputTokens", "input_tokens"],
  ["cachedInputTokens", "cached_input_tokens"],
  ["cacheWriteInputTokens", "cache_write_input_tokens"],
  ["outputTokens", "output_tokens"],
  ["reasoningOutputTokens", "reasoning_output_tokens"],
];

function renameUsage(value: unknown, from: 0 | 1): Record<string, number> | null {
  const usage = record(value);
  const renamed: Record<string, number> = {};
  for (const names of USAGE_NAMES) {
    const amount = usage[names[from]];
    if (typeof amount === "number") renamed[names[1 - from]!] = amount;
  }
  return Object.keys(renamed).length > 0 ? renamed : null;
}

function snakeUsage(value: unknown): Record<string, number> | null {
  return renameUsage(value, 0);
}

function sameUsage(a: Record<string, number>, b: Record<string, number>): boolean {
  const names = Object.keys(a);
  return names.length > 0 && names.length === Object.keys(b).length && names.every((name) => a[name] === b[name]);
}

/**
 * What the previous turn's stored usage says about where a resume starts.
 * Since this change Wisp stores the thread's total, trusted only for the same
 * thread. Before it, Wisp stored that turn's final call (`last`), which is
 * exactly what a stale re-send at the start of the next turn carries.
 */
function previousStart(
  usageJson: string | null | undefined,
  threadId: string | null,
): { total: Record<string, number> | null; lastCall: Record<string, number> | null } {
  const none = { total: null, lastCall: null };
  if (!usageJson || !threadId) return none;
  let usage: Record<string, any>;
  try {
    usage = record(JSON.parse(usageJson));
  } catch {
    return none;
  }
  if (usage.thread_id === undefined) return { total: null, lastCall: renameUsage(usage, 1) };
  return usage.thread_id === threadId ? { total: renameUsage(usage.thread_total, 1), lastCall: null } : none;
}

/** `after − before` for every counter `after` reports (camelCase breakdowns). */
function usageDelta(after: unknown, before: Record<string, number>): Record<string, number> {
  const delta: Record<string, number> = {};
  for (const [name, amount] of Object.entries(record(after))) {
    if (typeof amount === "number") delta[name] = amount - (before[name] ?? 0);
  }
  return delta;
}

function addUsage(sum: Record<string, number>, more: Record<string, number>): Record<string, number> {
  const added = { ...sum };
  for (const [name, amount] of Object.entries(more)) added[name] = (added[name] ?? 0) + amount;
  return added;
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
  /** This turn's model calls, summed (camelCase, as the app-server reports them). */
  private turnUsage: Record<string, number> | null = null;
  private lastUsage: Record<string, number> | null = null;
  /** The thread's cumulative `total` as of the latest update; unknown on a resume until it reports. */
  private threadTotal: Record<string, number> | null;
  /** The previous turn's final call, when Wisp stored only that (before it stored totals). */
  private readonly previousLastCall: Record<string, number> | null;
  /** Usage updates that arrived before the turn's id was known; `adoptTurn` sorts them. */
  private heldUsage: Record<string, any>[] = [];
  /**
   * A turn/start Wisp sent after its turn ended is awaiting its answer. One
   * stdout read can carry that answer, the whole turn it started, and the
   * goal's next turn after it, all handled before the answer's promise
   * resolves: every notification meanwhile waits here, and is handled in
   * order once the answer has named the turn.
   */
  private starting: Record<string, unknown>[] | null = null;
  /** The thread's goal as last reported; null when it has none or none was reported. */
  private goalValue: CodexGoal | null = null;
  /** The last report handed to `onUsage`, serialized, so an unchanged re-send writes nothing. */
  private reportedUsage: string | null = null;
  /** Set once turn/start is sent: from then on, the thread's next turn is ours. */
  private turnRequested = false;
  private readonly children = new Set<string>();

  constructor(private readonly options: CodexLiveOptions) {
    this.threadId = options.sessionId;
    // A resume's starting point, in order: the update the app-server replays
    // (set in adoptTurn), then the total Wisp stored at the end of the
    // previous turn, and only then a guess. The stored value comes before
    // guessing because a first update is ambiguous without one: an earlier
    // call re-sent and a new call can both report total == last. A replay
    // always wins, because the stored total can lag after a compact or an
    // attach outside Wisp spends tokens on the thread.
    const previous = previousStart(options.previousUsage, options.sessionId);
    this.threadTotal = options.sessionId ? previous.total : {};
    this.previousLastCall = previous.lastCall;
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
        this.threadId
          ? {
              threadId: this.threadId,
              ...threadOptions(this.options),
              // Resuming still loads the whole session into Codex, but Wisp
              // does not replay old turns from this response. Omitting them
              // keeps a long thread from becoming one enormous JSON-RPC line.
              excludeTurns: true,
            }
          : threadOptions(this.options),
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
    const tier = speedTier(this.options.def, this.options.fast);
    if (tier) turnParams.serviceTier = tier;
    this.turnRequested = true;
    const started = record(await this.call("turn/start", turnParams));
    const turn = record(started.turn);
    if (typeof turn.id !== "string" || !turn.id) throw new Error("Codex started without returning a turn id");
    this.adoptTurn(turn.id);
  }

  /**
   * The turn's id became known: from turn/start's response, or from a
   * notification handled first, because one stdout read can carry the
   * response and the turn's first frames and they are handled before the
   * response's promise resolves. The usage held until now is sorted by the
   * turn each update names, not by when it came: another turn's update is
   * the resume replay, this turn's are its own calls.
   */
  private adoptTurn(turnId: string): void {
    if (this.turnId) return;
    this.turnId = turnId;
    const held = this.heldUsage;
    this.heldUsage = [];
    for (const params of held) {
      // A resume replays the previous turn's update right after its response,
      // excludeTurns or not (live-probed on 0.162.1): the starting point.
      if (params.turnId !== turnId) this.threadTotal = usageDelta(record(params.tokenUsage).total, {});
    }
    for (const params of held) {
      if (params.turnId === turnId) this.recordUsage(params);
    }
  }

  /** The thread's goal, when the app-server has reported one. */
  get goal(): CodexGoal | null {
    return this.goalValue;
  }

  /**
   * Serve a new turn on the same thread after the last one ended: the
   * app-server's own continuation (`turnId` known), or one Wisp is about to
   * start (`startTurn`). The thread's running total carries on; the turn's own
   * usage starts from nothing.
   */
  reopen(turnId?: string): void {
    this.terminal = false;
    this.turnId = null;
    this.turnUsage = null;
    this.lastUsage = null;
    this.reportedUsage = null;
    this.heldUsage = [];
    this.turnRequested = true;
    if (turnId) this.adoptTurn(turnId);
  }

  /**
   * Start a turn with this input on the open thread, after the last one
   * ended (a message taken while it lingers). Until turn/start answers, a
   * turn/started is not taken for a continuation: it is most likely this one
   * (one stdout read can carry it before the answer), and the answer's id
   * says. A refusal (the app-server went on by itself first) throws, and the
   * caller hands the message back.
   */
  async startTurn(messageId: string, input: CodexLiveInput[]): Promise<void> {
    await this.ready;
    if (!this.threadId) throw new Error("Codex has no thread to start a turn on");
    const params: Record<string, unknown> = { threadId: this.threadId, clientUserMessageId: messageId, input, cwd: this.options.cwd };
    if (this.options.model) params.model = this.options.model;
    if (this.options.effort) params.effort = this.options.effort;
    const tier = speedTier(this.options.def, this.options.fast);
    if (tier) params.serviceTier = tier;
    this.reopen();
    this.starting = [];
    let turn: Record<string, any>;
    try {
      turn = record(record(await this.call("turn/start", params)).turn);
    } catch (error) {
      // refused: the caller hands the message back and lets the process go
      this.starting = null;
      this.terminal = true;
      throw error;
    }
    const waiting = this.starting;
    this.starting = null;
    if (typeof turn.id !== "string" || !turn.id) {
      this.terminal = true;
      throw new Error("Codex started without returning a turn id");
    }
    this.adoptTurn(turn.id);
    for (const frame of waiting) this.handle(frame as RpcFrame);
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

  /**
   * `total` is cumulative per THREAD, across resumes (live-probed on
   * 0.162.1), and `last` is the call that just finished. The turn's usage
   * is the total's growth, update by update; the last call alone goes
   * out as `last_usage`, whose prompt is the context size.
   */
  private recordUsage(params: Record<string, any>): void {
    if (!this.turnId) {
      this.heldUsage.push(params);
      return;
    }
    if (params.turnId !== this.turnId) return;
    const tokenUsage = record(params.tokenUsage);
    const total = usageDelta(tokenUsage.total, {});
    if (!this.threadTotal) {
      // Nothing replayed and no total stored. A stale re-send repeats the
      // previous turn's final call, which is what Wisp stored before it stored
      // totals: an exact match is a re-send, anything else a new call. With no
      // previous usage at all, a total that is exactly this call is taken as
      // the thread's first call; anything more may be a re-send.
      const last = usageDelta(tokenUsage.last, {});
      const before = usageDelta(total, last);
      const resent = this.previousLastCall
        ? sameUsage(last, this.previousLastCall)
        : Object.values(before).some((amount) => amount !== 0);
      this.threadTotal = resent ? total : before;
    }
    const growth = usageDelta(total, this.threadTotal);
    // Only a completed call adds prompt tokens. Codex also re-sends an
    // unchanged count (on rate-limit news), and a context-window overflow
    // refills `total` with zeroed counters, which is a reset, not usage.
    if ((growth.inputTokens ?? 0) > 0 && Object.values(growth).every((amount) => amount >= 0)) {
      this.turnUsage = addUsage(this.turnUsage ?? {}, growth);
    }
    this.threadTotal = total;
    this.lastUsage = snakeUsage(tokenUsage.last);
    // After the terminal the turn's completion report is the record; and a
    // failed write must never throw into the frame pump or boot.
    const report = this.terminal ? null : this.usageReport();
    const serialized = report ? JSON.stringify(report) : null;
    if (report && serialized !== this.reportedUsage) {
      try {
        this.options.onUsage?.(report);
        this.reportedUsage = serialized;
      } catch {
        // the next changed (or re-sent) update writes it again
      }
    }
  }

  /** The turn's summed usage, stored with the thread's total so the next resume can start from it. */
  private usageReport(): Record<string, unknown> | null {
    const usage = snakeUsage(this.turnUsage);
    const threadTotal = snakeUsage(this.threadTotal);
    if (!usage && !threadTotal) return null;
    return { ...usage, ...(threadTotal ? { thread_id: this.threadId, thread_total: threadTotal } : {}) };
  }

  handle(frame: RpcFrame): void {
    if (this.peer.handle(frame)) return;
    if (typeof frame.method !== "string") return;
    if (this.starting && frame.id === undefined) {
      this.starting.push(frame as Record<string, unknown>);
      return;
    }
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
        this.recordUsage(params);
        return;
      case "turn/started":
        this.turnStarted(params);
        return;
      case "thread/goal/updated":
      case "thread/goal/cleared":
        this.goalChanged(frame.method, params);
        return;
      case "turn/completed":
        this.turnCompleted(params);
        return;
      case "error":
        if (typeof record(params.error).message === "string") {
          this.options.emit({ type: "error", message: record(params.error).message });
        }
        return;
    }
  }

  private turnStarted(params: Record<string, any>): void {
    const turnId = str(record(params.turn).id);
    if (!turnId || str(params.threadId) !== this.threadId) return;
    if (this.terminal && turnId !== this.turnId) {
      // Ours ended, and the app-server went on by itself (an active Goal):
      // everything from here is that turn's, recorded or not.
      this.reopen(turnId);
      this.options.onContinuation?.(turnId);
    } else if (this.turnRequested) {
      this.adoptTurn(turnId);
    }
  }

  private goalChanged(method: string, params: Record<string, any>): void {
    if (str(params.threadId) !== this.threadId) return;
    const goal = record(params.goal);
    this.goalValue = method === "thread/goal/updated" && typeof goal.status === "string"
      ? { objective: str(goal.objective) ?? "", status: goal.status }
      : null;
    this.options.onGoal?.(this.goalValue);
  }

  private turnCompleted(params: Record<string, any>): void {
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
    if (!this.turnId && this.turnRequested && str(turn.id)) this.adoptTurn(turn.id);
    if (this.turnId && turn.id !== this.turnId) return;
    if (turn.status !== "completed") {
      this.options.emit({
        type: "turn.failed",
        error: record(turn.error).message
          ? turn.error
          : { message: `Codex turn ${String(turn.status ?? "failed")}` },
        usage: this.usageReport(),
        last_usage: this.lastUsage,
      });
    } else {
      this.options.emit({ type: "turn.completed", usage: this.usageReport(), last_usage: this.lastUsage });
    }
    this.terminal = true;
    this.options.onTerminal();
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
