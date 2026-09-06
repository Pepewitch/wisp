import { trunc } from "../text";
import { eventId, type NormalizeContext, status } from "./activity-context";
import { boundedInput, number, record, string, text, timestamp } from "./activity-value";
import type { ActivityEvent } from "./types";

/**
 * Codex activity normalizer. Two wire dialects reach it: `codex exec --json`
 * (snake_case tools and statuses, fixtures in tests/fixtures/codex-*.jsonl)
 * and the app-server driver's snake-keyed projection of camelCase items
 * (`spawnAgent`, `inProgress`, `subagent_activity` markers; see
 * tests/fixtures/codex-live-subagent.jsonl).
 */
function codexAgentStates(item: Record<string, any>): ActivityEvent[] {
  const out: ActivityEvent[] = [];
  for (const [agentId, rawState] of Object.entries(record(item.agents_states))) {
    const state = record(rawState);
    const next = status(state.status ?? state.state, "unknown");
    out.push({
      kind: "subagent",
      id: agentId,
      agentId,
      parentId: null,
      phase: next === "running" ? "updated" : "completed",
      status: next,
      result: next === "completed" ? text(state.message ?? state.output ?? state.result) : null,
      error: next === "failed" ? text(state.error ?? state.message) ?? "Subagent failed" : null,
    });
  }
  return out;
}

type CodexPhase = "started" | "updated" | "completed";

/** `spawnAgent` (app-server) and `spawn_agent` (`codex exec --json`) are one tool. */
function snakeCase(value: string): string {
  return value.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`);
}

/** The last segment of a Codex agent path (`/root/review_plan` → `review_plan`). */
function codexAgentName(value: unknown): string | null {
  const path = string(value)?.trim().replace(/\/+$/, "");
  if (!path) return null;
  const name = path.slice(path.lastIndexOf("/") + 1);
  return trunc(name || path, 200);
}

/**
 * Codex app-server marks a child thread's lifecycle with `subagent_activity`
 * items (`started`, `interacted`, `interrupted`, `completed`). On 0.153.4 this
 * is the ONLY spawn signal: no `spawn_agent` collab call arrives, and the
 * parent's `wait` carries empty `agents_states`. Each marker's own item id is
 * fresh (`call_…` for the spawn, `subagent-completed-…` for the end), so the
 * child thread id is the correlation key. The same payload arrives on both
 * item.started and item.completed; the UI collapses the repeat.
 */
function codexSubagentActivity(
  item: Record<string, any>,
  phase: CodexPhase,
  at: string | number | null,
  context: NormalizeContext,
): ActivityEvent[] {
  const agentId = string(item.agent_thread_id);
  if (!agentId) return [];
  const kind = string(item.kind)?.toLowerCase() ?? null;
  // The child's own turn/completed already said how it ended; a trailing
  // "completed" marker must not repaint a failed or interrupted card.
  if (kind !== "started" && context.settled.has(agentId)) return [];
  const next = status(kind, "unknown");
  const spawn = kind === "started";
  const id = spawn ? eventId(item.id, context, "subagent") : agentId;
  context.subagents.add(id);
  context.subagents.add(agentId);
  return [{
    kind: "subagent",
    id,
    agentId,
    parentId: null,
    timestamp: at,
    phase: spawn && phase === "started" ? "started" : next === "running" || next === "unknown" ? "updated" : "completed",
    status: next,
    title: codexAgentName(item.agent_path),
    background: true,
  }];
}

function codexCollaboration(
  item: Record<string, any>,
  phase: CodexPhase,
  at: string | number | null,
  context: NormalizeContext,
): ActivityEvent[] {
  const tool = snakeCase(string(item.tool) ?? "collaboration");
  const id = eventId(item.id, context, "subagent");
  if (tool === "spawn_agent") {
    if (phase === "started") context.subagents.add(id);
    const next = status(item.status, "running");
    const agentId = Array.isArray(item.receiver_thread_ids) ? string(item.receiver_thread_ids[0]) : null;
    return [{
      kind: "subagent",
      id,
      agentId,
      parentId: null,
      timestamp: at,
      phase: phase === "started" ? "started" : next === "failed" ? "completed" : "updated",
      status: next === "failed" ? "failed" : "running",
      title: string(item.description) ?? null,
      model: string(item.model) ?? null,
      effort: string(item.reasoning_effort) ?? null,
      prompt: string(item.prompt) ?? null,
      error: next === "failed" ? text(item.error) ?? "Subagent failed to start" : null,
      background: true,
    }];
  }
  const states = codexAgentStates(item);
  if (states.length) return states.map((state) => ({ ...state, timestamp: at }));
  const receivers = Array.isArray(item.receiver_thread_ids)
    ? item.receiver_thread_ids.map(string).filter(Boolean) as string[]
    : [];
  const next =
    tool === "interrupt_agent" || tool === "close_agent"
      ? "stopped"
      : status(item.status, tool === "resume_agent" || tool === "send_input" ? "running" : "unknown");
  return receivers.map((agentId) => ({
    kind: "subagent" as const,
    id: agentId,
    agentId,
    parentId: null,
    timestamp: at,
    phase: next === "running" ? "updated" as const : "completed" as const,
    status: next,
  }));
}

function codexCommand(
  item: Record<string, any>,
  phase: CodexPhase,
  at: string | number | null,
  context: NormalizeContext,
): ActivityEvent[] {
  const id = eventId(item.id, context, "tool");
  if (phase === "started") {
    return [{
      kind: "tool",
      id,
      parentId: null,
      timestamp: at,
      phase: "started",
      name: "Run",
      input: boundedInput({ command: item.command }),
    }];
  }
  if (phase !== "completed") return [];
  const code = typeof item.exit_code === "number" ? item.exit_code : null;
  return [{
    kind: "tool",
    id,
    parentId: null,
    timestamp: at,
    phase: "completed",
    name: "Run",
    output: text(item.aggregated_output),
    error: code !== null && code !== 0 ? `Exited ${code}` : null,
  }];
}

/**
 * Which card an event belongs to: null for the turn's own thread, otherwise
 * the child thread that emitted it. `codex exec --json` never tags events, so
 * everything stays at the top level there.
 */
function codexScope(event: Record<string, any>, context: NormalizeContext): string | null {
  const thread = string(event.thread_id);
  if (!thread || thread === context.rootThread) return null;
  if (context.subagents.has(thread)) return thread;
  return context.rootThread ? thread : null;
}

/**
 * A child starts working before the parent's spawn marker is delivered, so
 * its first item can outrun the card. Open the card from the thread id alone;
 * the marker and the metadata read fill in title, model and role later.
 */
function codexOpenChild(thread: string, at: string | number | null, context: NormalizeContext): ActivityEvent[] {
  if (context.subagents.has(thread)) return [];
  context.subagents.add(thread);
  return [{
    kind: "subagent",
    id: thread,
    agentId: thread,
    parentId: null,
    timestamp: at,
    phase: "started",
    status: "running",
    background: true,
  }];
}

/** `thread.child`: the driver's metadata-only read of a spawned thread. */
function codexChildThread(event: Record<string, any>, context: NormalizeContext): ActivityEvent[] {
  const id = string(event.thread_id);
  if (!id) return [];
  const settled = context.settled.get(id);
  return [...codexOpenChild(id, null, context), {
    kind: "subagent",
    id,
    agentId: id,
    parentId: null,
    phase: settled ? "completed" : "updated",
    status: settled ?? "running",
    model: string(event.model),
    effort: string(event.reasoning_effort),
    agentType: string(event.agent_role),
  }];
}

/** `subagent.completed`: a child thread's own turn/completed, the authoritative outcome. */
function codexChildTurn(event: Record<string, any>, context: NormalizeContext): ActivityEvent[] {
  const id = string(event.thread_id);
  if (!id) return [];
  const at = timestamp(event);
  const next = status(event.status, "completed");
  const opened = codexOpenChild(id, at, context);
  if (next === "running" || next === "unknown") return opened;
  context.settled.set(id, next);
  return [...opened, {
    kind: "subagent",
    id,
    agentId: id,
    parentId: null,
    timestamp: at,
    phase: "completed",
    status: next,
    result: next === "completed" ? text(event.result) : null,
    error: next === "failed" ? text(event.error) ?? "Subagent turn failed" : null,
    durationMs: number(event.duration_ms),
  }];
}

export function codex(event: Record<string, any>, context: NormalizeContext): ActivityEvent[] {
  if (event.type === "thread.started") {
    context.rootThread = string(event.thread_id) ?? context.rootThread;
    return [];
  }
  if (event.type === "thread.child") return codexChildThread(event, context);
  if (event.type === "subagent.completed") return codexChildTurn(event, context);
  if (!["item.started", "item.updated", "item.completed"].includes(event.type)) return [];
  const item = record(event.item);
  const phase = event.type === "item.started" ? "started" : event.type === "item.completed" ? "completed" : "updated";
  const at = timestamp(event);
  const parentId = codexScope(event, context);
  const opened = parentId ? codexOpenChild(parentId, at, context) : [];
  const scoped = codexItem(item, phase, at, context).map((entry) =>
    // A marker about the child itself, emitted on the child's thread, is not its own child.
    entry.kind === "subagent" && (entry.id === parentId || entry.agentId === parentId) ? entry : { ...entry, parentId },
  );
  return [...opened, ...scoped];
}

function codexItem(
  item: Record<string, any>,
  phase: CodexPhase,
  at: string | number | null,
  context: NormalizeContext,
): ActivityEvent[] {
  if (item.type === "agent_message" && phase === "completed" && string(item.text)) {
    return [{ kind: "text", id: eventId(item.id, context, "text"), parentId: null, timestamp: at, text: trunc(item.text.trim(), 4_000) }];
  }
  if (item.type === "reasoning" && phase === "completed") {
    const value = string(item.text ?? item.summary);
    return value ? [{ kind: "thinking", id: eventId(item.id, context, "thinking"), parentId: null, timestamp: at, text: trunc(value, 4_000) }] : [];
  }
  if (item.type === "collab_tool_call") {
    return codexCollaboration(item, phase, at, context);
  }
  if (item.type === "subagent_activity") {
    return codexSubagentActivity(item, phase, at, context);
  }
  if (item.type === "command_execution") {
    return codexCommand(item, phase, at, context);
  }
  if (item.type === "error" && phase === "completed") {
    return [{ kind: "text", id: eventId(item.id, context, "error"), parentId: null, timestamp: at, text: `Error: ${text(item.message) ?? "Unknown error"}` }];
  }
  if (phase === "completed" && string(item.type)) {
    return [{
      kind: "tool",
      id: eventId(item.id, context, "tool"),
      parentId: null,
      timestamp: at,
      phase: "completed",
      name: item.type,
      output: text(item),
    }];
  }
  return [];
}
