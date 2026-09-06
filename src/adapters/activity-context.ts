import { string } from "./activity-value";
import type { ActivityStatus } from "./types";

/** Per-turn correlation state shared by every activity normalizer. */
export interface NormalizeContext {
  id(kind: string): string;
  subagents: Set<string>;
  /** Call id → whether Task returned before the background child settled. */
  background: Map<string, boolean>;
  /** Monitoring call id → child id, used by Droid TaskOutput/TaskStop. */
  toolParents: Map<string, string>;
}

export function eventId(value: unknown, context: NormalizeContext, kind: string): string {
  return string(value) ?? context.id(kind);
}

export function status(value: unknown, fallback: ActivityStatus = "unknown"): ActivityStatus {
  const raw = string(value)?.toLowerCase();
  if (!raw) return fallback;
  // Codex's app-server speaks camelCase (`inProgress`, `pendingInit`) where
  // `codex exec --json` speaks snake_case; both dialects reach this stream.
  if (["running", "in_progress", "inprogress", "pending", "pending_init", "pendinginit", "started", "interacted", "working"].includes(raw)) return "running";
  if (["completed", "complete", "done", "success", "succeeded", "finished"].includes(raw)) return "completed";
  if (["failed", "failure", "error", "errored", "refused", "not_found", "notfound"].includes(raw)) return "failed";
  if (["stopped", "cancelled", "canceled", "interrupted", "killed", "closed", "shutdown"].includes(raw)) return "stopped";
  return fallback;
}
