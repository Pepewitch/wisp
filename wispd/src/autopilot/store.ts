/**
 * Autopilot's durable state: one `pr-autopilot` row per task in the
 * `workflows` table. Params hold only the owner's intent (which toggles are
 * on); everything that evolves — the bound PR, heads seen, a Stop hold, a merge
 * attempt — lives in the checkpoint, so a toggle is never an edit to evidence.
 */
import type { AutopilotState, AutopilotStatus, AutopilotUpdate } from "../../../shared/autopilot"
import { db } from "../store-database"
import { getTask, randomId } from "../store"
import { announceWorkflow, changeWorkflowState, getWorkflow, recordWorkflow, type WorkflowRow } from "../workflows/store"
import { AUTOPILOT_TYPE, CONTEXT_CHANGE_PAUSE } from "./type"

export interface AutopilotCheckpoint {
  pr?: number
  /** the task's turn count when Stop was pressed; nothing acts until a later turn finishes */
  stopHold?: { turnCount: number }
  /** head sha → when Wisp first saw it (the fresh-head floor) */
  heads?: Record<string, string>
  /** when the PR was first seen out of draft: marking it ready restarts the floor */
  readySince?: string
  /** written BEFORE `gh pr merge` runs, so a crash after it still reads as Wisp's merge */
  mergeAttempt?: { head: string; at: string }
  mergeFailures?: { head: string; count: number }
  /** the semantic state of an active row */
  state?: AutopilotState
  outcome?: "merged" | "closed"
  /** set with outcome "merged": the base it went into, and whether Wisp merged it */
  merged?: { base: string; byWisp: boolean; noted: boolean }
  /** what the saved reason describes (see AutopilotStatus.about) */
  about?: "pr" | "task"
}

export interface AutopilotParams {
  autoMerge: boolean
  autoFix: boolean
}

const FAR_FUTURE = "9999-12-31T23:59:59.999Z"

export function checkpointOf(row: WorkflowRow): AutopilotCheckpoint {
  try {
    const parsed = JSON.parse(row.checkpoint_json) as unknown
    return parsed && typeof parsed === "object" ? parsed as AutopilotCheckpoint : {}
  } catch {
    return {}
  }
}

export function paramsOf(row: WorkflowRow): AutopilotParams {
  const params = JSON.parse(row.params_json) as Record<string, unknown>
  return { autoMerge: params.autoMerge === true, autoFix: params.autoFix === true }
}

/** The task's unfinished autopilot row, if it has one. */
export function autopilotRow(taskId: string): WorkflowRow | null {
  return db.query(`SELECT * FROM workflows WHERE task_id = ? AND type = ? AND state != 'completed'
    ORDER BY created_at DESC, id DESC LIMIT 1`).get(taskId, AUTOPILOT_TYPE) as WorkflowRow | null
}

function latestRow(taskId: string): WorkflowRow | null {
  return db.query(`SELECT * FROM workflows WHERE task_id = ? AND type = ? ORDER BY created_at DESC, id DESC LIMIT 1`)
    .get(taskId, AUTOPILOT_TYPE) as WorkflowRow | null
}

const OFF: AutopilotStatus = { autoMerge: false, autoFix: false, pr: null, state: "off", reason: "", about: "task", mergedByWisp: false, updatedAt: null }

export function statusOf(row: WorkflowRow | null): AutopilotStatus {
  if (!row) return OFF
  const checkpoint = checkpointOf(row)
  const params = paramsOf(row)
  const pr = checkpoint.pr ?? null
  if (row.state === "completed") {
    return {
      ...OFF, pr, state: checkpoint.outcome === "merged" ? "merged" : "off", reason: row.reason,
      about: checkpoint.outcome ? "pr" : "task", mergedByWisp: checkpoint.merged?.byWisp === true, updatedAt: row.updated_at,
    }
  }
  // The agent-switch trigger pauses every active workflow; autopilot follows
  // the task instead, and its next check reactivates it. Until then it is
  // simply still waiting, not a pause anyone has to answer.
  const state: AutopilotState = row.state === "paused"
    ? row.reason === CONTEXT_CHANGE_PAUSE ? "waiting" : "paused"
    : checkpoint.state ?? "waiting"
  const reason = row.state === "paused" && row.reason === CONTEXT_CHANGE_PAUSE ? "Following the task's agent change" : row.reason
  // A pause is always about the PR (a merge that keeps failing, GitHub's own
  // auto-merge found on); a hold or a wait on the task never is.
  const about = state === "paused" ? "pr" : state === "held" ? "task" : checkpoint.about ?? "task"
  return { autoMerge: params.autoMerge, autoFix: params.autoFix, pr, state, reason, about, mergedByWisp: false, updatedAt: row.updated_at }
}

export function autopilotStatus(taskId: string): AutopilotStatus {
  return statusOf(latestRow(taskId))
}

/** Every task's latest autopilot row, for the task list. */
export function autopilotStatuses(): Map<string, AutopilotStatus> {
  const rows = db.query("SELECT * FROM workflows WHERE type = ? ORDER BY created_at, id").all(AUTOPILOT_TYPE) as WorkflowRow[]
  const latest = new Map<string, WorkflowRow>()
  for (const row of rows) latest.set(row.task_id, row)
  return new Map([...latest].map(([taskId, row]) => [taskId, statusOf(row)]))
}

export class AutopilotError extends Error {
  constructor(message: string, readonly status = 400) { super(message) }
}

/** Arm, update, or disarm. Idempotent: setting what is already set changes nothing. */
export function setAutopilot(taskId: string, update: AutopilotUpdate, now = new Date()): AutopilotStatus {
  if (update.autoFix === true) throw new AutopilotError("Auto-fix is not available yet")
  const result = db.transaction(() => {
    const task = getTask(taskId)
    if (!task) throw new AutopilotError("Task not found", 404)
    const row = autopilotRow(taskId)
    const current = row ? paramsOf(row) : { autoMerge: false, autoFix: false }
    const next: AutopilotParams = { autoMerge: update.autoMerge ?? current.autoMerge, autoFix: false }
    const at = now.toISOString()
    if (!next.autoMerge) {
      if (row) changeWorkflowState(row.id, "completed", "Auto-merge off", now)
      return
    }
    if (task.archived) throw new AutopilotError("An archived task cannot auto-merge", 409)
    if (task.mode === "local") throw new AutopilotError("Auto-merge needs a task with its own branch; this one runs in the project checkout", 409)
    if (row) {
      if (current.autoMerge === next.autoMerge) return
      db.run("UPDATE workflows SET params_json = ?, revision = revision + 1, next_check_at = ?, updated_at = ? WHERE id = ?",
        [JSON.stringify(next), at, at, row.id])
      recordWorkflow(row.id, "configured", "Auto-merge on", at)
      return
    }
    const id = randomId("w", 12)
    db.run(`INSERT INTO workflows(id, task_id, type, version, params_json, checkpoint_json, state, reason, context_n, next_check_at, expires_at, created_at, updated_at)
      VALUES (?, ?, ?, '1', ?, '{}', 'active', 'Waiting for a PR', ?, ?, ?, ?, ?)`,
    [id, taskId, AUTOPILOT_TYPE, JSON.stringify(next), task.context_n, at, FAR_FUTURE, at, at])
    recordWorkflow(id, "armed", "Auto-merge on", at)
  })
  result()
  announceWorkflow(taskId)
  return autopilotStatus(taskId)
}

/** Resume a paused row, or release a Stop hold early ("Continue now"). */
export function resumeAutopilot(taskId: string, now = new Date()): AutopilotStatus {
  const row = autopilotRow(taskId)
  if (!row) throw new AutopilotError("Auto-merge is not on for this task", 409)
  const checkpoint = checkpointOf(row)
  delete checkpoint.stopHold
  delete checkpoint.mergeFailures
  checkpoint.state = "waiting"
  db.run("UPDATE workflows SET checkpoint_json = ?, revision = revision + 1, next_check_at = ?, updated_at = ? WHERE id = ?",
    [JSON.stringify(checkpoint), now.toISOString(), now.toISOString(), row.id])
  if (row.state === "paused") changeWorkflowState(row.id, "active", "Resumed", now)
  else recordWorkflow(row.id, "resumed", "Continued", now.toISOString())
  announceWorkflow(taskId)
  return autopilotStatus(taskId)
}

/** A reason with its counts stripped: history records a change of situation, not a ticking count. */
const reasonClass = (state: string, reason: string): string => `${state}:${reason.replace(/\d+/g, "#")}`

export interface AutopilotCheck {
  state: AutopilotState
  reason: string
  /** defaults to "task": only the gate and the merge speak about the PR itself */
  about?: "pr" | "task"
  checkpoint: AutopilotCheckpoint
  delayMs: number
  failures?: number
}

/** Save one evaluation. False when the row moved on meanwhile (a toggle, Stop, a resume): the result is stale. */
export function saveAutopilotCheck(row: WorkflowRow, check: AutopilotCheck, now: Date): boolean {
  const current = getWorkflow(row.id)
  if (!current || current.state !== "active" || current.revision !== row.revision) return false
  const at = now.toISOString()
  const previous = checkpointOf(current)
  const checkpoint = { ...check.checkpoint, state: check.state, about: check.about ?? "task" }
  db.run(`UPDATE workflows SET checkpoint_json = ?, reason = ?, check_count = check_count + 1, failures = ?,
    last_checked_at = ?, next_check_at = ?, updated_at = CASE WHEN reason = ? THEN updated_at ELSE ? END WHERE id = ?`,
  [JSON.stringify(checkpoint), check.reason, check.failures ?? 0, at, new Date(now.getTime() + check.delayMs).toISOString(), check.reason, at, row.id])
  const changed = current.reason !== check.reason || previous.state !== check.state
  if (reasonClass(previous.state ?? "", current.reason) !== reasonClass(check.state, check.reason)) {
    recordWorkflow(row.id, check.state === "needs-you" ? "blocked" : "wait", check.reason, at)
  }
  if (changed) announceWorkflow(row.task_id)
  return true
}

/** Write the checkpoint and bump the revision in one step, so an in-flight check discards its answer. */
export function writeAutopilotCheckpoint(row: WorkflowRow, checkpoint: AutopilotCheckpoint, now: Date): boolean {
  const result = db.run(`UPDATE workflows SET checkpoint_json = ?, revision = revision + 1, updated_at = ?
    WHERE id = ? AND revision = ? AND state = 'active'`, [JSON.stringify(checkpoint), now.toISOString(), row.id, row.revision])
  return result.changes === 1
}

export function finishAutopilot(row: WorkflowRow, outcome: "merged" | "closed", reason: string, now: Date, merged?: { base: string; byWisp: boolean }): void {
  const checkpoint: AutopilotCheckpoint = { ...checkpointOf(getWorkflow(row.id) ?? row), outcome }
  if (merged) checkpoint.merged = { ...merged, noted: false }
  db.run("UPDATE workflows SET checkpoint_json = ? WHERE id = ?", [JSON.stringify(checkpoint), row.id])
  changeWorkflowState(row.id, "completed", reason, now)
}

export function pauseAutopilot(row: WorkflowRow, reason: string, now: Date): void {
  const current = getWorkflow(row.id)
  if (!current || current.state !== "active") return
  changeWorkflowState(row.id, "paused", reason, now)
}

/**
 * Rows the autopilot loop should look at now: due ones of any unfinished state
 * (a paused row still gets a slow look for a PR someone merged or closed), and
 * at once any the agent-switch trigger paused, which autopilot follows.
 */
export function dueAutopilots(now: Date): WorkflowRow[] {
  return db.query(`SELECT * FROM workflows WHERE type = ? AND state != 'completed' AND (
      next_check_at <= ? OR (state = 'paused' AND reason = ?)
    ) ORDER BY next_check_at LIMIT 50`).all(AUTOPILOT_TYPE, now.toISOString(), CONTEXT_CHANGE_PAUSE) as WorkflowRow[]
}

/** Push a row's next look out without touching anything else about it. */
export function deferAutopilot(row: WorkflowRow, at: Date): void {
  db.run("UPDATE workflows SET next_check_at = ? WHERE id = ? AND revision = ?", [at.toISOString(), row.id, row.revision])
}

/** Bring a due row forward, so the loop looks at it on its next pass. */
export function checkAutopilotSoon(taskId: string, now = new Date()): boolean {
  const result = db.run("UPDATE workflows SET next_check_at = ? WHERE task_id = ? AND type = ? AND state = 'active' AND next_check_at > ?",
    [now.toISOString(), taskId, AUTOPILOT_TYPE, now.toISOString()])
  return result.changes > 0
}

/**
 * Wisp's standing notes for the agent's next turn. While auto-merge is on, a
 * note that arming it IS asking for a push (the preamble otherwise forbids
 * one). Once after a merge, a note that the branch is finished — the agent's
 * next change must not pile onto a merged branch.
 */
export interface TurnNotes {
  notes: string[]
  /** Call once the turn really started: a one-time note is spent only then. */
  delivered(): void
}

const NO_NOTES: TurnNotes = { notes: [], delivered() {} }

export function autopilotTurnNotes(taskId: string): TurnNotes {
  const row = autopilotRow(taskId)
  if (row && paramsOf(row).autoMerge && checkpointOf(row).state === "merging") {
    // gh said it merged and Wisp is confirming: the one thing a turn must not
    // do now is push to that branch.
    return { notes: [`Wisp has just merged PR #${checkpointOf(row).pr} and is confirming it. Do not push to its branch; start any further change on a new branch from the base branch.`], delivered() {} }
  }
  if (row && paramsOf(row).autoMerge) {
    const pr = checkpointOf(row).pr
    const which = pr ? `PR #${pr}` : "this task's pull request"
    return { notes: [[
      `Auto-merge is on for this task. When the work is ready, commit it, push the branch, and open a pull request if there is not one yet.`,
      `Wisp merges ${which} once its checks pass and its reviews allow it, so you do not need to wait for CI or merge it yourself. Other pull requests are unaffected.`,
    ].join(" ")], delivered() {} }
  }
  const latest = latestRow(taskId)
  if (!latest || latest.state !== "completed") return NO_NOTES
  const checkpoint = checkpointOf(latest)
  const merged = checkpoint.merged
  if (checkpoint.outcome !== "merged" || !merged || merged.noted) return NO_NOTES
  const who = merged.byWisp ? "was merged by Wisp" : "was merged"
  return {
    notes: [`PR #${checkpoint.pr} ${who}. Its branch is finished: start any further change on a new branch from origin/${merged.base}.`],
    delivered() {
      db.run("UPDATE workflows SET checkpoint_json = ? WHERE id = ?", [JSON.stringify({ ...checkpoint, merged: { ...merged, noted: true } }), latest.id])
    },
  }
}
