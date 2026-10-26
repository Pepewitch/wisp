import {
  FALLBACK_CAUSE_WORDS,
  type AutoReviewEvidence,
  type AutoReviewFinding,
  type AutoReviewReview,
  type AutoReviewRole,
  type AutoReviewRound,
  type AutoReviewRoundState,
  type AutoReviewSignals,
  type AutoReviewTier,
  type VerificationStatus,
} from "../../../shared/api/auto-review"
import type { VerificationSummary } from "./types"

/*
 * Auto-review and verification recipes, in words: the Autopilot tab's Reviews
 * list, the sidebar's verification control, and the project settings'
 * Verification section all read from here. Pure, so the gallery draws the
 * same words the app does.
 */

/** What became of a round, as the Reviews list says it. */
export const ROUND_WORD: Record<AutoReviewRoundState, string> = {
  running: "Reviewing",
  pass: "Passed",
  fail: "Rejected",
  inconclusive: "Inconclusive",
  recipe: "Recipe failed the reviewer",
  error: "No verdict",
  superseded: "Superseded",
}

/**
 * The round's dot. Hue on the dot only: green for a pass, the workflow blue
 * while a reviewer works, red for a rejection or a reviewer that failed, the
 * needs-input amber where a person may have to look, and faint once a newer
 * head made it moot.
 */
export const ROUND_DOT: Record<AutoReviewRoundState, string> = {
  running: "bg-state-background",
  pass: "bg-state-done",
  fail: "bg-destructive",
  inconclusive: "bg-state-needs-input",
  recipe: "bg-state-needs-input",
  error: "bg-state-failed",
  superseded: "bg-border-strong",
}

/**
 * The rounds of the PR the switches are bound to, newest first; with no PR
 * bound, those of the newest PR any round was about.
 */
export function roundsForPr(rounds: readonly AutoReviewRound[], pr: number | null): AutoReviewRound[] {
  const which = pr ?? rounds[0]?.pr ?? null
  return which === null ? [] : rounds.filter((round) => round.pr === which)
}

/** The round's verdict and what the reviewer said: `Rejected — the toast still fires twice`. */
export function roundVerdict(round: AutoReviewRound): string {
  const said = round.state === "recipe" ? round.recipeFeedback ?? round.summary : round.summary ?? round.recipeFeedback
  return said ? `${ROUND_WORD[round.state]} — ${said}` : ROUND_WORD[round.state]
}

/** `Round 2`, or `Round 2 re-run` for one that does not spend the budget (after a recipe fix). */
export function roundName(round: AutoReviewRound): string {
  return round.counted ? `Round ${round.round}` : `Round ${round.round} re-run`
}

/* ── the review panel ───────────────────────────────────────────────────── */

/** A reviewer's state on a panel: a round's states, plus waiting for a task slot. */
export type ReviewState = AutoReviewReview["state"]

/** What became of one reviewer's part, as its row says it. */
export const REVIEW_WORD: Record<ReviewState, string> = {
  ...ROUND_WORD,
  pending: "Waiting for a slot",
  submitted: "Verdict in",
}

/** A reviewer's dot: a round's, and the faint neutral while it waits for a slot. */
export const REVIEW_DOT: Record<ReviewState, string> = {
  ...ROUND_DOT,
  pending: "bg-border-strong",
  submitted: "bg-border-strong",
}

/** A carried review passed on this head in an earlier round and was not run again. */
export const KEPT_WORD = "Kept"

/** On a panel A runs the app and reviews the code; B reviews the code only. */
export const REVIEWER_LETTER: Record<AutoReviewRole, "A" | "B"> = { primary: "A", second: "B" }

/** What each reviewer does, for the letter's title. */
export const REVIEWER_ROLE_WORDS: Record<AutoReviewRole, string> = {
  primary: "Reviewer A runs the app and reviews the code",
  second: "Reviewer B reviews the code only",
}

/** `deep review`: how much a round covers, measured by Wisp from the diff. */
export const TIER_WORD: Record<AutoReviewTier, string> = {
  light: "light review",
  standard: "standard review",
  deep: "deep review",
}

/** `claude · opus-5`, or the harness alone when it runs its own default model. */
export function reviewAgentWords(agent: AutoReviewReview["agent"]): string {
  return agent.model ? `${agent.harness} · ${agent.model}` : agent.harness
}

/**
 * Why the agent on a review's row stood in for another, for its `fallback`
 * mark's title: `Fallback for droid · kimi-k3, whose task failed on the
 * network: getaddrinfo ENOTFOUND`. Null for a review on its first agent.
 */
export function reviewFallbackWords(review: AutoReviewReview): string | null {
  const fallback = review.fallback
  if (!fallback) return null
  const from = reviewAgentWords({ harness: fallback.from.harness, model: fallback.from.model })
  return `Fallback for ${from}, whose task ${FALLBACK_CAUSE_WORDS[fallback.cause]}${fallback.detail ? `: ${fallback.detail}` : ""}`
}

/**
 * What Wisp measured to choose the tier, for the tier's title:
 * `412 changed lines · 9 files · 2 areas · sensitive: db/migrations/0042.sql`.
 */
export function signalsWords(signals: AutoReviewSignals): string {
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
  const parts = [
    plural(signals.lines, "changed line", "changed lines"),
    plural(signals.files, "file", "files"),
    plural(signals.areas, "area", "areas"),
  ]
  if (signals.unmapped > 0) parts.push(`${plural(signals.unmapped, "file", "files")} in no area`)
  if (signals.docsOnly) parts.push("docs only")
  else if (signals.testsTouched) parts.push("tests touched")
  if (signals.sensitive.length > 0) parts.push(`sensitive: ${signals.sensitive.join(", ")}`)
  return parts.join(" · ")
}

/** The tier's title: what it means, then what Wisp measured. */
export function tierTitle(round: AutoReviewRound): string | undefined {
  if (!round.tier) return undefined
  const word = TIER_WORD[round.tier]
  const what = `${word[0]!.toUpperCase()}${word.slice(1)}, chosen by Wisp from the diff`
  return round.signals ? `${what}\n${signalsWords(round.signals)}` : what
}

/** The reviewer's state word: `Kept` for a carried pass, otherwise what became of it. */
export function reviewWord(review: AutoReviewReview): string {
  return review.carried ? KEPT_WORD : REVIEW_WORD[review.state]
}

/**
 * A reviewer row's words: the state, then why A asked for a second opinion
 * when it did, then what it said — `Passed · escalated: touches the auth
 * middleware`, `Rejected — the toast fires twice`. While the round runs, the
 * daemon withholds the others' words, so a summary may be null.
 */
export function reviewVerdict(review: AutoReviewReview): string {
  const word = reviewWord(review)
  if (review.escalated) return `${word} · escalated: ${review.escalated}`
  return review.summary ? `${word} — ${review.summary}` : word
}

/** The row's title: every word it may truncate, what kept means, and the findings, blocking first. */
export function reviewTitle(review: AutoReviewReview): string {
  const lines = [reviewVerdict(review)]
  if (review.escalated && review.summary) lines.push(review.summary)
  if (review.carried) lines.push("Passed on this head in an earlier round, so it was not run again")
  // blocking first: the ones that stop the merge
  const findings = [...review.findings].sort((a, b) => Number(b.severity === "blocking") - Number(a.severity === "blocking"))
  for (const finding of findings) lines.push(`• ${findingLine(finding)}`)
  return lines.join("\n")
}

/** One finding, severity first: `Blocking: Autosave races a manual save (web/src/store.ts:88)`. */
export function findingLine(finding: AutoReviewFinding): string {
  const lead = finding.severity === "blocking" ? "Blocking: " : finding.severity === "note" ? "Note: " : ""
  const where = finding.file ? ` (${finding.file}${finding.line ? `:${finding.line}` : ""})` : ""
  return `${lead}${finding.title}${where}`
}

/* ── verification recipes ───────────────────────────────────────────────── */

/** The sidebar control's dot: something to say, in the one tone it needs, or nothing. */
export type VerificationTone = "attention" | "busy" | "draft" | null

/** Attention outranks a working task, which outranks a draft waiting for a person. */
export function verificationTone(summary: VerificationSummary): VerificationTone {
  if (summary.attention) return "attention"
  if (summary.busy) return "busy"
  if (summary.draft) return "draft"
  return null
}

/**
 * The tone's dot. Red is needs-you (a reviewer reported the recipe failing);
 * the workflow blue is a recipe task working; a draft waiting to be activated
 * is the neutral foreground — something to see, nothing broken, and never the
 * accent.
 */
export const VERIFICATION_DOT: Record<Exclude<VerificationTone, null>, string> = {
  attention: "bg-destructive",
  busy: "bg-state-background",
  draft: "bg-muted-foreground",
}

/** The sidebar control's name: the state it is in, one line. */
export function verificationTitle(summary: VerificationSummary): string {
  const tone = verificationTone(summary)
  if (tone === "attention") return "Verification needs attention"
  if (tone === "busy") return "Verification: a recipe task is working"
  if (tone === "draft") return "Verification: draft ready to activate"
  if (summary.state === "none") return "Verification: not set up"
  return `Verification: ${summary.areas} ${summary.areas === 1 ? "area" : "areas"}`
}

/** The section's first line: `No verification recipe yet`, or `Recipe 3 · 4 areas`. */
export function verificationStateLine(status: VerificationStatus): string {
  if (status.state === "none") return "No verification recipe yet"
  const areas = `${status.areas.length} ${status.areas.length === 1 ? "area" : "areas"}`
  return status.version ? `Recipe ${status.version} · ${areas}` : `Recipe · ${areas}`
}

/** What a recipe task is doing, for the line that links to it. */
export function recipeTaskWords(task: NonNullable<VerificationStatus["task"]>): string {
  if (task.mode === "setup") return "Setting up the recipe"
  if (task.mode === "improve") return "Improving the recipe"
  return task.area ? `Fixing ${task.area}` : "Fixing the recipe"
}

/* ── evidence: what a reviewer showed, and what Wisp captured ──────────── */

/** Evidence shows only once a review has settled: while its round runs, the daemon sends none. */
export function reviewSettled(review: AutoReviewReview): boolean {
  return review.state !== "running" && review.state !== "pending" && review.state !== "submitted"
}

/** How many thumbnails a strip draws before it folds the rest behind `+N more`. */
export const EVIDENCE_SHOWN = 6

/** Who made the image. Never "verified": a capture proves only what Wisp saw. */
export const CAPTURED_WORD = "Captured by Wisp"
export const PUBLISHED_WORD = "Published by the reviewer"

/** Where a captured page came from, when that is worth a word: a warning, or a quiet unknown. */
export const SERVED_ELSEWHERE_WORDS = "served from outside the reviewer's worktree"
export const SERVED_UNKNOWN_WORDS = "served from an unknown place"
export const SCRIPT_WORDS = "after a script"

/** `/settings/profile` from a sanitized URL; the URL itself when it does not parse. */
export function capturePath(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.pathname}${parsed.hash}`
  } catch {
    return url
  }
}

/** A capture's provenance line: `web · desktop · /settings`, with the area only when it named one. */
export function captureDetail(capture: NonNullable<AutoReviewEvidence["capture"]>): string {
  return [capture.area, capture.viewport, capturePath(capture.url)].filter(Boolean).join(" · ")
}

/** A thumbnail's title: everything its caption truncates, and what each mark means. */
export function evidenceTitle(evidence: AutoReviewEvidence): string {
  const capture = evidence.capture
  if (!capture) return `${PUBLISHED_WORD}\n${evidence.name}`
  const lines = [CAPTURED_WORD, evidence.name]
  if (capture.area) lines.push(`Area: ${capture.area}`)
  lines.push(`Viewport: ${capture.viewport}`, `Opened: ${capture.url}`)
  if (capture.servedFrom === "worktree") lines.push("Served from the reviewer's worktree")
  else if (capture.servedFrom === "elsewhere") lines.push(`${upper(SERVED_ELSEWHERE_WORDS)}: it may not show this change`)
  else if (capture.servedFrom === "unknown") lines.push("Wisp could not tell where the page was served from")
  if (capture.scriptUsed) lines.push("Taken after the reviewer's script ran on the page")
  if (!capture.settled) lines.push("Taken before the network went quiet")
  return lines.join("\n")
}

/** The heading over A's waived captures, each `area — the reason Wisp recorded`. */
export const WAIVED_WORD = "Capture waived"

/** `Needs a capture: web, admin`: the recipe areas whose change reviewer A must show. */
export function requiredWords(required: readonly string[]): string {
  return `Needs a capture: ${required.join(", ")}`
}

/** The required line's title. */
export const REQUIRED_TITLE = "These recipe areas changed, so reviewer A must show a capture Wisp took of each, or say why it could not"

function upper(words: string): string {
  return `${words[0]!.toUpperCase()}${words.slice(1)}`
}
