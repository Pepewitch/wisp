import { BranchRequest } from "@/components/icons"
import {
  PULL_REQUEST_ICON_TONE,
  pullRequestIconTone,
} from "@/lib/pull-request-tone"
import type { PullRequestInfo } from "@/lib/types"
import { externalLinkProps } from "@/lib/external-links"
import { cn } from "@/lib/utils"

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
 * One neutral, unboxed link for an associated PR. The provider owns every
 * status; Wisp only normalizes and relays it. `compact` keeps the same facts in
 * a thumb-sized two-line target for the mobile header.
 */
export function PullRequestStatusLink({
  pullRequest,
  others = 0,
  compact = false,
}: {
  pullRequest: PullRequestInfo
  /** How many MORE this task has — it is showing its newest. */
  others?: number
  compact?: boolean
}) {
  const lifecycle = LIFECYCLE[pullRequest.lifecycle]
  const checks = CHECKS[pullRequest.checks]
  const review = REVIEW[pullRequest.review]
  // A task with several branches shows its NEWEST pull request, so the count
  // is the one thing the row would otherwise be hiding.
  const more = others > 0 ? `newest of ${others + 1} on this task` : null
  const label = `PR #${pullRequest.number} · ${lifecycle} · ${checks} · ${review}`
  const mergeState = MERGE_STATE[pullRequest.mergeState]
  const iconTone = pullRequestIconTone(pullRequest)
  // No href when the daemon reported something that is not a web address: the
  // card still states the PR's condition, it just is not a link.
  const link = externalLinkProps(pullRequest.url)

  return (
    <a
      data-testid="pull-request-status"
      {...link}
      aria-label={`${label}${more ? ` · ${more}` : ""} · ${mergeState}: ${pullRequest.title}`}
      title={`${label}${more ? ` · ${more}` : ""} · ${mergeState} — ${pullRequest.title}`}
      className={cn(
        "flex shrink-0 items-center rounded-md text-muted-foreground hover:bg-hover hover:text-foreground",
        "focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
        // compact owns a full row in the mobile header, so it is bounded by that
        // row rather than by a share of the viewport it split with the title
        compact ? "h-11 max-w-full gap-1.5 px-2" : "h-8 max-w-[420px] gap-1.5 px-2 text-[11.5px]",
      )}
    >
      <BranchRequest
        data-testid="pull-request-icon"
        className={cn(
          compact ? "size-4" : "size-3.5",
          PULL_REQUEST_ICON_TONE[iconTone],
        )}
      />
      {compact ? (
        <span className="min-w-0">
          <span className="block truncate font-mono text-[11px] text-fg-secondary">
            PR #{pullRequest.number} · {lifecycle}
          </span>
          <span className="block truncate text-[10.5px]">
            {checks} · {review}
          </span>
        </span>
      ) : (
        <span className="truncate">
          <span className="font-mono text-fg-secondary">PR #{pullRequest.number}</span>
          <span> · {lifecycle} · {checks} · {review}</span>
        </span>
      )}
      {/* one short fact, and only when there IS one: this row is the newest of
          several, and nothing else on screen would say so */}
      {more && (
        <span data-testid="pull-request-others" className="shrink-0 font-mono text-[10.5px] text-faint">
          +{others}
        </span>
      )}
    </a>
  )
}
