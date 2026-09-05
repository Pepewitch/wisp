import { trunc } from "../text";
import { isRecord } from "../validate";
import { boundedInput, text } from "./activity-value";
import { formatParsedEvent } from "./format";
import type { ActivityEvent, ActivityStatus, AdapterDef } from "./types";
import { createEventLineDecoder, cursorToolCall } from "./wire";

interface NormalizeContext {
  id(kind: string): string;
  subagents: Set<string>;
  /** Call id → whether Task returned before the background child settled. */
  background: Map<string, boolean>;
  /** Monitoring call id → child id, used by Droid TaskOutput/TaskStop. */
  toolParents: Map<string, string>;
}

type ActivityNormalizer = (event: Record<string, any>, context: NormalizeContext) => ActivityEvent[];

function record(value: unknown): Record<string, any> {
  return isRecord(value) ? value : {};
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function number(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function timestamp(event: Record<string, any>): string | number | null {
  const value = event.timestamp ?? event.timestamp_ms ?? event.occurred_at_ms;
  return typeof value === "string" || typeof value === "number" ? value : null;
}

function eventId(value: unknown, context: NormalizeContext, kind: string): string {
  return string(value) ?? context.id(kind);
}

function taskFields(inputValue: unknown): Pick<
  Extract<ActivityEvent, { kind: "subagent" }>,
  "title" | "agentType" | "model" | "effort" | "prompt"
> {
  const input = record(inputValue);
  const title = string(input.description) ?? string(input.title);
  const subagentType = record(input.subagentType);
  const cursorType = Object.keys(subagentType).find((key) => key !== "unspecified") ?? null;
  const agentType =
    string(input.subagent_type) ?? string(input.agent_type) ?? string(input.type) ?? cursorType;
  const model = string(input.model);
  const effort = string(input.complexity) ?? string(input.effort) ?? string(input.reasoning_effort);
  const prompt = string(input.prompt);
  return {
    title: title ? trunc(title, 200) : null,
    agentType: agentType ? trunc(agentType, 100) : null,
    model: model ? trunc(model, 100) : null,
    effort: effort ? trunc(effort, 100) : null,
    prompt: prompt ? trunc(prompt, 4_000) : null,
  };
}

function status(value: unknown, fallback: ActivityStatus = "unknown"): ActivityStatus {
  const raw = string(value)?.toLowerCase();
  if (!raw) return fallback;
  if (["running", "in_progress", "pending", "started", "interacted", "working"].includes(raw)) return "running";
  if (["completed", "complete", "done", "success", "succeeded", "finished"].includes(raw)) return "completed";
  if (["failed", "failure", "error", "errored", "refused"].includes(raw)) return "failed";
  if (["stopped", "cancelled", "canceled", "interrupted", "killed", "closed"].includes(raw)) return "stopped";
  return fallback;
}

function isSubagentTool(name: string | null): boolean {
  return name === "Task" || name === "Agent" || name === "spawn_agent";
}

function claudeSystem(event: Record<string, any>, context: NormalizeContext): ActivityEvent[] {
  if (typeof event.subtype !== "string" || !event.subtype.startsWith("task_")) return [];
  const at = timestamp(event);
  const callId = string(event.tool_use_id);
  const agentId = string(event.task_id);
  const id = callId ?? agentId;
  if (!id) return [];
  // Claude also emits task_* for ordinary Bash (`local_bash`). That wraps a
  // tool, not a child agent — treating it as a subagent steals the Bash
  // result and paints a completed card whose start time is the result (0s).
  const agentTask = string(event.task_type) === "local_agent" || Boolean(string(event.subagent_type))
    || Boolean(callId && context.subagents.has(callId)) || Boolean(agentId && context.subagents.has(agentId));
  if (!agentTask) return [];
  const patch = record(event.patch);
  const usage = record(event.usage);
  const next = status(
    event.status ?? patch.status,
    event.subtype === "task_started" || event.subtype === "task_progress" ? "running" : "unknown",
  );
  const terminal = next !== "running" && next !== "unknown";
  if (callId) {
    context.subagents.add(callId);
    if (event.is_backgrounded === true) context.background.set(callId, true);
  }
  if (agentId) context.subagents.add(agentId);
  return [{
    kind: "subagent",
    id,
    agentId,
    parentId: null,
    timestamp: patch.end_time ?? at,
    phase: event.subtype === "task_started" ? "updated" : terminal ? "completed" : "updated",
    status: next,
    title: event.subtype === "task_started" ? string(event.description) : null,
    agentType: string(event.subagent_type),
    prompt: event.subtype === "task_started" ? string(event.prompt) : null,
    result: next === "completed" ? text(event.summary) : null,
    error: next === "failed" ? text(event.summary ?? event.error) ?? "Subagent failed" : null,
    durationMs: number(usage.duration_ms),
    background: event.is_backgrounded === true || (callId ? context.background.get(callId) === true : false),
  }];
}

function claudeAssistant(event: Record<string, any>, context: NormalizeContext): ActivityEvent[] {
  const parentId = string(event.parent_tool_use_id);
  const at = timestamp(event);
  const out: ActivityEvent[] = [];
  for (const content of event.message?.content ?? []) {
    const item = record(content);
    if (item.type === "text" && string(item.text)) {
      out.push({
        kind: "text",
        id: eventId(item.id, context, "text"),
        parentId,
        timestamp: at,
        text: trunc(item.text.trim(), 4_000),
      });
    } else if (item.type === "thinking") {
      out.push({
        kind: "thinking",
        id: eventId(item.id, context, "thinking"),
        parentId,
        timestamp: at,
        text: string(item.thinking) ? trunc(item.thinking.trim(), 4_000) : null,
      });
    } else if (item.type === "tool_use") {
      const id = eventId(item.id, context, "tool");
      const name = string(item.name) ?? "tool";
      if (isSubagentTool(name)) {
        context.subagents.add(id);
        const input = record(item.input);
        const background = input.run_in_background === true;
        context.background.set(id, background);
        out.push({
          kind: "subagent",
          id,
          parentId,
          timestamp: at,
          phase: "started",
          status: "running",
          background,
          ...taskFields(item.input),
        });
      } else {
        out.push({ kind: "tool", id, parentId, timestamp: at, phase: "started", name, input: boundedInput(item.input) });
      }
    }
  }
  return out;
}

function claudeUser(event: Record<string, any>, context: NormalizeContext): ActivityEvent[] {
  const parentId = string(event.parent_tool_use_id);
  const at = timestamp(event);
  const out: ActivityEvent[] = [];
  for (const content of event.message?.content ?? []) {
    const item = record(content);
    if (item.type !== "tool_result") continue;
    const id = eventId(item.tool_use_id, context, "tool");
    const result = text(item.content);
    const error = item.is_error === true ? result ?? "Subagent failed" : null;
    if (context.subagents.has(id)) {
      const background = context.background.get(id) === true;
      const outcome = record(event.tool_use_result);
      out.push({
        kind: "subagent",
        id,
        parentId,
        timestamp: at,
        phase: background && !error ? "updated" : "completed",
        status: error ? "failed" : background ? "running" : "completed",
        result: error || background ? null : result,
        error,
        durationMs: number(outcome.totalDurationMs) ?? number(record(outcome.usage).duration_ms),
        background,
      });
    } else {
      out.push({
        kind: "tool",
        id,
        parentId,
        timestamp: at,
        phase: "completed",
        name: "tool",
        output: error ? null : result,
        error,
      });
    }
  }
  return out;
}

function claude(event: Record<string, any>, context: NormalizeContext): ActivityEvent[] {
  if (event.type === "system") return claudeSystem(event, context);
  if (event.type === "assistant") return claudeAssistant(event, context);
  if (event.type === "user") return claudeUser(event, context);
  return [];
}

interface DroidCompletion {
  taskId: string;
  reason: string | null;
  description: string | null;
  output: string | null;
}

function droidCompletion(value: string): DroidCompletion | null {
  if (!value.startsWith("Background task completed.")) return null;
  const field = (name: string): string | null => {
    const match = new RegExp(`(?:^|\\n)${name}:\\s*([^\\n]+)`, "i").exec(value);
    return match?.[1]?.trim() || null;
  };
  const output = /(?:^|\n)output:\s*([\s\S]*)$/i.exec(value)?.[1]?.trim() || null;
  const taskId = field("task_id");
  return taskId ? { taskId, reason: field("reason"), description: field("description"), output } : null;
}

function taskIdFrom(value: string): string | null {
  return /(?:^|\n)task_id:\s*([^\s\n]+)/i.exec(value)?.[1] ?? null;
}

function sessionIdFrom(value: string): string | null {
  return /(?:^|\n)session_id:\s*([^\s\n]+)/i.exec(value)?.[1] ?? null;
}

function taskReport(value: string): string | null {
  const report = value
    .split("\n")
    .filter((line) => !/^(task_id|session_id|type|description):\s*/i.test(line))
    .join("\n")
    .trim();
  return report || null;
}

function droidMessage(event: Record<string, any>, context: NormalizeContext): ActivityEvent[] {
  const at = timestamp(event);
  const value = string(event.text);
  if (!value) return [];
  const completion = droidCompletion(value);
  if (completion) {
    const state = status(completion.reason, "unknown");
    return [{
      kind: "subagent",
      id: completion.taskId,
      agentId: completion.taskId,
      parentId: null,
      timestamp: at,
      phase: "completed",
      status: state,
      title: completion.description,
      result: state === "failed" ? null : completion.output,
      error: state === "failed" ? completion.output ?? completion.reason ?? "Subagent failed" : null,
    }];
  }
  return event.role === "assistant"
    ? [{
        kind: "text",
        id: eventId(event.id ?? event.messageId, context, "text"),
        parentId: null,
        timestamp: at,
        text: trunc(value, 4_000),
      }]
    : [];
}

function droidReasoning(event: Record<string, any>, context: NormalizeContext): ActivityEvent[] {
  const value = string(event.text);
  return value
    ? [{
        kind: "thinking",
        id: eventId(event.id, context, "thinking"),
        parentId: null,
        timestamp: timestamp(event),
        text: trunc(value, 4_000),
      }]
    : [];
}

function droidToolCall(event: Record<string, any>, context: NormalizeContext): ActivityEvent[] {
  const id = eventId(event.id ?? event.toolCallId, context, "tool");
  const name = string(event.toolName ?? event.toolId) ?? "tool";
  const input = event.parameters ?? {};
  if (name === "Task") {
    context.subagents.add(id);
    const background = record(input).await !== true;
    context.background.set(id, background);
    return [{
      kind: "subagent",
      id,
      parentId: null,
      timestamp: timestamp(event),
      phase: "started",
      status: "running",
      background,
      ...taskFields(input),
    }];
  }
  const childId = ["TaskOutput", "TaskStop"].includes(name) ? string(record(input).task_id) : null;
  if (childId) context.toolParents.set(id, childId);
  return [{
    kind: "tool",
    id,
    parentId: childId,
    timestamp: timestamp(event),
    phase: "started",
    name,
    input: boundedInput(input),
  }];
}

function droidToolResult(event: Record<string, any>, context: NormalizeContext): ActivityEvent[] {
  const id = eventId(event.id ?? event.toolCallId ?? event.toolId, context, "tool");
  const value = text(event.value ?? event.error);
  const error = event.isError === true ? value ?? "Tool failed" : null;
  if (context.subagents.has(id)) {
    const background = context.background.get(id) === true;
    const agentId = value ? taskIdFrom(value) ?? sessionIdFrom(value) : null;
    return [{
      kind: "subagent",
      id,
      agentId,
      parentId: null,
      timestamp: timestamp(event),
      phase: background && !error ? "updated" : "completed",
      status: error ? "failed" : background ? "running" : "completed",
      result: background || error || !value ? null : taskReport(value),
      error,
      background,
    }];
  }
  return [{
    kind: "tool",
    id,
    parentId: context.toolParents.get(id) ?? null,
    timestamp: timestamp(event),
    phase: "completed",
    name: "tool",
    output: error ? null : value,
    error,
  }];
}

function droid(event: Record<string, any>, context: NormalizeContext): ActivityEvent[] {
  if (event.type === "message") return droidMessage(event, context);
  if (event.type === "reasoning") return droidReasoning(event, context);
  if (event.type === "tool_call") return droidToolCall(event, context);
  if (event.type === "tool_result") return droidToolResult(event, context);
  return [];
}

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

function codexCollaboration(
  item: Record<string, any>,
  phase: CodexPhase,
  at: string | number | null,
  context: NormalizeContext,
): ActivityEvent[] {
  const tool = string(item.tool) ?? "collaboration";
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

function codex(event: Record<string, any>, context: NormalizeContext): ActivityEvent[] {
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

function cursorTaskResult(value: unknown): {
  status: ActivityStatus;
  agentId: string | null;
  result: string | null;
  error: string | null;
  durationMs: number | null;
  background: boolean;
} {
  const result = record(value);
  const failed = record(result.error);
  if (Object.keys(failed).length) {
    return {
      status: "failed",
      agentId: null,
      result: null,
      error: text(failed.error ?? failed.message ?? failed) ?? "Subagent failed",
      durationMs: null,
      background: false,
    };
  }
  const success = record(result.success ?? result);
  const background = success.isBackground === true;
  const steps = Array.isArray(success.conversationSteps) ? success.conversationSteps : [];
  let conversationResult: string | null = null;
  for (let index = steps.length - 1; index >= 0 && !conversationResult; index--) {
    const step = record(steps[index]);
    const message = record(step.assistantMessage);
    conversationResult = string(message.text);
  }
  return {
    status: background ? "running" : "completed",
    agentId: string(success.agentId),
    result: text(conversationResult),
    error: null,
    durationMs: number(success.durationMs),
    background,
  };
}

function cursor(event: Record<string, any>, context: NormalizeContext): ActivityEvent[] {
  const at = timestamp(event);
  if (event.type === "assistant") {
    return (event.message?.content ?? []).flatMap((raw: unknown) => {
      const item = record(raw);
      const value = string(item.text);
      return item.type === "text" && value
        ? [{ kind: "text" as const, id: eventId(item.id, context, "text"), parentId: null, timestamp: at, text: trunc(value, 4_000) }]
        : [];
    });
  }
  if (event.type === "tool_call") {
    const callId = eventId(event.call_id, context, "tool");
    const { key, body, name, input } = cursorToolCall(event);
    if (key === "taskToolCall") {
      if (event.subtype === "started") {
        context.subagents.add(callId);
        return [{
          kind: "subagent",
          id: callId,
          parentId: null,
          timestamp: at,
          phase: "started",
          status: "running",
          background: false,
          ...taskFields(input),
        }];
      }
      const outcome = cursorTaskResult(body.result ?? body);
      return [{
        kind: "subagent",
        id: callId,
        parentId: null,
        timestamp: at,
        phase: outcome.status === "running" ? "updated" : "completed",
        ...outcome,
      }];
    }
    if (event.subtype === "completed") {
      const outcome = body.result ?? body.output ?? body;
      return [{ kind: "tool", id: callId, parentId: null, timestamp: at, phase: "completed", name, output: text(outcome) }];
    }
    return [{
      kind: "tool",
      id: callId,
      parentId: null,
      timestamp: at,
      phase: "started",
      name,
      input: boundedInput(input),
    }];
  }
  return [];
}

export const ACTIVITY_NORMALIZERS: Record<string, ActivityNormalizer> = {
  "claude-stream-json": claude,
  "droid-stream-json": droid,
  "cursor-stream-json": cursor,
  "codex-jsonl": codex,
};

/**
 * Stateful, per-turn JSONL → canonical activity renderer. Raw logs remain the
 * evidence ledger; this stream is a compact UI projection. Unknown/custom
 * adapters degrade to their existing human formatter as prose rather than
 * leaking wire JSON or pretending to understand a lifecycle.
 */
export function createActivityFormatter(def?: AdapterDef): (line: string) => ActivityEvent[] {
  let sequence = 0;
  const context: NormalizeContext = {
    id: (kind) => `${kind}-${++sequence}`,
    subagents: new Set(),
    background: new Map(),
    toolParents: new Map(),
  };
  const normalizer = def?.activity ? ACTIVITY_NORMALIZERS[def.activity] : undefined;
  if (def?.activity && !normalizer) {
    const known = Object.keys(ACTIVITY_NORMALIZERS).join(", ");
    throw new Error(`adapter activity '${def.activity}' is not a known activity normalizer (known: ${known})`);
  }
  // `activity: null` deliberately falls back to the human event formatter.
  // Keep that formatter's verified Droid duplicate suppression in the
  // structured stream too; opting out of structure must not change prose.
  const decode = createEventLineDecoder((def?.activity ?? def?.events) === "droid-stream-json");

  return (line) => {
    const decoded = decode(line);
    if (!decoded) return [];
    if (!decoded.event) {
      return decoded.jsonLike
        ? []
        : [{ kind: "text", id: context.id("text"), parentId: null, text: trunc(decoded.text, 4_000) }];
    }

    if (normalizer) return normalizer(decoded.event, context);
    if (!def?.events) return [];
    const rendered = formatParsedEvent(decoded.event, def);
    return rendered
      ? rendered.split("\n").map((value) => ({
          kind: "text" as const,
          id: context.id("text"),
          parentId: null,
          text: value,
        }))
      : [];
  };
}
