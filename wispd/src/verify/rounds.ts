/**
 * Auto-review rounds: one row per review of one head of the author task's
 * PR. A round's reviewers are its reviews (verify/reviews.ts); the round's
 * own columns are their aggregate. The autopilot row decides when a round
 * starts and what its verdict does; this module only keeps the rows honest.
 */
import { resolve } from "node:path"
import type { AutoReviewEvidence, AutoReviewFinding, AutoReviewRound, AutoReviewRoundState, AutoReviewSignals, AutoReviewTier } from "../../../shared/api/auto-review"
import { db } from "../store-database"

export interface RoundRow {
  id: string
  task_id: string
  workflow_id: string
  pr: number
  head: string
  /** the base branch it was reviewed against: a retarget changes the diff, so a pass holds for this base only */
  base: string
  round: number
  counted: number
  reviewer_task_id: string | null
  token: string
  recipe_version: string | null
  state: AutoReviewRoundState
  cause: string | null
  summary: string | null
  findings_json: string | null
  recipe_feedback: string | null
  recipe_area: string | null
  evidence_json: string | null
  nudged: number
  created_at: string
  finished_at: string | null
  /** null on a phase-1 round */
  tier?: AutoReviewTier | null
  signals_json?: string | null
  /** the panel's required roles, as JSON */
  roles?: string | null
  /** 1: a phase-1 round (one reviewer, no rubric); 2: a panel */
  protocol?: number
}

/** How many counted rounds one PR gets before auto-review pauses for a person. */
export const MAX_REVIEW_ROUNDS = 3

/** A verdict that ends the round (the rest are what became of it). */
export const VERDICT_STATES: readonly AutoReviewRoundState[] = ["pass", "fail", "inconclusive", "recipe"]

export function getRound(id: string): RoundRow | null {
  return db.query("SELECT * FROM auto_review_rounds WHERE id = ?").get(id) as RoundRow | null
}

/** The newest round about this very head of this PR, against this base. */
export function latestRound(workflowId: string, pr: number, head: string, base: string): RoundRow | null {
  return db.query(`SELECT * FROM auto_review_rounds WHERE workflow_id = ? AND pr = ? AND head = ? AND base = ?
    ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(workflowId, pr, head, base) as RoundRow | null
}

/** Every round of a task, newest first; one PR's when given. */
export function roundsOf(taskId: string, pr?: number): RoundRow[] {
  return (pr === undefined
    ? db.query("SELECT * FROM auto_review_rounds WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 200").all(taskId)
    : db.query("SELECT * FROM auto_review_rounds WHERE task_id = ? AND pr = ? ORDER BY created_at DESC, rowid DESC LIMIT 200").all(taskId, pr)) as RoundRow[]
}

/** The round a reviewer task works for (through its review). */
export function roundOfReviewer(reviewerTaskId: string): RoundRow | null {
  return db.query(`SELECT r.* FROM auto_review_rounds r JOIN round_reviews v ON v.round_id = r.id
    WHERE v.reviewer_task_id = ? ORDER BY v.created_at DESC LIMIT 1`).get(reviewerTaskId) as RoundRow | null
}

/** The highest tier this PR's rounds have had: within one PR a tier only goes up. */
export function highestTier(workflowId: string, pr: number): AutoReviewTier | null {
  // a round whose diff could not be read was deep by default, not by measure: it does not hold later rounds up
  const rows = db.query("SELECT DISTINCT tier FROM auto_review_rounds WHERE workflow_id = ? AND pr = ? AND tier IS NOT NULL AND signals_json IS NOT NULL")
    .all(workflowId, pr) as { tier: AutoReviewTier }[]
  const order: AutoReviewTier[] = ["deep", "standard", "light"]
  return order.find((tier) => rows.some((row) => row.tier === tier)) ?? null
}

/** Rounds still running on another head or base than the PR's now: a push or a retarget made them moot. */
export function staleRunningRounds(workflowId: string, head: string, base: string): RoundRow[] {
  return db.query("SELECT * FROM auto_review_rounds WHERE workflow_id = ? AND state = 'running' AND (head != ? OR base != ?)").all(workflowId, head, base) as RoundRow[]
}

/**
 * Running rounds nobody will act on: their autopilot row finished (switched
 * off, PR closed, task archived) or no longer has auto-review on.
 */
export function orphanedRounds(): RoundRow[] {
  return db.query(`SELECT r.* FROM auto_review_rounds r LEFT JOIN workflows w ON w.id = r.workflow_id
    WHERE r.state = 'running' AND (w.id IS NULL OR w.state = 'completed'
      OR COALESCE(json_extract(w.params_json, '$.autoReview'), 0) != 1)`).all() as RoundRow[]
}

/** Every round still running for a task, whatever the head. */
export function runningRounds(taskId: string): RoundRow[] {
  return db.query("SELECT * FROM auto_review_rounds WHERE task_id = ? AND state = 'running'").all(taskId) as RoundRow[]
}

/** Reviewer feedback about the recipe, from rounds that blamed it after a moment (an activation), newest first. */
export function recipeComplaints(repoPath: string, since: string | null): { round: RoundRow; area: string | null; feedback: string }[] {
  const target = resolve(repoPath)
  // a recipe hold, or a rejection whose primary also could not follow the recipe
  const rows = db.query(`SELECT r.*, t.repo_path AS repo FROM auto_review_rounds r JOIN tasks t ON t.id = r.task_id
    WHERE (r.state = 'recipe' OR (r.state = 'fail' AND r.recipe_feedback IS NOT NULL))
      AND (?1 IS NULL OR r.finished_at > ?1) ORDER BY r.finished_at DESC LIMIT 200`)
    .all(since) as (RoundRow & { repo: string })[]
  return rows.filter((row) => resolve(row.repo) === target).slice(0, 20).map((round) => ({
    round, area: round.recipe_area, feedback: round.recipe_feedback ?? round.summary ?? "The recipe failed the reviewer",
  }))
}

function parsed<T>(json: string | null, fallback: T): T {
  if (!json) return fallback
  try {
    return JSON.parse(json) as T
  } catch {
    return fallback
  }
}

export function roundView(row: RoundRow, reviews: AutoReviewRound["reviews"] = []): AutoReviewRound {
  return {
    id: row.id, pr: row.pr, head: row.head, round: row.round, counted: row.counted === 1, state: row.state,
    summary: row.summary, findings: parsed<AutoReviewFinding[]>(row.findings_json, []), recipeFeedback: row.recipe_feedback, recipeArea: row.recipe_area,
    evidence: parsed<AutoReviewEvidence[]>(row.evidence_json, []), reviewerTaskId: row.reviewer_task_id,
    recipeVersion: row.recipe_version, createdAt: row.created_at, finishedAt: row.finished_at,
    tier: row.tier ?? null, signals: parsed<AutoReviewSignals | null>(row.signals_json ?? null, null), legacy: (row.protocol ?? 1) < 2, reviews,
  }
}
