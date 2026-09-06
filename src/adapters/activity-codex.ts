import { trunc } from "../text";
import { eventId, type NormalizeContext, status } from "./activity-context";
import { boundedInput, record, string, text, timestamp } from "./activity-value";
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

export function codex(event: Record<string, any>, context: NormalizeContext): ActivityEvent[] {
  if (!["item.started", "item.updated", "item.completed"].includes(event.type)) return [];
  const item = record(event.item);
  const phase = event.type === "item.started" ? "started" : event.type === "item.completed" ? "completed" : "updated";
  const at = timestamp(event);
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
