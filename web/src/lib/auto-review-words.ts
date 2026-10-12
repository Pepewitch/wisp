import type { AutoReviewRound, AutoReviewRoundState, VerificationStatus } from "../../../shared/api/auto-review"
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
