/**
 * Auto-merge and auto-fix for a task's pull request: the API shape
 * every client reads. The daemon owns the decision; clients only show it and
 * flip the toggles.
 */
export type AutopilotState =
  /** armed and checking; `reason` says what it is waiting for */
  | "waiting"
  /** `gh pr merge` is running right now */
  | "merging"
  /** the provider accepted the PR into its merge queue */
  | "queued"
  /** Stop was pressed; nothing acts until the owner's next turn finishes */
  | "held"
  /** armed, but blocked on something only a person can do */
  | "needs-you"
  /** stopped acting until Resume (repeated merge failure, provider auto-merge found on) */
  | "paused"
  /** the PR this was bound to merged; nothing left to watch */
  | "merged"
  /** not armed */
  | "off"

/** Which switch a reason speaks for: the merge gate, or auto-fix's own look at CI. */
export type AutopilotBy = "auto-merge" | "auto-fix"

export interface AutopilotStatus {
  autoMerge: boolean
  autoFix: boolean
  /** the pull request it is bound to; null until the task has an open one */
  pr: number | null
  state: AutopilotState
  reason: string
  /**
   * What `reason` describes: the bound PR's own state (its checks, reviews,
   * merge state), which a client may show IN PLACE of those facts; or the
   * task and Wisp itself (busy, held by Stop, no PR yet, GitHub unreachable),
   * which must never stand in for them.
   */
  about: "pr" | "task"
  by: AutopilotBy
  /** the bound PR merged, and it was Wisp that merged it */
  mergedByWisp: boolean
  /**
   * The last PR that merged while the switches stayed on: they persist for the
   * task's next PR, so this is how a client still says "Merged by Wisp".
   */
  lastMerged: { pr: number; byWisp: boolean } | null
  /** an auto-fix round waiting out its short delay: Send now or Skip act on it */
  pendingFix: { summary: string; sendsAt: string } | null
  /** auto-fix rounds sent to the agent for the bound PR */
  fixRounds: number
  /** when `reason` last changed, ISO-8601; null when never armed */
  updatedAt: string | null
}

export interface AutopilotUpdate {
  autoMerge?: boolean
  autoFix?: boolean
}
