/**
 * Auto-review and verification recipes, as the API serves them. The daemon
 * owns every decision; clients only show rounds and recipe state and start
 * the tasks a person asks for.
 */

/** What a reviewer said about one head, or what became of its round. */
export type AutoReviewRoundState =
  /** the reviewer task is working */
  | "running"
  /** verified: every changed behaviour was observed working */
  | "pass"
  /** the reviewer found a defect in the change */
  | "fail"
  /** the change could not be verified, and the change itself is why */
  | "inconclusive"
  /** the recipe failed the reviewer (a broken launch, a missing area): not the author's to fix */
  | "recipe"
  /** the reviewer ended without a verdict, or its task failed */
  | "error"
  /** a newer head arrived while it ran */
  | "superseded"

/** How much a review covers, measured by Wisp from the diff (verify/depth.ts). */
export type AutoReviewTier = "light" | "standard" | "deep"

/** A finding's weight: blocking stops the merge, a note does not. */
export type FindingSeverity = "blocking" | "note"

/** The rubric's lenses (verify/rubric.ts); verification is the reviewer who runs the app. */
export type FindingLens = "correctness" | "architecture" | "slop" | "security" | "performance" | "tests" | "docs" | "verification"

/** On a panel: A verifies and reviews, B reviews only. */
export type AutoReviewRole = "primary" | "second"

export interface AutoReviewFinding {
  title: string
  detail?: string
  file?: string
  line?: number
  /** absent on a finding from before the review panel (phase 1) */
  severity?: FindingSeverity
  lens?: FindingLens
  /** which reviewer said it, set by Wisp (never by the reviewer) */
  by?: AutoReviewRole
}

/** An image the reviewer published as evidence (GET /api/tasks/:reviewer/outputs/:turn/:id). */
export interface AutoReviewEvidence {
  turn: number
  id: string
  name: string
  mediaType: string
  /** the reviewer task that published it; absent on phase-1 rounds (it was the round's reviewer) */
  reviewerTaskId?: string
  /** present when Wisp took it (`wisp capture`): what it opened, and where the page was served from */
  capture?: { id: string; area: string | null; url: string; servedFrom: "worktree" | "elsewhere" | "unknown" | null; viewport: string; scriptUsed: boolean; settled: boolean }
}

/** What Wisp measured about a round's diff to choose its tier. */
export interface AutoReviewSignals {
  lines: number
  files: number
  areas: number
  unmapped: number
  /** the recipe maps areas at all (absent on rounds measured before this was recorded) */
  mapped?: boolean
  sensitive: string[]
  testsTouched: boolean
  docsOnly: boolean
}

/** One reviewer's part of a round. */
export interface AutoReviewReview {
  id: string
  role: AutoReviewRole
  agent: { harness: string; model: string | null }
  /** pending: waiting for a task slot to start; running; submitted: it gave a verdict this still-open round withholds; or how it ended */
  state: AutoReviewRoundState | "pending" | "submitted"
  summary: string | null
  rationale: string | null
  findings: AutoReviewFinding[]
  /** what the reviewer says it reviewed */
  reviewed: string[]
  evidence: AutoReviewEvidence[]
  /** the primary reviewer asked for a second opinion on a light round */
  escalated: string | null
  /** carried over from an earlier round on the same head: it passed, and was not run again */
  carried: boolean
  /** areas whose required screenshot the verifying reviewer waived, and why (Wisp recorded a reason it could not capture) */
  waivers?: { area: string; reason: string }[]
  reviewerTaskId: string | null
  createdAt: string
  finishedAt: string | null
}

export interface AutoReviewRound {
  id: string
  pr: number
  head: string
  /** the counted round it belongs to (1…3); a re-run after a recipe fix keeps the number */
  round: number
  /** false for a re-run after the recipe was fixed: it does not spend the round budget */
  counted: boolean
  state: AutoReviewRoundState
  summary: string | null
  findings: AutoReviewFinding[]
  /** what the reviewer learned about the recipe: what failed, what is missing */
  recipeFeedback: string | null
  /** the recipe area that feedback is about, when the reviewer named one */
  recipeArea: string | null
  evidence: AutoReviewEvidence[]
  reviewerTaskId: string | null
  /** the recipe version it was judged against; null when the project had none */
  recipeVersion: string | null
  createdAt: string
  finishedAt: string | null
  /** absent from a daemon older than the review panel */
  tier?: AutoReviewTier | null
  signals?: AutoReviewSignals | null
  /** a round from before the review panel: one reviewer, no rubric, no tier */
  legacy?: boolean
  /** each reviewer's part; while the round runs, a reviewer's words are withheld until all have spoken */
  reviews?: AutoReviewReview[]
  /** recipe areas whose change needs reviewer A to show a capture (absent before captures) */
  required?: string[]
}

/** GET /api/tasks/:id/auto-review, advertised by `features.autoReview`: the task's rounds, newest first. */
export interface AutoReviewRoundsResponse {
  rounds: AutoReviewRound[]
}

/** POST /api/tasks/:reviewer/auto-review/verdict: what `wisp review submit` sends. */
export interface AutoReviewVerdictBody {
  /** WISP_REVIEW_TOKEN, given only to the reviewer's turns */
  token: string
  verdict: "pass" | "fail" | "inconclusive"
  /** with inconclusive: whether the change or the recipe kept it from being verified */
  cause?: "change" | "recipe"
  summary: string
  findings?: AutoReviewFinding[]
  recipeFeedback?: string
  /** the recipe area the feedback is about */
  recipeArea?: string
  /** what was reviewed: areas, files, behaviours (≤ 30 items) */
  reviewed?: string[]
  /** why the verdict, in a few sentences (≤ 2000 characters) */
  rationale?: string
  /** the primary reviewer, on a light round, asks for a second reviewer */
  escalate?: { reason: string }
  /** the verifying reviewer's word for a required screenshot Wisp could not take (protocol 3) */
  waivers?: { area: string; reason: string }[]
}

export interface VerificationArea {
  name: string
  paths: string[]
  status: "proven" | "unproven"
  /** a reviewer reported this area's recipe failing since it was last activated */
  attention: string | null
}

/** A recipe task: setting up, improving, or fixing one area of the recipe. */
export interface VerificationTask {
  id: string
  mode: "setup" | "improve" | "fix"
  area: string | null
  state: string
  archived: boolean
}

/** GET /api/projects/verification?path=…, and `verification` on each GET /api/repos entry. */
export interface VerificationStatus {
  state: "none" | "active"
  /** the active recipe's version; null with none */
  version: string | null
  activatedAt: string | null
  areas: VerificationArea[]
  /** a recipe task's proposal waiting to be activated */
  draft: { taskId: string; savedAt: string; areas: { name: string; paths: string[]; status: "proven" | "unproven" }[] } | null
  /** the newest recipe task that is not archived */
  task: VerificationTask | null
  /** who reviews: the project's choice, or null to use each task's own agent */
  reviewer: { harness: string; model: string | null; effort: string | null } | null
  /**
   * the second reviewer: a chosen agent, "off" (one reviewer always), or null
   * for the same agent as the reviewer; absent from a daemon without the panel
   */
  second?: { harness: string; model: string | null; effort: string | null } | "off" | null
  /** reviewer feedback about a recipe gap with no area to pin it on, since the last activation */
  attention: string | null
}

/** POST /api/projects/verification/tasks */
export interface VerificationTaskBody {
  path: string
  mode: "setup" | "improve" | "fix"
  area?: string
  note?: string
  harness?: string
  model?: string
  effort?: string
}
