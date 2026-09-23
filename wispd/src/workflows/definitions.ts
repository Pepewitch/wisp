import {
  workflowPermissionIsImplicit,
  type WorkflowDefinition,
  type WorkflowParameter,
  type WorkflowParams,
} from "../../../shared/workflows";
import { isRecord } from "../validate";

const text = (key: string, label: string, value: string, description = "", multiline = false): WorkflowParameter =>
  ({ key, label, description, type: "string", default: value, multiline });
const number = (key: string, label: string, value: number, min: number, max: number, description = ""): WorkflowParameter =>
  ({ key, label, description, type: "number", default: value, min, max });
const boolean = (key: string, label: string, description: string): WorkflowParameter =>
  ({ key, label, description, type: "boolean", default: false });

export const COMMON_PARAMETERS: WorkflowParameter[] = [
  number("everyMinutes", "Check every (minutes)", 5, 1, 1440, "Polling is token-free. An actionable check can wake the agent; Heartbeat wakes on every eligible tick."),
  number("maxWakeups", "Maximum agent wake-ups", 20, 1, 200, "Pause when this budget is reached."),
  number("lifetimeHours", "Expires after (hours)", 24, 1, 168, "A safety limit, including time spent paused."),
  boolean("allowPush", "Ask agent to push changes", "Tell workflow turns to push after validating changes. This is guidance, not a process sandbox."),
  boolean("allowMerge", "Ask agent to merge the task's PR", "Only after rechecking current checks, reviews, and branch rules. This is guidance, not a process sandbox."),
];

export const BUILTIN_WORKFLOWS: WorkflowDefinition[] = [
  {
    id: "schedule-steer", version: "1", name: "Schedule Steer",
    description: "Send one steer message at a chosen time, then complete. If the task cannot accept a live steer, the message waits for its next turn.",
    parameters: [
      { ...text("prompt", "Steer message", "", "What should the agent know or do at the scheduled time?", true), required: true },
      { ...text("scheduledAt", "Scheduled time", "", "An exact time with a UTC offset, stored as an instant."), required: true },
    ],
  },
  {
    id: "heartbeat", version: "1", name: "Heartbeat",
    description: "Revisit an objective on a timer. Each eligible check wakes the agent and can spend tokens.",
    parameters: [
      { ...text("prompt", "Instructions", "", "What should the agent do, and when is the objective complete?", true), required: true },
      ...COMMON_PARAMETERS.map(p => workflowPermissionIsImplicit("heartbeat", p.key) ? { ...p, default: true } : p),
    ],
  },
];

/** Withdrawn built-ins, by id, with the name their completed rows still show. */
export const RETIRED_WORKFLOWS: Record<string, string> = { "pr-ci": "PR CI watch", "pr-review": "PR review watch" };

export function validateWorkflowParams(def: WorkflowDefinition, input: unknown): WorkflowParams {
  if (!isRecord(input)) throw new Error("params must be an object");
  const known = new Set(def.parameters.map(p => p.key));
  for (const key of Object.keys(input)) if (!known.has(key)) throw new Error(`Unknown workflow parameter: ${key}`);
  const output: WorkflowParams = {};
  for (const p of def.parameters) {
    const value = input[p.key] ?? p.default;
    if (input[p.key] === null || typeof value !== p.type) throw new Error(`${p.label} must be ${p.type}`);
    if (typeof value === "number" && (!Number.isSafeInteger(value) || value < (p.min ?? 0) || value > (p.max ?? 1_000_000))) {
      throw new Error(`${p.label} must be an integer from ${p.min ?? 0} to ${p.max ?? 1_000_000}`);
    }
    if (typeof value === "string" && (value.length > 16_000 || (p.required && !value.trim()))) throw new Error(`${p.label} is required and must be at most 16000 characters`);
    output[p.key] = value as string | number | boolean;
  }
  if (def.id === "schedule-steer") {
    const value = String(output.scheduledAt);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
      !Number.isFinite(Date.parse(value))) throw new Error("Scheduled time must include a valid date, time, and UTC offset");
    output.scheduledAt = new Date(value).toISOString();
  }
  return output;
}
