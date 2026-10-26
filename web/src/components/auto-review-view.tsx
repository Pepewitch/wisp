import { useMemo, useState, type ReactNode } from "react"

import type { AutoReviewEvidence, AutoReviewReview, AutoReviewRound } from "../../../shared/api/auto-review"
import { outputImageUrl } from "../../../shared/api/outputs"
import { AttachmentViewer } from "@/components/attachment-viewer"
import { Sep, Time } from "@/components/autopilot-history-view"
import { Rule } from "@/components/primitives"
import { useAssetStatus } from "@/lib/asset-src"
import {
  CAPTURED_WORD,
  EVIDENCE_SHOWN,
  PUBLISHED_WORD,
  REQUIRED_TITLE,
  REVIEW_DOT,
  REVIEWER_LETTER,
  REVIEWER_ROLE_WORDS,
  ROUND_DOT,
  SCRIPT_WORDS,
  SERVED_ELSEWHERE_WORDS,
  SERVED_UNKNOWN_WORDS,
  TIER_WORD,
  WAIVED_WORD,
  captureDetail,
  evidenceTitle,
  requiredWords,
  reviewAgentWords,
  reviewFallbackWords,
  reviewSettled,
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
  /**
   * The daemon advertises `features.capture`: a settled reviewer shows its
   * images and what Wisp recorded about each, A lists the captures it waived,
   * and a round names the areas that need one. Without it none of that is drawn.
   */
  capture?: boolean
  /** the gallery's stand-in for an image's bytes; absent, each loads through the output route */
  evidenceSrc?: (evidence: AutoReviewEvidence) => string
}

type OpenTask = ((taskId: string) => void) | undefined

/** What a reviewer row needs to draw its evidence: null without `features.capture`. */
type EvidenceOptions = { src?: ReviewsModel["evidenceSrc"] } | null

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
 *
 * With captures, a settled reviewer's row is followed by its evidence — small
 * thumbnails, each saying who made it — and A's waived captures, as a notice;
 * a round whose areas need a capture says which.
 */
export function Reviews({ reviews, pr, touch, now }: { reviews: ReviewsModel; pr: number | null; touch: boolean; now: number }) {
  const rounds = useMemo(() => roundsForPr(reviews.rounds ?? [], pr), [reviews.rounds, pr])
  const evidence: EvidenceOptions = reviews.capture ? { src: reviews.evidenceSrc } : null
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
              <PanelRound key={round.id} round={round} touch={touch} now={now} onOpenTask={reviews.onOpenTask} evidence={evidence} />
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

/** A round on a daemon with the panel: its line with the tier, the areas that need a capture, then a row per reviewer. */
function PanelRound({
  round,
  touch,
  now,
  onOpenTask,
  evidence,
}: {
  round: AutoReviewRound
  touch: boolean
  now: number
  onOpenTask: OpenTask
  evidence: EvidenceOptions
}) {
  const reviews = round.legacy ? [] : sortedReviews(round.reviews ?? [])
  const faint = round.state === "superseded"
  // an older daemon sends no `required`; one without captures is not asked to draw it
  const required = evidence && !round.legacy ? round.required ?? [] : []
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
      {required.length > 0 && (
        <p
          data-required={required.join(",")}
          title={REQUIRED_TITLE}
          className={cn("truncate pb-0.5 pl-[19px] text-[11px]", faint ? "text-faint" : "text-muted-foreground")}
        >
          {requiredWords(required)}
        </p>
      )}
      {reviews.length > 0 && (
        <ul aria-label={`Reviewers for ${roundName(round).toLowerCase()}`} className="pb-1 pl-[19px]">
          {reviews.map((review) => (
            <ReviewRow key={review.id} round={round} review={review} touch={touch} faint={faint} onOpenTask={onOpenTask} evidence={evidence} />
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
  evidence,
}: {
  round: AutoReviewRound
  review: AutoReviewReview
  touch: boolean
  /** the round was superseded: everything under it is moot */
  faint: boolean
  onOpenTask: OpenTask
  evidence: EvidenceOptions
}) {
  const letter = REVIEWER_LETTER[review.role]
  const quiet = faint || review.state === "superseded"
  const task = review.reviewerTaskId
  return (
    <li data-review={review.carried ? "carried" : review.state} data-reviewer={letter}>
      <div className={cn("flex min-w-0 items-center gap-2", touch ? "min-h-11" : "min-h-6")}>
        <span title={REVIEWER_ROLE_WORDS[review.role]} className="w-2.5 shrink-0 text-[11px] font-medium text-fg-secondary">
          {letter}
        </span>
        <span title={reviewAgentWords(review.agent)} className="max-w-[40%] shrink-0 truncate text-[11px] text-muted-foreground">
          {review.agent.harness}
          {review.agent.model && <span className="font-mono text-[10.5px]"> · {review.agent.model}</span>}
        </span>
        {review.fallback && (
          <span data-fallback={review.fallback.cause} title={reviewFallbackWords(review) ?? undefined} className="shrink-0 text-[10.5px] text-faint">
            fallback
          </span>
        )}
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
      </div>
      {evidence && <ReviewEvidence review={review} letter={letter} touch={touch} src={evidence.src} />}
    </li>
  )
}

/**
 * What a settled reviewer showed, under its row: A's waived captures first,
 * as a notice, then its images — small thumbnails that wrap, the first
 * EVIDENCE_SHOWN of them and `+N more` for the rest. While the round runs the
 * daemon sends no evidence, and a withheld verdict draws none either.
 */
function ReviewEvidence({
  review,
  letter,
  touch,
  src,
}: {
  review: AutoReviewReview
  letter: string
  touch: boolean
  src: ReviewsModel["evidenceSrc"]
}) {
  const [all, setAll] = useState(false)
  const images = review.evidence ?? []
  const waivers = review.waivers ?? []
  if (!reviewSettled(review) || (images.length === 0 && waivers.length === 0)) return null
  const shown = all ? images : images.slice(0, EVIDENCE_SHOWN)
  const hidden = images.length - shown.length
  return (
    <div className="flex flex-col gap-1.5 pt-0.5 pb-2 pl-[18px]">
      {waivers.length > 0 && (
        <div role="note" aria-label={`${WAIVED_WORD} by reviewer ${letter}`} className="border-l-2 border-border-strong pl-2 text-[11px] text-state-needs-input">
          <p className="font-medium">{WAIVED_WORD}</p>
          <ul>
            {waivers.map((waiver) => (
              <li key={waiver.area} data-waiver={waiver.area} className="break-words">
                <span className="font-medium">{waiver.area}</span> — {waiver.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
      {images.length > 0 && (
        <ul aria-label={`Evidence from reviewer ${letter}`} className="flex flex-wrap items-start gap-2">
          {shown.map((image) => (
            <EvidenceThumb key={`${image.turn}:${image.id}`} image={image} taskId={image.reviewerTaskId ?? review.reviewerTaskId} src={src?.(image) ?? null} />
          ))}
          {hidden > 0 && (
            <li>
              <button
                type="button"
                onClick={() => setAll(true)}
                aria-label={`Show ${hidden} more ${hidden === 1 ? "image" : "images"} from reviewer ${letter}`}
                className={cn(
                  "inline-flex h-16 items-center rounded-md px-2 text-[11.5px] text-muted-foreground transition-colors hover:bg-hover hover:text-foreground",
                  "focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
                  touch && "min-w-11",
                )}
              >
                +{hidden} more
              </button>
            </li>
          )}
        </ul>
      )}
    </div>
  )
}

/**
 * One image: a thumbnail that expands in the attachment viewer, then who made
 * it. A capture adds its area, viewport and path, and the marks a person should
 * weigh: served from outside the reviewer's worktree (amber, the page may not
 * be this change), served from somewhere unknown, or taken after a script.
 * Bytes come through the authenticated output route, as a turn's outputs do.
 */
function EvidenceThumb({ image, taskId, src: given }: { image: AutoReviewEvidence; taskId: string | null; src: string | null }) {
  const path = taskId ? outputImageUrl(taskId, image.turn, image.id) : null
  const { src: loaded, failed } = useAssetStatus(given ? null : path)
  const src = given ?? loaded
  const [open, setOpen] = useState(false)
  const [broken, setBroken] = useState(false)
  const missing = broken || (!given && (failed || path === null))
  const capture = image.capture
  return (
    <li
      data-evidence={capture ? "captured" : "published"}
      data-served={capture?.servedFrom ?? undefined}
      title={evidenceTitle(image)}
      className="w-[112px] min-w-0"
    >
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={!src || missing}
        aria-label={`Expand ${image.name}`}
        className="flex h-16 w-full cursor-zoom-in items-center justify-center overflow-hidden rounded-sm bg-surface focus-visible:outline focus-visible:outline-ring disabled:cursor-default"
      >
        {missing ? (
          <span className="text-[10.5px] text-faint">Image unavailable</span>
        ) : (
          <img
            src={src ?? undefined}
            alt={image.name}
            loading="lazy"
            onLoad={() => setBroken(false)}
            onError={() => setBroken(true)}
            className="size-full object-cover object-top"
          />
        )}
      </button>
      <p className="mt-1 truncate text-[10.5px] text-muted-foreground">{capture ? CAPTURED_WORD : PUBLISHED_WORD}</p>
      {capture && <p className="truncate font-mono text-[10px] text-faint">{captureDetail(capture)}</p>}
      {capture?.servedFrom === "elsewhere" && <p className="text-[10.5px] leading-snug text-state-needs-input">{SERVED_ELSEWHERE_WORDS}</p>}
      {capture?.servedFrom === "unknown" && <p className="truncate text-[10.5px] text-faint">{SERVED_UNKNOWN_WORDS}</p>}
      {capture?.scriptUsed && <p className="truncate text-[10.5px] text-faint">{SCRIPT_WORDS}</p>}
      <AttachmentViewer
        files={[image]}
        index={open ? 0 : null}
        onIndex={() => {}}
        onClose={() => setOpen(false)}
        localSrcFor={() => src ?? ""}
      />
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
