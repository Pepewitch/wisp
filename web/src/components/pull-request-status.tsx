import type { AutopilotStatus } from "../../../shared/autopilot"
import { autoMergeWords, autopilotOn } from "@/lib/autopilot-words"
import { BranchRequest } from "@/components/icons"
import {
  PULL_REQUEST_ICON_TONE,
  pullRequestIconTone,
} from "@/lib/pull-request-tone"
import { pullRequestWords } from "@/lib/pull-request-words"
import type { PullRequestInfo } from "@/lib/types"
import { externalLinkProps } from "@/lib/external-links"
import { cn } from "@/lib/utils"

/**
 * Whether that reason may REPLACE the CI and review words. Only when it is
 * about this very PR's own state — its checks, reviews, merge state, or a
 * pause — because then it already accounts for both, and the line truncates,
 * so a reason tacked on at the end would be the first thing cut. A reason
 * about the task ("waiting for the task to finish", a Stop hold) or about
 * another PR must never hide what GitHub says about this one; it lives in
 * the hover instead.
 */
function replacesFacts(status: AutopilotStatus | null | undefined, pullRequest: PullRequestInfo): boolean {
  return autopilotOn(status) && status!.pr === pullRequest.number &&
    (status!.about === "pr" || status!.state === "paused") && !pullRequest.queuedToMerge
}

/**
 * One neutral, unboxed link for an associated PR. The provider owns every
 * status; Wisp only normalizes and relays it.
 */
export function PullRequestStatusLink({
  pullRequest,
  others = 0,
  autoMerge,
  className,
}: {
  pullRequest: PullRequestInfo
  /** How many MORE this task has — it is showing its newest. */
  others?: number
  /** the task's auto-merge status, whose reason stands in for CI and review while armed */
  autoMerge?: AutopilotStatus | null
  className?: string
}) {
  const { lifecycle, checks, review, mergeState } = pullRequestWords(pullRequest, autoMerge)
  // A task with several branches shows its NEWEST pull request, so the count
  // is the one thing the row would otherwise be hiding.
  const more = others > 0 ? `newest of ${others + 1} on this task` : null
  const automation = pullRequest.lifecycle === "open" ? autoMergeWords(autoMerge, pullRequest.number) : null
  // the hover title keeps every fact; the visible line trades CI and review
  // for the reason only when the reason is about this PR's own state
  const label = `PR #${pullRequest.number} · ${lifecycle} · ${checks} · ${review}${automation ? ` · ${automation}` : ""}`
  const detail = automation && replacesFacts(autoMerge, pullRequest) ? automation : `${checks} · ${review}`
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
        "h-8 max-w-[420px] gap-1.5 px-2 text-[11.5px]",
        className,
      )}
    >
      <BranchRequest
        data-testid="pull-request-icon"
        className={cn("size-3.5", PULL_REQUEST_ICON_TONE[iconTone])}
      />
      <span className="truncate">
        <span className="font-mono text-fg-secondary">PR #{pullRequest.number}</span>
        <span> · {lifecycle} · {detail}</span>
      </span>
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
