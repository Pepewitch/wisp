/**
 * Auto-merge, auto-fix and auto-review for a task's pull request: the API shape
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
  /**
   * a finished row from before the switches stayed on across merges; a merge
   * now keeps the row on and is recorded in `lastMerged` instead
   */
  | "merged"
  /** not armed */
  | "off"

/** Which switch a reason speaks for: the merge gate, auto-fix's own look at CI, or the independent reviewer. */
export type AutopilotBy = "auto-merge" | "auto-fix" | "auto-review"

export interface AutopilotStatus {
  autoMerge: boolean
  autoFix: boolean
  /**
   * An independent reviewer task verifies each PR head before it merges.
   * Absent from a daemon older than auto-review.
   */
  autoReview?: boolean
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
  /** counted auto-review rounds for the bound PR (absent from an older daemon) */
  reviewRounds?: number
  /**
   * Nothing left for it to do right now: with auto-merge on, the current PR
   * has merged; with auto-fix alone, CI is green and no review has come in
   * for a while. It is still on, for the task's next PR or next review.
   */
  done: boolean
  /**
   * The task's latest turn ended on the network (its detail starts
   * `network: `) and Wisp resumes it on its own: resume `resume` of `of` is
   * due at `resumesAt`, ISO-8601. A client shows the task as paused, not
   * failed. Null otherwise, and once the resumes are spent: the task is then
   * failed and waits for a person. Absent from an older daemon.
   */
  network?: { resumesAt: string; resume: number; of: number } | null
  /** when `reason` last changed, ISO-8601; null when never armed */
  updatedAt: string | null
}

/**
 * One thing auto-merge or auto-fix did or saw for a task, from
 * `GET /api/tasks/:id/autopilot/history` (newest first, across every time the
 * switches were on): the newest 100 entries and the merge records, at most 500.
 */
export interface AutopilotHistoryEntry {
  at: string
  /**
   * armed, configured, bound, wait, blocked, rerun, judged, judge-unavailable,
   * wake (a round sent), network-resume (a message that continues a task
   * after the network dropped), skipped, held, resumed, merging, merged,
   * merge-failed, review (an auto-review round started or ended),
   * review-hold (the verification recipe needs fixing), and the row's own
   * active, paused and completed
   */
  kind: string
  detail: string
  /** the pull request it is about, when there was one */
  pr: number | null
  /** the commit: the head merged, or the head a merge, rerun or round was about */
  sha: string | null
  /** the task message an auto-fix round queued */
  messageId: string | null
}

export interface AutopilotUpdate {
  autoMerge?: boolean
  autoFix?: boolean
  autoReview?: boolean
}
