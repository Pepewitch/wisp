/**
 * Auto-review rounds: one row per reviewer task, each about one head of the
 * author task's PR. The autopilot row decides when a round starts and what a
 * verdict does; this module only keeps the rows honest.
 */
import { randomBytes } from "node:crypto"
import { resolve } from "node:path"
import type { AutoReviewEvidence, AutoReviewFinding, AutoReviewRound, AutoReviewRoundState } from "../../../shared/api/auto-review"
import { db } from "../store-database"
import { randomId } from "../store"
import { REVIEW_TOKEN_ENV } from "../turn-input"
import type { Task } from "../types"

export interface RoundRow {
  id: string
  task_id: string
  workflow_id: string
  pr: number
  head: string
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
}

/** How many counted rounds one PR gets before auto-review pauses for a person. */
export const MAX_REVIEW_ROUNDS = 3

/** A verdict that ends the round (the rest are what became of it). */
export const VERDICT_STATES: readonly AutoReviewRoundState[] = ["pass", "fail", "inconclusive", "recipe"]

export function createRound(input: {
  taskId: string; workflowId: string; pr: number; head: string; round: number; counted: boolean; recipeVersion: string | null
}, now = new Date()): RoundRow {
  const id = randomId("r", 12)
  db.run(`INSERT INTO auto_review_rounds(id, task_id, workflow_id, pr, head, round, counted, token, recipe_version, state, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?)`,
  [id, input.taskId, input.workflowId, input.pr, input.head, input.round, input.counted ? 1 : 0, randomBytes(24).toString("base64url"), input.recipeVersion, now.toISOString()])
  return getRound(id)!
}

export function getRound(id: string): RoundRow | null {
  return db.query("SELECT * FROM auto_review_rounds WHERE id = ?").get(id) as RoundRow | null
}

export function setRoundReviewer(id: string, reviewerTaskId: string): void {
  db.run("UPDATE auto_review_rounds SET reviewer_task_id = ? WHERE id = ?", [reviewerTaskId, id])
}

/** The newest round about this very head of this PR. */
export function latestRound(workflowId: string, pr: number, head: string): RoundRow | null {
  return db.query(`SELECT * FROM auto_review_rounds WHERE workflow_id = ? AND pr = ? AND head = ?
    ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(workflowId, pr, head) as RoundRow | null
}

/** Every round of a task, newest first; one PR's when given. */
export function roundsOf(taskId: string, pr?: number): RoundRow[] {
  return (pr === undefined
    ? db.query("SELECT * FROM auto_review_rounds WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 200").all(taskId)
    : db.query("SELECT * FROM auto_review_rounds WHERE task_id = ? AND pr = ? ORDER BY created_at DESC, rowid DESC LIMIT 200").all(taskId, pr)) as RoundRow[]
}

export function roundOfReviewer(reviewerTaskId: string): RoundRow | null {
  return db.query("SELECT * FROM auto_review_rounds WHERE reviewer_task_id = ? ORDER BY created_at DESC LIMIT 1").get(reviewerTaskId) as RoundRow | null
}

/** Rounds still running on a head other than this one: a newer push made them moot. */
export function staleRunningRounds(workflowId: string, head: string): RoundRow[] {
  return db.query("SELECT * FROM auto_review_rounds WHERE workflow_id = ? AND state = 'running' AND head != ?").all(workflowId, head) as RoundRow[]
}

/** Every round still running for a task, whatever the head. */
export function runningRounds(taskId: string): RoundRow[] {
  return db.query("SELECT * FROM auto_review_rounds WHERE task_id = ? AND state = 'running'").all(taskId) as RoundRow[]
}

/** The token a reviewer's turns carry: only while its round still waits for a verdict. */
export function reviewTokenFor(reviewerTaskId: string): string | null {
  const row = db.query("SELECT token FROM auto_review_rounds WHERE reviewer_task_id = ? AND state = 'running' LIMIT 1").get(reviewerTaskId) as { token: string } | null
  return row?.token ?? null
}

/** The environment a reviewer's turn adds: its round's token, while the round is open. */
export function reviewTurnEnv(task: Task): Record<string, string> {
  if (task.verify_role !== "reviewer") return {}
  const token = reviewTokenFor(task.id)
  return token ? { [REVIEW_TOKEN_ENV]: token } : {}
}

/** Record a verdict, once: a round that already ended keeps what it said. */
export function finishRound(id: string, verdict: {
  state: AutoReviewRoundState; cause?: string | null; summary?: string | null; findings?: AutoReviewFinding[]
  recipeFeedback?: string | null; recipeArea?: string | null; evidence?: AutoReviewEvidence[]
}, now = new Date()): boolean {
  const result = db.run(`UPDATE auto_review_rounds SET state = ?, cause = ?, summary = ?, findings_json = ?, recipe_feedback = ?,
    recipe_area = ?, evidence_json = ?, finished_at = ? WHERE id = ? AND state = 'running'`, [
    verdict.state, verdict.cause ?? null, verdict.summary ?? null, JSON.stringify(verdict.findings ?? []),
    verdict.recipeFeedback ?? null, verdict.recipeArea ?? null, JSON.stringify(verdict.evidence ?? []), now.toISOString(), id,
  ])
  return result.changes === 1
}

export function markNudged(id: string): void {
  db.run("UPDATE auto_review_rounds SET nudged = 1 WHERE id = ?", [id])
}

/** Counted rounds that ended with a verdict for one PR. */
export function countedRounds(workflowId: string, pr: number): number {
  const row = db.query(`SELECT COUNT(*) AS n FROM auto_review_rounds WHERE workflow_id = ? AND pr = ? AND counted = 1
    AND state IN ('pass', 'fail', 'inconclusive', 'running')`).get(workflowId, pr) as { n: number }
  return row.n
}

/** Reviewer feedback about the recipe, from rounds that blamed it after a moment (an activation), newest first. */
export function recipeComplaints(repoPath: string, since: string | null): { round: RoundRow; area: string | null; feedback: string }[] {
  const target = resolve(repoPath)
  const rows = db.query(`SELECT r.*, t.repo_path AS repo FROM auto_review_rounds r JOIN tasks t ON t.id = r.task_id
    WHERE r.state = 'recipe' AND (?1 IS NULL OR r.finished_at > ?1) ORDER BY r.finished_at DESC LIMIT 200`)
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

export function roundView(row: RoundRow): AutoReviewRound {
  return {
    id: row.id, pr: row.pr, head: row.head, round: row.round, counted: row.counted === 1, state: row.state,
    summary: row.summary, findings: parsed<AutoReviewFinding[]>(row.findings_json, []), recipeFeedback: row.recipe_feedback, recipeArea: row.recipe_area,
    evidence: parsed<AutoReviewEvidence[]>(row.evidence_json, []), reviewerTaskId: row.reviewer_task_id,
    recipeVersion: row.recipe_version, createdAt: row.created_at, finishedAt: row.finished_at,
  }
}
