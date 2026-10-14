/**
 * The reviews of an auto-review round: one per reviewer on its panel. A
 * round is created with every required review at once (they never shrink on
 * their own); each review has its own task, token and verdict; the round's
 * own columns are the aggregate, written when its last required review ends.
 */
import { randomBytes } from "node:crypto"
import type {
  AutoReviewEvidence, AutoReviewFinding, AutoReviewReview, AutoReviewRole, AutoReviewRoundState, AutoReviewSignals, AutoReviewTier,
} from "../../../shared/api/auto-review"
import { capturesOfReview } from "../capture/store"
import { db } from "../store-database"
import { randomId } from "../store"
import { REVIEW_TOKEN_ENV } from "../turn-input"
import type { Task } from "../types"
import { getRound, type RoundRow } from "./rounds"

export type ReviewState = AutoReviewRoundState | "pending"

export interface ReviewRow {
  id: string
  round_id: string
  role: AutoReviewRole
  /** 1: the phase-1 verdict shape (a round from before the panel); 2: severity, lens, reviewed, rationale */
  protocol: number
  reviewer_task_id: string | null
  harness: string
  model: string | null
  effort: string | null
  token: string
  state: ReviewState
  cause: string | null
  summary: string | null
  rationale: string | null
  findings_json: string | null
  reviewed_json: string | null
  recipe_feedback: string | null
  recipe_area: string | null
  evidence_json: string | null
  escalated: string | null
  carried_from: string | null
  /** the verifying reviewer's waivers of a required screenshot (protocol 3) */
  waivers_json?: string | null
  nudged: number
  launched_at: string | null
  created_at: string
  finished_at: string | null
}

export interface PanelAgent {
  role: AutoReviewRole
  harness: string
  model: string | null
  effort: string | null
}

const TERMINAL: readonly ReviewState[] = ["pass", "fail", "inconclusive", "recipe", "error", "superseded"]
export const isTerminal = (state: ReviewState): boolean => TERMINAL.includes(state)

const newToken = (): string => randomBytes(24).toString("base64url")

/**
 * A new round and every review its panel needs, in one transaction. A review
 * carried over from an earlier round (it passed on the same head) is copied
 * as it ended; the rest start pending.
 */
export function createPanelRound(input: {
  taskId: string; workflowId: string; pr: number; head: string; base: string; round: number; counted: boolean
  recipeVersion: string | null; tier: AutoReviewTier; signals: AutoReviewSignals | null; agents: PanelAgent[]
  carried?: ReviewRow[]
  /** recipe areas whose change needs reviewer A to show a capture (verify/evidence.ts) */
  required?: string[]
}, now = new Date()): { round: RoundRow; reviews: ReviewRow[] } {
  return db.transaction(() => {
    const id = randomId("r", 12)
    const at = now.toISOString()
    const roles = input.agents.map((agent) => agent.role)
    // the round's own token is a phase-1 column (NOT NULL): no route accepts it any more, each review carries its own
    db.run(`INSERT INTO auto_review_rounds(id, task_id, workflow_id, pr, head, base, round, counted, token, recipe_version, state,
      tier, signals_json, roles, protocol, required_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, 2, ?, ?)`,
    [id, input.taskId, input.workflowId, input.pr, input.head, input.base, input.round, input.counted ? 1 : 0, newToken(), input.recipeVersion,
      input.tier, input.signals ? JSON.stringify(input.signals) : null, JSON.stringify(roles), JSON.stringify(input.required ?? []), at])
    for (const agent of input.agents) {
      const carried = input.carried?.find((review) => review.role === agent.role && review.state === "pass")
      if (carried) {
        db.run(`INSERT INTO round_reviews(id, round_id, role, protocol, reviewer_task_id, harness, model, effort, token, state, cause, summary,
          rationale, findings_json, reviewed_json, recipe_feedback, recipe_area, evidence_json, escalated, waivers_json, carried_from, launched_at, created_at, finished_at)
          SELECT ?, ?, role, protocol, reviewer_task_id, harness, model, effort, ?, state, cause, summary, rationale, findings_json, reviewed_json,
          recipe_feedback, recipe_area, evidence_json, escalated, waivers_json, id, launched_at, ?, finished_at FROM round_reviews WHERE id = ?`, [randomId("v", 12), id, newToken(), at, carried.id])
        continue
      }
      // protocol 3: the panel's verdict shape plus captures and waivers
      db.run(`INSERT INTO round_reviews(id, round_id, role, protocol, harness, model, effort, token, state, created_at)
        VALUES (?, ?, ?, 3, ?, ?, ?, ?, 'pending', ?)`, [randomId("v", 12), id, agent.role, agent.harness, agent.model, agent.effort, newToken(), at])
    }
    return { round: getRound(id)!, reviews: reviewsOf(id) }
  })()
}

/** Add a second reviewer to a round that has none (the primary escalated a light round). */
export function addSecondReview(roundId: string, agent: Omit<PanelAgent, "role">, now = new Date()): ReviewRow | null {
  return db.transaction(() => {
    const round = getRound(roundId)
    if (!round || round.state !== "running" || reviewsOf(roundId).some((review) => review.role === "second")) return null
    const id = randomId("v", 12)
    db.run(`INSERT INTO round_reviews(id, round_id, role, protocol, harness, model, effort, token, state, created_at)
      VALUES (?, ?, 'second', 3, ?, ?, ?, ?, 'pending', ?)`, [id, roundId, agent.harness, agent.model, agent.effort, newToken(), now.toISOString()])
    db.run("UPDATE auto_review_rounds SET roles = ?, tier = 'standard' WHERE id = ?", [JSON.stringify(["primary", "second"]), roundId])
    return getReview(id)
  })()
}

export function getReview(id: string): ReviewRow | null {
  return db.query("SELECT * FROM round_reviews WHERE id = ?").get(id) as ReviewRow | null
}

/** A round's reviews, primary first. */
export function reviewsOf(roundId: string): ReviewRow[] {
  return db.query("SELECT * FROM round_reviews WHERE round_id = ? ORDER BY CASE role WHEN 'primary' THEN 0 ELSE 1 END").all(roundId) as ReviewRow[]
}

/** The review a reviewer task works on (its newest). */
export function reviewOfTask(taskId: string): ReviewRow | null {
  return db.query("SELECT * FROM round_reviews WHERE reviewer_task_id = ? ORDER BY created_at DESC LIMIT 1").get(taskId) as ReviewRow | null
}

/** A pending review now has its task: it runs. */
export function launchedReview(id: string, taskId: string, now = new Date()): boolean {
  return db.transaction(() => {
    // the task is linked even when the review ended while it was being created, so the sweep still retires it
    db.run("UPDATE round_reviews SET reviewer_task_id = ? WHERE id = ? AND reviewer_task_id IS NULL", [taskId, id])
    const launched = db.run("UPDATE round_reviews SET state = 'running', launched_at = ? WHERE id = ? AND state = 'pending'",
      [now.toISOString(), id]).changes === 1
    // reviewer A's task on the round too, where a client from before the panel looks for it
    if (launched) {
      db.run(`UPDATE auto_review_rounds SET reviewer_task_id = ?
        WHERE id = (SELECT round_id FROM round_reviews WHERE id = ? AND role = 'primary') AND reviewer_task_id IS NULL`, [taskId, id])
    }
    return launched
  })()
}

/** Record a reviewer's verdict, once, while its review runs. */
export function finishReview(id: string, verdict: {
  state: AutoReviewRoundState; cause?: string | null; summary?: string | null; rationale?: string | null; findings?: AutoReviewFinding[]
  reviewed?: string[]; recipeFeedback?: string | null; recipeArea?: string | null; evidence?: AutoReviewEvidence[]; escalated?: string | null
  waivers?: { area: string; reason: string }[]
}, now = new Date()): boolean {
  return db.run(`UPDATE round_reviews SET state = ?, cause = ?, summary = ?, rationale = ?, findings_json = ?, reviewed_json = ?,
    recipe_feedback = ?, recipe_area = ?, evidence_json = ?, escalated = ?, waivers_json = ?, finished_at = ? WHERE id = ? AND state = 'running'`, [
    verdict.state, verdict.cause ?? null, verdict.summary ?? null, verdict.rationale ?? null, JSON.stringify(verdict.findings ?? []),
    JSON.stringify(verdict.reviewed ?? []), verdict.recipeFeedback ?? null, verdict.recipeArea ?? null, JSON.stringify(verdict.evidence ?? []),
    verdict.escalated ?? null, verdict.waivers && verdict.waivers.length > 0 ? JSON.stringify(verdict.waivers) : null, now.toISOString(), id,
  ]).changes === 1
}

/** End a review that will give no verdict (an error, a superseding push): only while it is still open. */
export function endReview(id: string, state: "error" | "superseded", summary: string, now = new Date()): boolean {
  return db.run("UPDATE round_reviews SET state = ?, summary = ?, finished_at = ? WHERE id = ? AND state IN ('pending', 'running')",
    [state, summary, now.toISOString(), id]).changes === 1
}

export function markReviewNudged(id: string): void {
  db.run("UPDATE round_reviews SET nudged = nudged + 1 WHERE id = ?", [id])
}

/** The token a reviewer's turns carry: only while its own review runs. */
export function reviewTokenFor(reviewerTaskId: string): string | null {
  const row = db.query("SELECT token FROM round_reviews WHERE reviewer_task_id = ? AND state = 'running' ORDER BY created_at DESC LIMIT 1")
    .get(reviewerTaskId) as { token: string } | null
  return row?.token ?? null
}

/** The environment a reviewer's turn adds: its review's token, while the review is open. */
export function reviewTurnEnv(task: Task): Record<string, string> {
  if (task.verify_role !== "reviewer") return {}
  const token = reviewTokenFor(task.id)
  return token ? { [REVIEW_TOKEN_ENV]: token } : {}
}

/**
 * Ended reviews whose reviewer task is still on the books: archived once its
 * turn is over (at once for a superseded or errored one, and regardless for
 * one that ended before `lingeringBefore`).
 */
export function unretiredReviews(lingeringBefore: string): ReviewRow[] {
  return db.query(`SELECT v.* FROM round_reviews v JOIN tasks t ON t.id = v.reviewer_task_id
    WHERE v.state NOT IN ('pending', 'running') AND v.carried_from IS NULL AND t.archived = 0
      AND (v.state IN ('superseded', 'error') OR t.state NOT IN ('creating', 'running', 'stuck') OR v.finished_at < ?)
    ORDER BY v.finished_at LIMIT 20`).all(lingeringBefore) as ReviewRow[]
}

function parsed<T>(json: string | null, fallback: T): T {
  if (!json) return fallback
  try {
    return JSON.parse(json) as T
  } catch {
    return fallback
  }
}

/** A finding's severity: a phase-1 finding on a rejection blocked, any other was a note. */
export function severityOf(finding: AutoReviewFinding, reviewState: ReviewState): "blocking" | "note" {
  return finding.severity ?? (reviewState === "fail" ? "blocking" : "note")
}

export function findingsOf(review: ReviewRow): AutoReviewFinding[] {
  return parsed<AutoReviewFinding[]>(review.findings_json, []).map((finding) => ({ ...finding, severity: severityOf(finding, review.state), by: review.role }))
}

/** A review's images, each marked with what Wisp saw when it took it (a carried review's captures are its origin's). */
function withCaptures(review: ReviewRow): AutoReviewEvidence[] {
  const captures = new Map(capturesOfReview(review.carried_from ?? review.id)
    .filter((capture) => capture.status === "ok" && capture.image_id).map((capture) => [capture.image_id!, capture]))
  return evidenceOf(review).map((image) => {
    const capture = captures.get(image.id)
    return capture ? {
      ...image, capture: {
        id: capture.id, area: capture.area, url: capture.final_url ?? capture.requested_url, servedFrom: capture.served_from, viewport: capture.viewport,
        scriptUsed: capture.script_used === 1, settled: capture.settled === 1,
      },
    } : image
  })
}

export function evidenceOf(review: ReviewRow): AutoReviewEvidence[] {
  return parsed<AutoReviewEvidence[]>(review.evidence_json, []).map((image) => ({ ...image, reviewerTaskId: image.reviewerTaskId ?? review.reviewer_task_id ?? undefined }))
}

/**
 * The round's verdict from its reviews, by the outcome table: any blocking
 * finding rejects (so a defect is never hidden behind a recipe hold or an
 * error), then a recipe the primary could not follow holds, then an error
 * needs a person, then an inconclusive change rejects; only when every
 * required review passed does the round pass.
 */
export function outcomeOf(reviews: ReviewRow[]): AutoReviewRoundState {
  const blocking = reviews.some((review) => findingsOf(review).some((finding) => finding.severity === "blocking"))
  if (blocking) return "fail"
  if (reviews.some((review) => review.role === "primary" && review.state === "recipe")) return "recipe"
  if (reviews.some((review) => review.state === "error")) return "error"
  if (reviews.some((review) => review.state === "inconclusive" || review.state === "fail")) return "inconclusive"
  return reviews.length > 0 && reviews.every((review) => review.state === "pass") ? "pass" : "error"
}

/**
 * Once every required review has ended, write the round's aggregate (one
 * transaction, once): its state by the outcome table, both reviewers'
 * findings with who said them, and their evidence. Null while one is open.
 */
export function settleRound(roundId: string, now = new Date()): RoundRow | null {
  return db.transaction(() => {
    const round = getRound(roundId)
    if (!round || round.state !== "running") return round
    const reviews = reviewsOf(roundId)
    if (reviews.length === 0 || reviews.some((review) => !isTerminal(review.state))) return null
    if (reviews.some((review) => review.state === "superseded")) {
      db.run("UPDATE auto_review_rounds SET state = 'superseded', finished_at = ? WHERE id = ? AND state = 'running'", [now.toISOString(), roundId])
      return getRound(roundId)
    }
    const state = outcomeOf(reviews)
    const findings = reviews.flatMap(findingsOf).sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "blocking" ? -1 : 1))
    const primary = reviews.find((review) => review.role === "primary")
    const recipe = primary?.state === "recipe" ? primary : null
    const summary = reviews.map((review) => `${review.role === "primary" ? "A" : "B"}: ${review.state}${review.summary ? ` — ${review.summary}` : ""}`).join(" · ")
    db.run(`UPDATE auto_review_rounds SET state = ?, cause = ?, summary = ?, findings_json = ?, recipe_feedback = ?, recipe_area = ?,
      evidence_json = ?, reviewer_task_id = COALESCE(reviewer_task_id, ?), finished_at = ? WHERE id = ? AND state = 'running'`, [
      state, state === "inconclusive" ? "change" : null, summary.slice(0, 1200), JSON.stringify(findings.slice(0, 40)),
      recipe?.recipe_feedback ?? null, recipe?.recipe_area ?? null, JSON.stringify(reviews.flatMap(evidenceOf).slice(0, 32)),
      primary?.reviewer_task_id ?? null, now.toISOString(), roundId,
    ])
    return getRound(roundId)
  })()
}

/** End every open review of a round and the round itself (a push, a retarget, a switch-off), in one transaction. */
export function supersedeRound(roundId: string, why: string, now = new Date()): ReviewRow[] {
  return db.transaction(() => {
    const ended: ReviewRow[] = []
    for (const review of reviewsOf(roundId)) if (endReview(review.id, "superseded", why, now)) ended.push(getReview(review.id)!)
    db.run("UPDATE auto_review_rounds SET state = 'superseded', summary = ?, finished_at = ? WHERE id = ? AND state = 'running'", [why, now.toISOString(), roundId])
    return ended
  })()
}

/** The verdicts a reviewer gives; while its round is open, each shows only as "submitted". */
const VERDICTS = new Set<string>(["pass", "fail", "inconclusive", "recipe"])

/**
 * A review as the API shows it. While its round is still open, a verdict of
 * this round is withheld, its kind as well as its words (and so is an
 * escalation's reason): the other reviewer must not read any of it before it
 * has spoken. A review carried from a settled round is already public.
 */
export function reviewView(review: ReviewRow, roundOpen: boolean): AutoReviewReview {
  const withhold = roundOpen && review.carried_from === null
  const sealed = withhold && VERDICTS.has(review.state)
  return {
    id: review.id, role: review.role, agent: { harness: review.harness, model: review.model }, state: sealed ? "submitted" : review.state,
    summary: withhold ? null : review.summary, rationale: withhold ? null : review.rationale,
    findings: withhold ? [] : findingsOf(review), reviewed: withhold ? [] : parsed<string[]>(review.reviewed_json, []),
    evidence: withhold ? [] : withCaptures(review), escalated: withhold ? null : review.escalated, carried: review.carried_from !== null,
    waivers: withhold ? [] : parsed<{ area: string; reason: string }[]>(review.waivers_json ?? null, []),
    reviewerTaskId: review.reviewer_task_id, createdAt: review.created_at, finishedAt: review.finished_at,
  }
}
