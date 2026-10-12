import { useMemo } from "react"

import type { AutoReviewRound } from "../../../shared/api/auto-review"
import { Sep, Time } from "@/components/autopilot-history-view"
import { Rule } from "@/components/primitives"
import { ROUND_DOT, roundName, roundsForPr, roundVerdict } from "@/lib/auto-review-words"
import { shortSha } from "@/lib/autopilot-history"
import { cn } from "@/lib/utils"

/** The Reviews block's data: undefined rounds while the first read is in flight. */
export interface ReviewsModel {
  rounds: AutoReviewRound[] | undefined
  error: string | null
  /** select a reviewer task; absent where nothing can navigate (the gallery) */
  onOpenTask?: (taskId: string) => void
}

/**
 * The Autopilot tab's Reviews: auto-review's rounds for the current PR,
 * newest first, one line each — the dot carries the verdict's tone, the words
 * stay gray, and `Open` selects the reviewer task that gave it. Drawn under
 * the switches only while auto-review is on and the PR has a round.
 */
export function Reviews({ reviews, pr, touch, now }: { reviews: ReviewsModel; pr: number | null; touch: boolean; now: number }) {
  const rounds = useMemo(() => roundsForPr(reviews.rounds ?? [], pr), [reviews.rounds, pr])
  if (reviews.rounds === undefined && !reviews.error) return null
  if (reviews.rounds !== undefined && rounds.length === 0) return null
  return (
    <div className="pb-1">
      <div className="flex items-center gap-3 px-3.5 pt-3 pb-1">
        <h3 className="shrink-0 text-[11.5px] font-medium text-fg-secondary">Reviews</h3>
        <Rule />
      </div>
      {reviews.rounds === undefined ? (
        <p role="alert" className="px-3.5 pt-1 text-[11.5px] text-faint">{reviews.error}</p>
      ) : (
        <ul className="px-3.5">
          {rounds.map((round) => (
            <RoundRow key={round.id} round={round} touch={touch} now={now} onOpenTask={reviews.onOpenTask} />
          ))}
        </ul>
      )}
    </div>
  )
}

function RoundRow({ round, touch, now, onOpenTask }: { round: AutoReviewRound; touch: boolean; now: number; onOpenTask?: (taskId: string) => void }) {
  const verdict = roundVerdict(round)
  const reviewer = round.reviewerTaskId
  const faint = round.state === "superseded"
  return (
    <li
      data-round={round.state}
      className={cn("ml-[3px] flex min-w-0 items-center gap-2.5", touch ? "min-h-11" : "min-h-7")}
    >
      <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", ROUND_DOT[round.state])} />
      <span
        title={verdict}
        className={cn("min-w-0 flex-1 truncate text-[11.5px]", faint ? "text-faint" : "text-muted-foreground")}
      >
        <span className={cn(!faint && "text-foreground")}>{roundName(round)}</span>
        <Sep />
        <span title={round.head} className="font-mono text-[10.5px] text-fg-secondary">{shortSha(round.head)}</span>
        <Sep />
        {verdict}
      </span>
      <Time at={round.finishedAt ?? round.createdAt} now={now} short className="text-[11px] text-faint" />
      {reviewer && onOpenTask && (
        <button
          type="button"
          onClick={() => onOpenTask(reviewer)}
          aria-label={`Open the reviewer task for ${roundName(round).toLowerCase()}`}
          title="Open the reviewer task"
          className={cn(
            "-mr-1.5 inline-flex shrink-0 items-center rounded-md px-1.5 text-[11.5px] text-muted-foreground transition-colors hover:bg-hover hover:text-foreground",
            "focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
            touch ? "min-h-11" : "h-6",
          )}
        >
          Open
        </button>
      )}
    </li>
  )
}
