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

export interface AutoReviewFinding {
  title: string
  detail?: string
  file?: string
  line?: number
}

/** An image the reviewer published as evidence (GET /api/tasks/:reviewer/outputs/:turn/:id). */
export interface AutoReviewEvidence {
  turn: number
  id: string
  name: string
  mediaType: string
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
