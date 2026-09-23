/**
 * Autopilot's durable state: one `pr-autopilot` row per task in the
 * `workflows` table. Params hold only the owner's intent (which toggles are
 * on); everything that evolves — the bound PR, heads seen, a Stop hold, a merge
 * attempt — lives in the checkpoint, so a toggle is never an edit to evidence.
 */
import type { AutopilotBy, AutopilotState, AutopilotStatus, AutopilotUpdate } from "../../../shared/autopilot"
import { db } from "../store-database"
import { emit } from "../events"
import { createTaskMessage, getTask, randomId } from "../store"
import { keyParts, markerOf, withDelivered } from "./feedback"
import { taskIsIdle } from "./idle"
import { announceWorkflow, cancelWorkflowMessages, changeWorkflowState, getWorkflow, recordWorkflow, seenWake, type WorkflowRow } from "../workflows/store"
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
  /** auto-fix rounds sent for the bound PR */
  rounds?: number
  /** the workflow runs Wisp reran on this head, so none is rerun twice */
  rerun?: { head: string; runs: number[] }
  /** evidence keys the owner chose not to send */
  skipped?: string[]
  /** when Wisp first saw the task idle after turn `idleTurn`: rounds wait a moment after it */
  idleSince?: string
  idleTurn?: number
  /** a round ready to go once its delay passes */
  pending?: { key: string; summary: string; sendsAt: string }
  /** the owner said Send now — to this evidence key, and no other */
  sendNow?: string
  /** looks in a row that could read none of a round's logs: past a few, it is sent with links only */
  logMisses?: { key: string; count: number }
  /** which switch the saved reason speaks for */
  by?: AutopilotBy
  /** when auto-fix was switched on: turns before it were never asked to mark their GitHub posts */
  fixArmedAt?: string
  /** review items sent to the agent: item id → the fingerprint sent */
  delivered?: Record<string, string>
  /** CI evidence keys sent in a round, alone or with review feedback */
  sentCi?: string[]
  /** turn numbers that started without the note asking the agent to sign its GitHub posts (a slash command) */
  unmarkedTurns?: number[]
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

const OFF: AutopilotStatus = {
  autoMerge: false, autoFix: false, pr: null, state: "off", reason: "", about: "task", by: "auto-merge", mergedByWisp: false,
  pendingFix: null, fixRounds: 0, updatedAt: null,
}

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
  const followingSwitch = row.state === "paused" && row.reason === CONTEXT_CHANGE_PAUSE
  const about = followingSwitch || state === "held" ? "task" : state === "paused" ? "pr" : checkpoint.about ?? "task"
  const pendingFix = row.state === "active" && params.autoFix && state !== "held" && checkpoint.pending
    ? { summary: checkpoint.pending.summary, sendsAt: checkpoint.pending.sendsAt }
    : null
  // a switch that is off speaks for nothing
  const by: AutopilotBy = checkpoint.by === "auto-fix" && params.autoFix ? "auto-fix" : params.autoMerge ? "auto-merge" : "auto-fix"
  return {
    autoMerge: params.autoMerge, autoFix: params.autoFix, pr, state, reason, about, by, mergedByWisp: false,
    pendingFix, fixRounds: checkpoint.rounds ?? 0, updatedAt: row.updated_at,
  }
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
  const result = db.transaction(() => {
    const task = getTask(taskId)
    if (!task) throw new AutopilotError("Task not found", 404)
    const row = autopilotRow(taskId)
    const current = row ? paramsOf(row) : { autoMerge: false, autoFix: false }
    const next: AutopilotParams = { autoMerge: update.autoMerge ?? current.autoMerge, autoFix: update.autoFix ?? current.autoFix }
    const at = now.toISOString()
    if (!next.autoMerge && !next.autoFix) {
      if (row) changeWorkflowState(row.id, "completed", "Auto-merge off", now)
      return
    }
    if (task.archived) throw new AutopilotError("An archived task cannot be switched on", 409)
    if (task.mode === "local") throw new AutopilotError("Auto-merge and auto-fix need a task with its own branch; this one runs in the project checkout", 409)
    const label = [next.autoMerge && "Auto-merge on", next.autoFix && "Auto-fix on"].filter(Boolean).join(", ")
    if (row) {
      if (current.autoMerge === next.autoMerge && current.autoFix === next.autoFix) return
      // switching auto-fix off withdraws a round that has not started yet
      if (current.autoFix && !next.autoFix) cancelWorkflowMessages(row.id)
      const checkpoint = checkpointOf(getWorkflow(row.id) ?? row)
      // switching auto-fix on again is a fresh start for its round budget
      if (!current.autoFix && next.autoFix) {
        delete checkpoint.rounds
        checkpoint.fixArmedAt = at
      }
      // A pause auto-fix made is not auto-merge's to keep once auto-fix is off.
      const lift = row.state === "paused" && current.autoFix && !next.autoFix && checkpoint.by === "auto-fix"
      if (lift) Object.assign(checkpoint, { state: "waiting", about: "task", by: "auto-merge" })
      db.run("UPDATE workflows SET params_json = ?, checkpoint_json = ?, revision = revision + 1, next_check_at = ?, updated_at = ? WHERE id = ?",
        [JSON.stringify(next), JSON.stringify(checkpoint), at, at, row.id])
      recordWorkflow(row.id, "configured", label, at)
      if (lift) changeWorkflowState(row.id, "active", "Auto-fix off", now)
      return
    }
    const id = randomId("w", 12)
    db.run(`INSERT INTO workflows(id, task_id, type, version, params_json, checkpoint_json, state, reason, context_n, next_check_at, expires_at, created_at, updated_at)
      VALUES (?, ?, ?, '1', ?, ?, 'active', 'Waiting for a PR', ?, ?, ?, ?, ?)`,
    [id, taskId, AUTOPILOT_TYPE, JSON.stringify(next), JSON.stringify(next.autoFix ? { fixArmedAt: at } : {}), task.context_n, at, FAR_FUTURE, at, at])
    recordWorkflow(id, "armed", label, at)
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
  // Resume after a pause is a fresh start for auto-fix's round budget too;
  // Continue after a Stop hold is not.
  if (row.state === "paused") delete checkpoint.rounds
  checkpoint.state = "waiting"
  // until the next look, the reason is about the resume, not the PR
  checkpoint.about = "task"
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
  /** defaults to "auto-merge": auto-fix's own looks say so */
  by?: AutopilotBy
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
  const checkpoint = { ...check.checkpoint, state: check.state, about: check.about ?? "task", by: check.by ?? "auto-merge" }
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
  /** the notes ask the agent to sign its GitHub posts */
  marked: boolean
  /** Call once the turn really started: a one-time note is spent only then. */
  delivered(): void
}

const NO_NOTES: TurnNotes = { notes: [], marked: false, delivered() {} }

/** The marker is how Wisp tells the agent's own GitHub posts from a reviewer's. */
function signNote(taskId: string, which: string): string {
  return `Auto-fix is on for this task: Wisp sends you red CI and review feedback on ${which}. End every comment, review or reply you post on GitHub with: — ${getTask(taskId)?.harness ?? "agent"} via Wisp ${markerOf(taskId)}`
}

export function autopilotTurnNotes(taskId: string): TurnNotes {
  const row = autopilotRow(taskId)
  if (row && paramsOf(row).autoMerge && checkpointOf(row).state === "merging") {
    // gh said it merged and Wisp is confirming: the one thing a turn must not
    // do now is push to that branch.
    const notes = [`Wisp has just merged PR #${checkpointOf(row).pr} and is confirming it. Do not push to its branch; start any further change on a new branch from the base branch.`]
    if (paramsOf(row).autoFix) notes.push(signNote(taskId, `PR #${checkpointOf(row).pr}`))
    return { notes, marked: paramsOf(row).autoFix, delivered() {} }
  }
  if (row && (paramsOf(row).autoMerge || paramsOf(row).autoFix)) {
    const { autoMerge, autoFix } = paramsOf(row)
    const pr = checkpointOf(row).pr
    const which = pr ? `PR #${pr}` : "this task's pull request"
    const notes: string[] = []
    if (autoMerge) {
      notes.push([
        `Auto-merge is on for this task. When the work is ready, commit it, push the branch, and open a pull request if there is not one yet.`,
        `Wisp merges ${which} once its checks pass and its reviews allow it, so you do not need to wait for CI or merge it yourself. Other pull requests are unaffected.`,
      ].join(" "))
    }
    if (autoFix) notes.push(signNote(taskId, which))
    return { notes, marked: autoFix, delivered() {} }
  }
  const latest = latestRow(taskId)
  if (!latest || latest.state !== "completed") return NO_NOTES
  const checkpoint = checkpointOf(latest)
  const merged = checkpoint.merged
  if (checkpoint.outcome !== "merged" || !merged || merged.noted) return NO_NOTES
  const who = merged.byWisp ? "was merged by Wisp" : "was merged"
  return {
    notes: [`PR #${checkpoint.pr} ${who}. Its branch is finished: start any further change on a new branch from origin/${merged.base}.`],
    marked: false,
    delivered() {
      db.run("UPDATE workflows SET checkpoint_json = ? WHERE id = ?", [JSON.stringify({ ...checkpoint, merged: { ...merged, noted: true } }), latest.id])
    },
  }
}

/** The auto-fix round message reserved but not started yet, if any. */
export function queuedRound(rowId: string): string | null {
  const row = db.query("SELECT id FROM task_messages WHERE workflow_id = ? AND status = 'queued' AND claim IS NULL LIMIT 1").get(rowId) as { id: string } | null
  return row?.id ?? null
}

/**
 * Withdraw a round that never started. The cancel trigger restores the
 * checkpoint it was reserved against; the revision bump makes any check still
 * in flight discard its now-stale view.
 */
export function withdrawQueuedRound(row: WorkflowRow): boolean {
  const messageId = queuedRound(row.id)
  if (!messageId) return false
  cancelWorkflowMessages(row.id)
  db.run("UPDATE workflows SET revision = revision + 1 WHERE id = ?", [row.id])
  emit({ type: "message", taskId: row.task_id, messageId })
  return true
}

/**
 * Reserve one auto-fix round: the message the agent will receive, its
 * evidence key (so the same evidence is never sent twice), and the checkpoint
 * it advances — one transaction, like a workflow wake.
 */
export function reserveRound(row: WorkflowRow, round: {
  key: string; prompt: string; reason: string; checkpoint: AutopilotCheckpoint
  /** the task's turn count when the look began: a turn since then makes its evidence stale */
  turnCount: number
}, now: Date): string | null {
  const messageId = db.transaction(() => {
    const current = getWorkflow(row.id), task = getTask(row.task_id)
    if (!current || current.state !== "active" || current.revision !== row.revision || !task || seenWake(row.id, round.key)) return null
    // Evidence was gathered with awaits in between: a turn (even one that has
    // already finished), a queued message, or a Stop since then wins, and the
    // next look plans again.
    if (!taskIsIdle(task) || task.turn_count !== round.turnCount) return null
    const id = randomId("m", 12)
    createTaskMessage({ id, taskId: task.id, text: round.prompt, attachmentHash: "" }, false)
    db.run("UPDATE task_messages SET workflow_id = ? WHERE id = ?", [row.id, id])
    db.run(`INSERT INTO workflow_wakes(workflow_id, event_key, message_id, prior_checkpoint_json) VALUES (?, ?, ?, ?)
      ON CONFLICT(workflow_id, event_key) DO UPDATE SET message_id = excluded.message_id, prior_checkpoint_json = excluded.prior_checkpoint_json`,
    [row.id, round.key, id, current.checkpoint_json])
    const at = now.toISOString()
    db.run(`UPDATE workflows SET checkpoint_json = ?, reason = ?, wake_count = wake_count + 1, revision = revision + 1,
      last_checked_at = ?, updated_at = ? WHERE id = ?`,
    [JSON.stringify({ ...round.checkpoint, state: "waiting", about: "pr", by: "auto-fix" }), round.reason, at, at, row.id])
    recordWorkflow(row.id, "wake", round.reason, at, id)
    return id
  })()
  if (messageId) {
    emit({ type: "message", taskId: row.task_id, messageId })
    announceWorkflow(row.task_id)
  }
  return messageId
}

/** A round's evidence, skipped: its CI part is never sent, and its review items count as seen. */
function handled(checkpoint: AutopilotCheckpoint, key: string): void {
  const parts = keyParts(key)
  if (parts.ci) checkpoint.skipped = [...(checkpoint.skipped ?? []).slice(-20), parts.ci]
  checkpoint.delivered = withDelivered(checkpoint.delivered, parts.delivered)
}

/** Turns of a task that were never asked to sign their GitHub posts: before auto-fix was armed, or listed. */
export function unmarkedTurns(taskId: string, before: string, listed: number[]): { started_at: string; ended_at: string | null }[] {
  const numbers = listed.filter(Number.isInteger)
  return db.query(`SELECT started_at, ended_at FROM turns WHERE task_id = ? AND (started_at < ?${numbers.length > 0 ? ` OR n IN (${numbers.join(", ")})` : ""})`)
    .all(taskId, before) as { started_at: string; ended_at: string | null }[]
}

/**
 * A turn started without the note that asks the agent to sign its GitHub
 * posts (a slash command carries no notes): its posts from the owner's
 * account are the agent's, so remember which turn it was.
 */
export function noteUnmarkedTurn(taskId: string, turn: number): void {
  const row = autopilotRow(taskId)
  if (!row || !paramsOf(row).autoFix) return
  const checkpoint = checkpointOf(row)
  checkpoint.unmarkedTurns = [...(checkpoint.unmarkedTurns ?? []).filter((n) => n !== turn).slice(-50), turn]
  db.run("UPDATE workflows SET checkpoint_json = ?, revision = revision + 1 WHERE id = ?", [JSON.stringify(checkpoint), row.id])
}

/** Send now: skip the short delay before a pending round. */
export function sendPendingFix(taskId: string, now = new Date()): AutopilotStatus {
  return touchPending(taskId, now, (checkpoint) => { checkpoint.sendNow = checkpoint.pending!.key })
}

/** Skip: never send this evidence. A later head brings new evidence, and a round again. */
export function skipPendingFix(taskId: string, now = new Date()): AutopilotStatus {
  return touchPending(taskId, now, (checkpoint) => {
    handled(checkpoint, checkpoint.pending!.key)
    delete checkpoint.pending
    delete checkpoint.sendNow
  })
}

function touchPending(taskId: string, now: Date, change: (checkpoint: AutopilotCheckpoint) => void): AutopilotStatus {
  const row = autopilotRow(taskId)
  if (!row || row.state !== "active") throw new AutopilotError("Auto-fix is not on for this task", 409)
  const checkpoint = checkpointOf(row)
  if (!checkpoint.pending) throw new AutopilotError("No auto-fix round is waiting to be sent", 409)
  change(checkpoint)
  db.run("UPDATE workflows SET checkpoint_json = ?, revision = revision + 1, next_check_at = ?, updated_at = ? WHERE id = ?",
    [JSON.stringify(checkpoint), now.toISOString(), now.toISOString(), row.id])
  announceWorkflow(taskId)
  return autopilotStatus(taskId)
}

/** A person cancelled a queued round from the message list: that means Skip, not a pause. */
export function skipCancelledRound(workflowId: string, messageId: string): boolean {
  const row = getWorkflow(workflowId)
  if (!row || row.type !== AUTOPILOT_TYPE) return false
  const wake = db.query("SELECT event_key FROM workflow_wakes WHERE workflow_id = ? AND message_id = ?").get(workflowId, messageId) as { event_key: string } | null
  const current = getWorkflow(workflowId)!
  const checkpoint = checkpointOf(current)
  if (wake) handled(checkpoint, wake.event_key)
  // the cancel restored the countdown this round came from: it is answered
  delete checkpoint.pending
  delete checkpoint.sendNow
  db.run("UPDATE workflows SET checkpoint_json = ?, revision = revision + 1 WHERE id = ?", [JSON.stringify(checkpoint), workflowId])
  recordWorkflow(workflowId, "skipped", "A queued auto-fix round was cancelled", new Date().toISOString())
  announceWorkflow(row.task_id)
  return true
}
