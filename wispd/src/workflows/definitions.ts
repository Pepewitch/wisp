import type { WorkflowDefinition, WorkflowParameter, WorkflowParams } from "../../../shared/workflows";
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
  boolean("allowPush", "Allow pushing changes", "Authorize the agent to push task changes. Workflows are not an OS sandbox."),
  boolean("allowMerge", "Allow merging the watched PR", "Only after rechecking current checks, reviews, and branch rules. Off by default."),
];
const pr = { ...text("prUrl", "Pull request URL", "", "A specific github.com pull request. This workflow never follows a different PR."), required: true };

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
      ...COMMON_PARAMETERS,
    ],
  },
  {
    id: "pr-ci", version: "1", name: "PR CI watch",
    description: "Wait for CI without agent tokens. Wake only for new failures or passing checks.",
    parameters: [
      pr,
      text("onRed", "When checks fail", "Investigate the failing checks. Fix relevant issues and run appropriate tests. Push the fixes only if authorized.", "", true),
      text("onGreen", "When checks pass", "Report that CI passed and identify remaining merge blockers. If merging is authorized, recheck current eligibility and merge through the normal protected path.", "", true),
      ...COMMON_PARAMETERS,
    ],
  },
  {
    id: "pr-review", version: "1", name: "PR review watch",
    description: "React to new reviews, comments, and nits. Stop after a quiet period, not a guessed approval.",
    parameters: [
      pr,
      text("prompt", "When new feedback arrives", "Read the new feedback in context. Fix valid issues and nits, run relevant tests, and push if authorized. Explain feedback you cannot address or disagree with. Do not change correct code merely to satisfy a mistaken comment.", "", true),
      number("quietMinutes", "Stop after quiet (minutes)", 30, 5, 1440, "Resets after new feedback, a changed PR head, or a completed workflow turn. Never completes while task work is pending."),
      text("reviewers", "Only these reviewers", "", "Optional comma-separated GitHub logins. Listed review bots are included."),
      text("excludeAuthors", "Ignore these authors", "", "Comma-separated logins. The authenticated GitHub user is always excluded."),
      boolean("includeBots", "Include other bots", "By default only humans and explicitly listed reviewers trigger a wake-up."),
      ...COMMON_PARAMETERS.map(p => p.key === "everyMinutes" ? { ...p, default: 2 } : p),
    ],
  },
];

export function parsePrUrl(value: unknown): { owner: string; repo: string; number: number; url: string } {
  if (typeof value !== "string") throw new Error("prUrl must be a GitHub pull request URL");
  const url = new URL(value);
  const match = url.pathname.match(/^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/([1-9][0-9]*)\/?$/);
  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.port || url.username || url.password || !match ||
      !Number.isSafeInteger(Number(match[3]))) throw new Error("Use https://github.com/owner/repo/pull/number");
  return { owner: match[1]!, repo: match[2]!, number: Number(match[3]), url: `https://github.com/${match[1]}/${match[2]}/pull/${match[3]}` };
}

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
  if (def.id === "pr-ci" || def.id === "pr-review") output.prUrl = parsePrUrl(output.prUrl).url;
  return output;
}
