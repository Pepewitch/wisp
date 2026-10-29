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
  /**
   * Two uses, by state: a settled verdict's cause (settleRound: `change` on an
   * inconclusive round), and why a superseded round ended (supersedeRound:
   * `head` a push, `base` a retarget, `off` a switch-off or archive). A
   * round superseded before that was written has none.
   */
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
  /** recipe areas reviewer A must show with a capture, fixed when the round was planned */
  required_json?: string | null
  /** the panel's required roles, as JSON */
  roles?: string | null
  /** 1: a phase-1 round (one reviewer, no rubric); 2: a panel */
  protocol?: number
  /**
   * Reviewed and acted on whatever its checks say (migration 29), and so is a
   * re-run of it: 1 started by Review now, 2 started on its own once the head
   * was ready (repos[].reviewStart "ready"); 0 waited for the checks.
   */
  early?: number
}

/** How many rejections one PR's review budget allows before auto-review pauses for a person. */
export const MAX_REVIEW_ROUNDS = 3

/** Rounds that end without a verdict (pushed over once launched, an error, a recipe hold) before a PR's rounds wait for its checks again. */
export const UNPRODUCTIVE_LIMIT = 2 * MAX_REVIEW_ROUNDS

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

/** The newest round of this PR under this workflow since `since`, on any head. */
export function latestPrRound(workflowId: string, pr: number, since: string): RoundRow | null {
  return db.query(`SELECT * FROM auto_review_rounds WHERE workflow_id = ? AND pr = ? AND created_at >= ?
    ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(workflowId, pr, since) as RoundRow | null
}

/** The highest round number of this PR under this workflow, in any state and from any epoch; 0 for none. The next round is one more. */
export function highestRound(workflowId: string, pr: number): number {
  const row = db.query("SELECT MAX(round) AS n FROM auto_review_rounds WHERE workflow_id = ? AND pr = ?").get(workflowId, pr) as { n: number | null } | null
  return row?.n ?? 0
}

/** A round as the author, the reviewers and the status read it: "round 4 · 1 of 3 rejections used". */
export const budgetWords = (round: number, spent: number): string => `round ${round} · ${spent} of ${MAX_REVIEW_ROUNDS} rejections used`

/** What a PR's review budget stands at, read from its round rows alone. */
export interface ReviewLedger {
  /** the highest round number (highestRound) */
  highest: number
  /** rejections spent from the current budget */
  spent: number
  /** rounds in the PR's whole life on this task (every workflow and epoch) that ended without a verdict worth their tokens */
  unproductive: number
}

/**
 * Only a round that rejected the head, or could not verify the change,
 * spends the budget: one per round number (an error's re-run that fails
 * spends that number once), since `since` (auto-review's epoch) and above
 * `base` (the round numbers spent before the latest Resume). A round pushed
 * over after its reviewers launched (cause `head` or `base`), an error and a
 * recipe hold are unproductive, counted over the PR's whole life on this
 * task, whatever workflow and epoch they ran under: free up to
 * UNPRODUCTIVE_LIMIT rows. Each row past it that belongs to the current
 * budget (this workflow, since `since`, above `base`) spends one, so the
 * pause bounds them too; an older workflow's rows only count toward the limit.
 */
export function reviewLedger(workflowId: string, pr: number, since: string, base = 0): ReviewLedger {
  const rejected = db.query(`SELECT COUNT(DISTINCT round) AS n FROM auto_review_rounds WHERE workflow_id = ? AND pr = ? AND created_at >= ? AND round > ?
    AND state IN ('fail', 'inconclusive')`).get(workflowId, pr, since, base) as { n: number }
  // Keyed by task, not workflow: switching every switch off completes the workflow and switching
  // back on starts a new one, which must not hand back free rounds.
  const unproductive = db.query(`SELECT r.round, r.workflow_id, r.created_at FROM auto_review_rounds r
    WHERE r.task_id = (SELECT task_id FROM workflows WHERE id = ?) AND r.pr = ?
    AND (r.state IN ('error', 'recipe') OR (r.state = 'superseded' AND r.cause IN ('head', 'base')
      AND EXISTS (SELECT 1 FROM round_reviews v WHERE v.round_id = r.id AND v.launched_at IS NOT NULL AND v.carried_from IS NULL)))
    ORDER BY r.created_at, r.rowid`).all(workflowId, pr) as { round: number; workflow_id: string; created_at: string }[]
  const over = unproductive.slice(UNPRODUCTIVE_LIMIT)
    .filter((row) => row.workflow_id === workflowId && row.created_at >= since && row.round > base).length
  return { highest: highestRound(workflowId, pr), spent: rejected.n + over, unproductive: unproductive.length }
}

/**
 * Auto-review's epoch, written straight to the row when it has none (a
 * checkpoint from before reviewArmedAt existed). It does not wait for a look's
 * save, which a moved revision or a throw can drop, so no round is ever
 * planned before the epoch that counts it is stored. Fills a missing value
 * only; returns the stored one.
 */
export function armReviewEpoch(workflowId: string, at: string): string {
  db.run("UPDATE workflows SET checkpoint_json = json_set(checkpoint_json, '$.reviewArmedAt', ?) WHERE id = ? AND json_extract(checkpoint_json, '$.reviewArmedAt') IS NULL", [at, workflowId])
  const row = db.query("SELECT json_extract(checkpoint_json, '$.reviewArmedAt') AS armed FROM workflows WHERE id = ?").get(workflowId) as { armed: string | null } | null
  return row?.armed ?? at
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
    required: parsed<string[]>(row.required_json ?? null, []),
  }
}
