import type { AutopilotStatus } from "../../../shared/autopilot"
import type { PullRequestInfo } from "./types"

const LIFECYCLE = {
  draft: "Draft",
  open: "Open",
  merged: "Merged",
  closed: "Closed",
} as const

const CHECKS = {
  none: "No CI",
  pending: "CI pending",
  passed: "CI passed",
  failed: "CI failed",
  unknown: "CI unknown",
} as const

const REVIEW = {
  none: "No review",
  required: "Review required",
  approved: "Approved",
  "changes-requested": "Changes requested",
  unknown: "Review unknown",
} as const

const MERGE_STATE = {
  ready: "Merge ready",
  unstable: "Mergeable with non-passing checks",
  blocked: "Merge blocked",
  behind: "Branch behind base",
  conflicting: "Merge conflict",
  unknown: "Merge status unknown",
} as const

/**
 * The provider's facts about one PR, in Wisp's words: where it is in its life
 * ("Merged by Wisp" when Wisp merged it, "Queued to merge" while a merge queue
 * holds it), its checks, its review and whether it can merge. The link below
 * and the summary card's Pull request row both say them this way.
 */
export function pullRequestWords(pullRequest: PullRequestInfo, autoMerge?: AutopilotStatus | null) {
  // a finished row names its PR; one that stayed on for the next PR remembers the last merge
  const mergedByWisp = pullRequest.lifecycle === "merged" && Boolean(autoMerge) &&
    ((autoMerge!.mergedByWisp && autoMerge!.pr === pullRequest.number) ||
      (autoMerge!.lastMerged?.byWisp === true && autoMerge!.lastMerged.pr === pullRequest.number))
  const lifecycle = mergedByWisp
    ? "Merged by Wisp"
    : pullRequest.lifecycle === "open" && pullRequest.queuedToMerge
      ? "Queued to merge"
      : LIFECYCLE[pullRequest.lifecycle]
  return {
    lifecycle,
    checks: CHECKS[pullRequest.checks],
    review: REVIEW[pullRequest.review],
    mergeState: MERGE_STATE[pullRequest.mergeState],
  }
}
