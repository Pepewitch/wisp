import { useMemo, type ReactNode } from "react"

import type { AutoReviewReview, AutoReviewRound } from "../../../shared/api/auto-review"
import { Sep, Time } from "@/components/autopilot-history-view"
import { Rule } from "@/components/primitives"
import {
  REVIEW_DOT,
  REVIEWER_LETTER,
  REVIEWER_ROLE_WORDS,
  ROUND_DOT,
  TIER_WORD,
  reviewAgentWords,
  reviewTitle,
  reviewVerdict,
  roundName,
  roundsForPr,
  roundVerdict,
  tierTitle,
} from "@/lib/auto-review-words"
import { shortSha } from "@/lib/autopilot-history"
import { cn } from "@/lib/utils"

/** The Reviews block's data: undefined rounds while the first read is in flight. */
export interface ReviewsModel {
  rounds: AutoReviewRound[] | undefined
  error: string | null
  /** select a reviewer task; absent where nothing can navigate (the gallery) */
  onOpenTask?: (taskId: string) => void
  /**
   * The daemon advertises `features.reviewPanel`: a round says its tier and
   * lists one row per reviewer. Without it every round is drawn as phase 1.
   */
  panel?: boolean
}

type OpenTask = ((taskId: string) => void) | undefined

/**
 * The Autopilot tab's Reviews: auto-review's rounds for the current PR,
 * newest first, one line each — the dot carries the verdict's tone, the words
 * stay gray, and `Open` selects the reviewer task that gave it. Drawn under
 * the switches only while auto-review is on and the PR has a round.
 *
 * On a daemon with the review panel, a round also says its tier (its title
 * is what Wisp measured), and under it each reviewer has its own row: the
 * letter, the agent, a dot and its words, and Open for its task. A round from
 * before the panel keeps its single line, with a faint hint saying so.
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
          {rounds.map((round) =>
            reviews.panel ? (
              <PanelRound key={round.id} round={round} touch={touch} now={now} onOpenTask={reviews.onOpenTask} />
            ) : (
              <li key={round.id} data-round={round.state} className={roundRowClass(touch)}>
                <RoundLine round={round} now={now} touch={touch} onOpenTask={reviews.onOpenTask} />
              </li>
            ),
          )}
        </ul>
      )}
    </div>
  )
}

const roundRowClass = (touch: boolean) => cn("ml-[3px] flex min-w-0 items-center gap-2.5", touch ? "min-h-11" : "min-h-7")

/** A round on a daemon with the panel: its line with the tier, then a row per reviewer. */
function PanelRound({ round, touch, now, onOpenTask }: { round: AutoReviewRound; touch: boolean; now: number; onOpenTask: OpenTask }) {
  const reviews = round.legacy ? [] : sortedReviews(round.reviews ?? [])
  const faint = round.state === "superseded"
  const after = round.legacy ? (
    <span title="One reviewer, no rubric and no tier: this round ran before the review panel" className="shrink-0 text-[11px] text-faint">
      before the panel
    </span>
  ) : round.tier ? (
    <span title={tierTitle(round)} className={cn("shrink-0 text-[11px]", faint ? "text-faint" : "text-muted-foreground")}>
      {TIER_WORD[round.tier]}
    </span>
  ) : null
  return (
    <li data-round={round.state} data-tier={round.tier ?? undefined} data-legacy={round.legacy ? "" : undefined}>
      <div className={roundRowClass(touch)}>
        {/* each reviewer has its own Open below; a round without rows keeps the round's */}
        <RoundLine round={round} now={now} touch={touch} onOpenTask={reviews.length > 0 ? undefined : onOpenTask} after={after} />
      </div>
      {reviews.length > 0 && (
        <ul aria-label={`Reviewers for ${roundName(round).toLowerCase()}`} className="pb-1 pl-[19px]">
          {reviews.map((review) => (
            <ReviewRow key={review.id} round={round} review={review} touch={touch} faint={faint} onOpenTask={onOpenTask} />
          ))}
        </ul>
      )}
    </li>
  )
}

/** A first, then B: the order the letters promise. */
function sortedReviews(reviews: AutoReviewReview[]): AutoReviewReview[] {
  return [...reviews].sort((a, b) => Number(a.role === "second") - Number(b.role === "second"))
}

function RoundLine({
  round,
  now,
  touch,
  onOpenTask,
  after = null,
}: {
  round: AutoReviewRound
  now: number
  touch: boolean
  onOpenTask: OpenTask
  /** the tier, or the hint a round predates the panel, before the time */
  after?: ReactNode
}) {
  const verdict = roundVerdict(round)
  const reviewer = round.reviewerTaskId
  const faint = round.state === "superseded"
  return (
    <>
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
      {after}
      <Time at={round.finishedAt ?? round.createdAt} now={now} short className="text-[11px] text-faint" />
      {reviewer && onOpenTask && (
        <OpenButton
          touch={touch}
          label={`Open the reviewer task for ${roundName(round).toLowerCase()}`}
          title="Open the reviewer task"
          onClick={() => onOpenTask(reviewer)}
        />
      )}
    </>
  )
}

/**
 * One reviewer's part: `A  claude · opus-5  ● Passed — every save sends one PUT   Open`.
 * The letter's title says what that reviewer does; the words' title holds
 * what the row truncates and the findings, blocking first.
 */
function ReviewRow({
  round,
  review,
  touch,
  faint,
  onOpenTask,
}: {
  round: AutoReviewRound
  review: AutoReviewReview
  touch: boolean
  /** the round was superseded: everything under it is moot */
  faint: boolean
  onOpenTask: OpenTask
}) {
  const letter = REVIEWER_LETTER[review.role]
  const quiet = faint || review.state === "superseded"
  const task = review.reviewerTaskId
  return (
    <li
      data-review={review.carried ? "carried" : review.state}
      data-reviewer={letter}
      className={cn("flex min-w-0 items-center gap-2", touch ? "min-h-11" : "min-h-6")}
    >
      <span title={REVIEWER_ROLE_WORDS[review.role]} className="w-2.5 shrink-0 text-[11px] font-medium text-fg-secondary">
        {letter}
      </span>
      <span title={reviewAgentWords(review.agent)} className="max-w-[40%] shrink-0 truncate text-[11px] text-muted-foreground">
        {review.agent.harness}
        {review.agent.model && <span className="font-mono text-[10.5px]"> · {review.agent.model}</span>}
      </span>
      <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", REVIEW_DOT[review.state])} />
      <span title={reviewTitle(review)} className={cn("min-w-0 flex-1 truncate text-[11.5px]", quiet ? "text-faint" : "text-muted-foreground")}>
        {reviewVerdict(review)}
      </span>
      {task && onOpenTask && (
        <OpenButton
          touch={touch}
          label={`Open reviewer ${letter} for ${roundName(round).toLowerCase()}`}
          title={`Open reviewer ${letter}'s task`}
          onClick={() => onOpenTask(task)}
        />
      )}
    </li>
  )
}

function OpenButton({ touch, label, title, onClick }: { touch: boolean; label: string; title: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={title}
      className={cn(
        "-mr-1.5 inline-flex shrink-0 items-center rounded-md px-1.5 text-[11.5px] text-muted-foreground transition-colors hover:bg-hover hover:text-foreground",
        "focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
        touch ? "min-h-11" : "h-6",
      )}
    >
      Open
    </button>
  )
}
