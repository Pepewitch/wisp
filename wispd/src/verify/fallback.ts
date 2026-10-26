/**
 * A reviewer's fallback. When a reviewer's task fails for an infrastructure
 * reason, its role's fallback agent (repos[].verifyFallback for reviewer A,
 * verifySecondFallback for B) reviews the same round and head in its place,
 * once. Those reasons are what Wisp already wrote on the failed task:
 *
 * - network: the turn ended on the network (adapters/network.ts);
 * - provider: the turn ended on a transient provider fault, an adapter's
 *   `transientMarkers` (overloaded, service unavailable);
 * - setup: the task failed before any turn existed (its worktree, its setup
 *   script, or setup's time limit).
 *
 * Nothing else falls back: a verdict, a missing or malformed one, a question
 * asked twice and the time limit are the reviewer's own doing, and a usage
 * limit is the account's. Those keep ending the review as they always did.
 */
import type { AutoReviewFallbackCause, AutoReviewRole } from "../../../shared/api/auto-review"
import type { AdapterDef } from "../adapters"
import { isNetworkDetail, NETWORK_PREFIX } from "../adapters/network"
import { TRANSIENT_PREFIX } from "../adapters/errors"
import { repoConfigFor, type WispConfig } from "../config"
import { db } from "../store-database"
import type { Task } from "../types"

export interface InfrastructureFailure {
  cause: AutoReviewFallbackCause
  /** the failed task's own words, without Wisp's prefix */
  detail: string
}

const DETAIL_MAX = 300

/** Why a failed reviewer task failed, when the reason is the machine's rather than the reviewer's; else null. */
export function infrastructureFailure(task: Task): InfrastructureFailure | null {
  if (task.state !== "failed") return null
  const detail = task.state_detail ?? ""
  const words = (prefix: string) => detail.slice(prefix.length).trim().slice(0, DETAIL_MAX)
  if (isNetworkDetail(detail)) return { cause: "network", detail: words(NETWORK_PREFIX) }
  if (detail.startsWith(TRANSIENT_PREFIX)) return { cause: "provider", detail: words(TRANSIENT_PREFIX) }
  const turned = db.query("SELECT 1 FROM turns WHERE task_id = ? LIMIT 1").get(task.id) !== null
  return turned ? null : { cause: "setup", detail: words("") }
}

/** The fallback a project names for a reviewer role, when its harness is still known; else null. */
export function fallbackAgent(cfg: WispConfig, adapters: Record<string, AdapterDef>, repoPath: string, role: AutoReviewRole):
  { harness: string; model: string | null; effort: string | null } | null {
  const config = repoConfigFor(cfg, repoPath)
  const chosen = role === "primary" ? config?.verifyFallback : config?.verifySecondFallback
  if (!chosen || !adapters[chosen.harness]) return null
  return { harness: chosen.harness, model: chosen.model ?? null, effort: chosen.effort ?? null }
}
