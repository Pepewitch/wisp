/**
 * A reviewer's fallback. When a reviewer's task fails for an infrastructure
 * reason, its role's fallback agent (repos[].verifyFallback for reviewer A,
 * verifySecondFallback for B) reviews the same round and head in its place,
 * once. Those reasons are what Wisp already wrote on the failed task:
 *
 * - network: the turn ended on the network (adapters/network.ts);
 * - provider: the provider could not serve the turn — an adapter's own
 *   `transientMarkers`, or a 5xx, an overload or "service unavailable" in
 *   any harness's words (adapters/provider-outage.ts);
 * - setup: the reviewer never got its prompt — its worktree, setup script or
 *   setup's time limit failed before any turn existed, the harness could not
 *   be spawned (runner.ts), or its live session failed to start, an
 *   initialize that timed out included (turn-process.ts failLiveTurn).
 *
 * Nothing else falls back: a verdict, a missing or malformed one, a question
 * asked twice and the time limit are the reviewer's own doing, and a usage
 * limit is the account's. Those keep ending the review as they always did.
 */
import type { AutoReviewFallbackCause, AutoReviewRole } from "../../../shared/api/auto-review"
import type { AdapterDef } from "../adapters"
import { isNetworkDetail, NETWORK_PREFIX } from "../adapters/network"
import { LIMIT_PREFIX, TRANSIENT_PREFIX } from "../adapters/errors"
import { isProviderOutage } from "../adapters/provider-outage"
import { repoConfigFor, type WispConfig } from "../config"
import { db } from "../store-database"
import type { Task } from "../types"

export interface InfrastructureFailure {
  cause: AutoReviewFallbackCause
  /** the failed task's own words, without Wisp's prefix */
  detail: string
}

const DETAIL_MAX = 300

/**
 * What Wisp writes on a turn that failed before its prompt reached the
 * harness: a spawn that threw (runner.ts startTurn), and a live session whose
 * setup failed or timed out, which turn-finalize.ts records as a kill.
 */
const NEVER_STARTED = /^(?:spawn failed: |turn killed: live input setup failed: )/
/** Wisp's own reasons for ending a turn (a log cap, a stop): never the provider's, whatever the words. */
const KILLED = "turn killed: "

/** Why a failed reviewer task failed, when the reason is the machine's rather than the reviewer's; else null. */
export function infrastructureFailure(task: Task): InfrastructureFailure | null {
  if (task.state !== "failed") return null
  const detail = task.state_detail ?? ""
  const words = (prefix: string) => detail.slice(prefix.length).trim().slice(0, DETAIL_MAX)
  if (isNetworkDetail(detail)) return { cause: "network", detail: words(NETWORK_PREFIX) }
  if (detail.startsWith(TRANSIENT_PREFIX)) return { cause: "provider", detail: words(TRANSIENT_PREFIX) }
  if (detail.startsWith(LIMIT_PREFIX)) return null
  if (NEVER_STARTED.test(detail)) return { cause: "setup", detail: words("") }
  const turned = db.query("SELECT 1 FROM turns WHERE task_id = ? LIMIT 1").get(task.id) !== null
  if (!turned) return { cause: "setup", detail: words("") }
  return !detail.startsWith(KILLED) && isProviderOutage(detail) ? { cause: "provider", detail: words("") } : null
}

/** The fallback a project names for a reviewer role, when its harness is still known; else null. */
export function fallbackAgent(cfg: WispConfig, adapters: Record<string, AdapterDef>, repoPath: string, role: AutoReviewRole):
  { harness: string; model: string | null; effort: string | null } | null {
  const config = repoConfigFor(cfg, repoPath)
  const chosen = role === "primary" ? config?.verifyFallback : config?.verifySecondFallback
  if (!chosen || !adapters[chosen.harness]) return null
  return { harness: chosen.harness, model: chosen.model ?? null, effort: chosen.effort ?? null }
}
