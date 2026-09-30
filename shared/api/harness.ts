/**
 * What the daemon reads out of band from a harness, as the API serves it:
 * plan limits (GET /api/harness-limits), a task's probes
 * (POST /api/tasks/:id/probe) and its skills (GET /api/tasks/:id/skills).
 * Every number is copied from the harness, never computed or invented.
 */

export type LimitsStatus = "ok" | "needs-key" | "account-mismatch" | "unavailable" | "error";

/** One usage window, as the harness reports it. */
export interface LimitWindow {
  /** stable within the harness, so a client can key rows */
  id: string;
  /** what the harness calls the window: `5h`, `7d`, `weekly`, a model name */
  label: string;
  /** a separate allowance inside one account (droid's standard/core, a codex per-model limit) */
  pool: string | null;
  /** the one model this window limits (claude's per-model week); null for a window every model draws from */
  model: string | null;
  usedPercent: number;
  /** null when the window has not started (droid's idle 5h) or the harness named no reset */
  resetsAt: string | null;
  /** the window's length when the harness states or implies it; null when it varies (a month) */
  windowMins: number | null;
}

export interface HarnessLimits {
  /** the plan name, when the harness reports one */
  plan: string | null;
  windows: LimitWindow[];
  /**
   * droid only: whether the API key's account was checked against the one
   * droid's own login uses. `unchecked` means droid's cache file could not be
   * read, so the numbers are the key's account and nothing more is known.
   */
  account?: "verified" | "unchecked";
}

/** One harness's answer, as the route serves it. */
export interface HarnessLimitsEntry {
  name: string;
  status: LimitsStatus;
  limits: HarnessLimits | null;
  /** why there are no limits to show; null when status is ok */
  message: string | null;
  fetchedAt: string;
  cached: boolean;
}

/** GET /api/harness-limits */
export interface HarnessLimitsResponse {
  harnesses: HarnessLimitsEntry[];
}

/** The out-of-turn reads a harness can answer without driving a model turn. */
export type ProbeCommand = "context" | "usage";

/**
 * droid's `droid.get_context_breakdown`, normalized. A category the harness
 * sent without a number reads 0; the TUI's own vocabulary is kept.
 */
export interface ContextBreakdown {
  /** the model the breakdown belongs to, as the harness names it */
  model: string | null;
  budgetTokens: number | null;
  usedTokens: number | null;
  freeTokens: number | null;
  categories: { name: string; tokens: number }[];
  skills: { name: string; tokens: number }[];
  mcpServers: { name: string; toolCount: number | null; tokens: number }[];
}

/** A rate-limit window codex reports; absent (null) when it reported no used percentage. */
export interface UsageWindow {
  usedPercent: number;
  windowMins: number | null;
  resetsAt: string | null;
}

/**
 * codex's `account/rateLimits/read` + `account/usage/read`, normalized. These
 * are ACCOUNT-level numbers, so a surface must say "account", not imply the task.
 */
export interface HarnessUsageReport {
  planType: string | null;
  /** the short rate-limit window (codex: 5h) */
  primary: UsageWindow | null;
  /** the long rate-limit window (codex: weekly) */
  secondary: UsageWindow | null;
  credits: { hasCredits: boolean; unlimited: boolean; balance: number | null } | null;
  lifetimeTokens: number | null;
}

/**
 * What a probe returns: claude writes its own report as markdown, rendered
 * as-is; droid and codex return structured JSON and Wisp owns the table.
 */
export type ProbeReport =
  | { format: "markdown"; text: string }
  | { format: "context"; context: ContextBreakdown }
  | { format: "usage"; usage: HarnessUsageReport };

/** POST /api/tasks/:id/probe: what ran, when, and whether the cache served it. */
export interface ProbeAnswer {
  command: ProbeCommand;
  probedAt: string;
  /** true = the cache answered and no harness process was spawned */
  cached: boolean;
  report: ProbeReport;
}

/** One skill as the palette renders it. `description` is null on a name-only skill, which is never dropped for it. */
export interface SkillEntry {
  name: string;
  description: string | null;
}

/**
 * One custom slash command from the harness's own registry. The palette only
 * prefills it, so selecting one never runs code without a second send.
 */
export interface SlashCommandEntry {
  name: string;
  description: string | null;
  argumentHint: string | null;
  executable: boolean;
}

/**
 * What skill discovery found. `errors` are malformed-skill reports the harness
 * handed back, surfaced verbatim; `partialNote` marks a knowingly incomplete
 * list (claude before its first turn lists user/project skills only).
 */
export interface SkillDiscoveryResult {
  skills: SkillEntry[];
  /** Custom slash commands discovered alongside the skill registry, when exposed. */
  commands: SlashCommandEntry[];
  /** Command-registry failure that must not erase an otherwise valid skill list. */
  commandError: string | null;
  errors: string[];
  partialNote: string | null;
  /**
   * How a palette pick becomes prompt text: "slash" prefills `/name`,
   * "prompt" writes a plain-text ask (codex has no headless slash surface,
   * and a pick must not pretend otherwise).
   */
  invoke: "slash" | "prompt";
}

/** GET /api/tasks/:id/skills. `invoke` is null for a harness that declares no skill discovery. */
export interface TaskSkills extends Omit<SkillDiscoveryResult, "invoke"> {
  invoke: SkillDiscoveryResult["invoke"] | null;
  probedAt: string;
  cached: boolean;
}
