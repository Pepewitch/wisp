/**
 * Auto-merge (and, later, auto-fix) for a task's pull request: the API shape
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

export interface AutopilotStatus {
  autoMerge: boolean
  autoFix: boolean
  /** the pull request it is bound to; null until the task has an open one */
  pr: number | null
  state: AutopilotState
  reason: string
  /** when `reason` last changed, ISO-8601; null when never armed */
  updatedAt: string | null
}

export interface AutopilotUpdate {
  autoMerge?: boolean
  autoFix?: boolean
}
