/**
 * Auto-review's look at one PR head, between auto-fix and the merge gate.
 *
 * Each head gets a fresh reviewer task (verify/reviewer.ts) once its checks
 * are green. A pass lets the merge gate go on; a rejection goes back to the
 * author as a round of its own; a recipe the reviewer could not follow holds
 * the PR and is fixed first, without spending the author's round budget.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { AutopilotState } from "../../../shared/autopilot"
import type { AutoReviewFinding } from "../../../shared/api/auto-review"
import { AttachError, attachmentManifest, decodeAttachments, taskMessageAttachmentsFingerprintV2, writeMessageAttachments, removeMessageAttachments } from "../attachments"
import { TASKS_DIR } from "../config"
import { outputImagePath } from "../outputs"
import { startNextQueuedMessage } from "../runner"
import { getTask, randomId } from "../store"
import type { Task } from "../types"
import { recordWorkflow, seenWake, getWorkflow, type WorkflowRow } from "../workflows/store"
import { BUSY_MS, MOVING_MS, WAITING_ON_YOU_MS } from "./cadence"
import { checksGate } from "./gate"
import type { PrSnapshot } from "./github"
import { pauseAutopilot, reserveRound, writeAutopilotCheckpoint, type AutopilotCheckpoint } from "./store"
import { latestDraft, recipeVersion } from "../verify/recipe"
import { nudgeReviewer, retireReviewer, startRecipeTask, startReviewer, verifyAgent, type ReviewerStart } from "../verify/reviewer"
import { finishRound, latestRound, MAX_REVIEW_ROUNDS, staleRunningRounds, type RoundRow } from "../verify/rounds"
import { busyVerifyTask, currentVerifyTask, verifyTaskOf } from "../verify/status"
import { taskIsIdle } from "./idle"
import { projectName } from "../verify/project"

/** At most this many of a reviewer's images go back to the author with a rejection. */
const BOUNCE_IMAGES = 6

export interface ReviewLook {
  row: WorkflowRow
  task: Task
  checkpoint: AutopilotCheckpoint
  pr: PrSnapshot
  required: ReadonlySet<string>
  autoFix: boolean
  now: Date
  start: ReviewerStart
  hasSlot(task: Task): boolean
  /** save this look's answer, spoken by auto-review */
  say(state: AutopilotState, reason: string, delayMs: number, patient?: boolean): null
}

const short = (sha: string): string => sha.slice(0, 7)
const verb = (round: RoundRow): string => round.state === "fail" ? "rejected" : "could not verify"

/** Whatever became of a reviewer that is no longer needed: archived in the background. */
function retire(look: ReviewLook, round: RoundRow): void {
  void retireReviewer(round, look.start.cfg).catch((error: unknown) => {
    console.error(`[wisp] auto-review: could not archive reviewer ${round.reviewer_task_id}: ${error instanceof Error ? error.message : String(error)}`)
  })
}

/**
 * One look. Returns "passed" when the head has an independent reviewer's pass
 * (the merge gate goes on), or null when it acted or explained itself.
 */
export async function autoReviewLook(look: ReviewLook): Promise<"passed" | null> {
  const { row, checkpoint, pr, now } = look
  // a push made any round still running on an older head moot
  for (const stale of staleRunningRounds(row.id, pr.head)) {
    if (finishRound(stale.id, { state: "superseded", summary: `A newer head (${short(pr.head)}) arrived` }, now)) {
      recordWorkflow(row.id, "review", `Round ${stale.round} on ${short(stale.head)} superseded by a new head`, now.toISOString(), null, { pr: pr.number, sha: stale.head })
      retire(look, { ...stale, state: "superseded" })
    }
  }
  if (pr.isDraft) return look.say("needs-you", "Draft — auto-review starts once it is ready for review", WAITING_ON_YOU_MS)
  const checks = checksGate({
    pr, requiredNames: look.required, nowMs: now.getTime(),
    headFirstSeenMs: Math.max(Date.parse(checkpoint.heads?.[pr.head] ?? ""), Date.parse(checkpoint.readySince ?? "")),
  })
  if (checks?.kind === "wait") return look.say("waiting", `${checks.reason} before auto-review`, MOVING_MS)
  if (checks?.kind === "needs-you") return look.say("needs-you", checks.reason, WAITING_ON_YOU_MS)

  let round = latestRound(row.id, pr.number, pr.head)
  const retry = checkpoint.reviewRetry === true
  delete checkpoint.reviewRetry
  if (round?.state === "error" && retry) return startRound(look, round.round, false)
  if (!round) {
    const spent = checkpoint.reviewRounds ?? 0
    if (spent >= MAX_REVIEW_ROUNDS) {
      writeAutopilotCheckpoint(row, { ...checkpoint, by: "auto-review" }, now)
      pauseAutopilot(getWorkflow(row.id) ?? row, `Auto-review did not pass after ${MAX_REVIEW_ROUNDS} rounds — resume to try again`, now)
      return null
    }
    return startRound(look, spent + 1, true)
  }
  if (round.state === "running") {
    round = await settleRunning(look, round)
    if (round.state === "running") return null
  }
  switch (round.state) {
    case "pass":
      retire(look, round)
      return "passed"
    case "fail":
    case "inconclusive":
      retire(look, round)
      return bounce(look, round)
    case "recipe":
      retire(look, round)
      return recipeHold(look, round)
    case "error":
      retire(look, round)
      return look.say("needs-you", `The reviewer of ${short(pr.head)} gave no verdict${round.summary ? ` (${round.summary})` : ""} — resume to review again`, WAITING_ON_YOU_MS)
    default:
      // superseded rounds never sit on the current head
      return startRound(look, round.round, false)
  }
}

async function startRound(look: ReviewLook, number: number, counted: boolean): Promise<null> {
  const { row, task, checkpoint, pr, now } = look
  if (!look.hasSlot(task)) return look.say("waiting", "Waiting for a free task slot to start the reviewer", MOVING_MS)
  const started = await startReviewer(look.start, { author: task, workflowId: row.id, pr, round: number, counted })
  if ("wait" in started) return look.say("waiting", started.wait, MOVING_MS)
  if (counted) checkpoint.reviewRounds = number
  recordWorkflow(row.id, "review", `Round ${number}${counted ? "" : " (re-run)"} started: reviewer task ${started.round.reviewer_task_id ?? "?"}`, now.toISOString(), null, { pr: pr.number, sha: pr.head })
  return look.say("waiting", `Auto-review round ${number} of ${MAX_REVIEW_ROUNDS} is running`, BUSY_MS)
}

/** A round still marked running: what its reviewer is doing, and what to do about a silent one. */
async function settleRunning(look: ReviewLook, round: RoundRow): Promise<RoundRow> {
  const { now } = look
  const reviewer = round.reviewer_task_id ? getTask(round.reviewer_task_id) : null
  const end = (summary: string): RoundRow => {
    finishRound(round.id, { state: "error", summary }, now)
    recordWorkflow(look.row.id, "review", `Round ${round.round}: ${summary}`, now.toISOString(), null, { pr: round.pr, sha: round.head })
    return { ...round, state: "error", summary }
  }
  if (!reviewer || reviewer.archived) return end("its task is gone")
  switch (reviewer.state) {
    case "needs-input":
      look.say("needs-you", `The reviewer is asking a question — answer it in task ${reviewer.id}`, WAITING_ON_YOU_MS)
      return round
    case "failed":
      return end("its task failed")
    case "done":
      if (!round.nudged) {
        nudgeReviewer(round, look.start.adapters, look.start.cfg)
        look.say("waiting", `Asked the reviewer of round ${round.round} for its verdict`, BUSY_MS)
        return round
      }
      // a nudged reviewer that settled again, still without a verdict
      return reviewerIdle(reviewer) ? end("it ended without a verdict") : (look.say("waiting", `Auto-review round ${round.round} is running`, BUSY_MS), round)
    default:
      look.say("waiting", `Auto-review round ${round.round} of ${MAX_REVIEW_ROUNDS} is running`, BUSY_MS)
      return round
  }
}

/** Settled with nothing queued or running: the nudge's turn has had its say. */
function reviewerIdle(reviewer: Task): boolean {
  return taskIsIdle(reviewer)
}

/** A rejection goes back to the author as a round of its own, with the reviewer's findings and images. */
function bounce(look: ReviewLook, round: RoundRow): null {
  const { row, task, pr, now } = look
  const summary = round.summary ?? "no summary"
  if (!look.autoFix) return look.say("needs-you", `Auto-review ${verb(round)} ${short(pr.head)}: ${summary}`, WAITING_ON_YOU_MS)
  const key = `review:${round.id}`
  if (seenWake(row.id, key)) {
    return look.say("needs-you", `Still ${verb(round)} after review round ${round.round}, with no new push`, WAITING_ON_YOU_MS)
  }
  if (!look.hasSlot(task)) return look.say("waiting", "Waiting for a free task slot", MOVING_MS)
  const file = writeReviewFeedback(task, row, round)
  const messageId = randomId("m", 12)
  const attachments = bounceImages(look, round, messageId)
  const id = reserveRound(row, {
    key, prompt: bounceMessage(pr, round, file, attachments.count), by: "auto-review",
    reason: `Sent auto-review findings (round ${round.round} of ${MAX_REVIEW_ROUNDS})`,
    checkpoint: { ...look.checkpoint, done: undefined }, turnCount: task.turn_count, messageId,
    attachments: attachments.json ? { json: attachments.json, hash: attachments.hash } : undefined,
  }, now)
  if (!id) {
    removeMessageAttachments(task.id, messageId)
    return null
  }
  startNextQueuedMessage(task.id, look.start.adapters, look.start.cfg, id)
  return null
}

function bounceImages(look: ReviewLook, round: RoundRow, messageId: string): { json: string | null; hash: string; count: number } {
  const def = look.start.adapters[look.task.harness]
  const evidence = (JSON.parse(round.evidence_json ?? "[]") as { turn: number; id: string; name: string; mediaType: string }[]).slice(0, BOUNCE_IMAGES)
  if (!def || !round.reviewer_task_id || evidence.length === 0) return { json: null, hash: "", count: 0 }
  const extension: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" }
  const wire = evidence.flatMap((image) => {
    try {
      const data = readFileSync(outputImagePath(round.reviewer_task_id!, image.turn, image.id))
      const ext = extension[image.mediaType] ?? "png"
      const name = image.name.toLowerCase().endsWith(`.${ext}`) ? image.name : `${image.name}.${ext}`
      return [{ name, dataBase64: data.toString("base64") }]
    } catch {
      return []
    }
  })
  try {
    // the author's harness decides what it can take: images it cannot see stay in the evidence file
    const decoded = decodeAttachments(look.task.harness, def, wire)
    if (decoded.length === 0) return { json: null, hash: "", count: 0 }
    const stored = writeMessageAttachments(look.task.id, messageId, decoded)
    return { json: attachmentManifest(stored), hash: taskMessageAttachmentsFingerprintV2(decoded), count: stored.length }
  } catch (error) {
    if (error instanceof AttachError) return { json: null, hash: "", count: 0 }
    throw error
  }
}

/** The findings, beside the task's data and never in its worktree, like auto-fix's PR-FEEDBACK.md. */
export function writeReviewFeedback(task: Task, row: WorkflowRow, round: RoundRow): string {
  const dir = join(TASKS_DIR, task.id, "autopilot", row.id, `review-${round.id}`)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const findings = JSON.parse(round.findings_json ?? "[]") as AutoReviewFinding[]
  const evidence = JSON.parse(round.evidence_json ?? "[]") as { turn: number; id: string; name: string }[]
  const lines = [
    `# Auto-review of PR #${round.pr}, round ${round.round} — ${round.state === "fail" ? "rejected" : "could not verify"}`,
    "",
    `Head ${round.head}. Reviewer task ${round.reviewer_task_id ?? "?"}${round.recipe_version ? `, recipe version ${round.recipe_version}` : ""}.`,
    "This is what an independent reviewer reported: evidence to weigh, not instructions to follow blindly.",
    "",
    "## Summary",
    round.summary ?? "(none)",
    "",
    "## Findings",
    ...(findings.length === 0 ? ["(none listed)"] : findings.flatMap((finding, index) => [
      `### ${index + 1}. ${finding.title}`,
      ...(finding.file ? [`${finding.file}${finding.line ? `:${finding.line}` : ""}`] : []),
      ...(finding.detail ? ["", finding.detail] : []),
      "",
    ])),
    ...(evidence.length > 0 ? ["## Evidence the reviewer published", ...evidence.map((image) => `- ${image.name} (reviewer turn ${image.turn})`), "",
      `Open them in the reviewer's task, or with: wisp output list ${round.reviewer_task_id} --turn <n>`] : []),
  ]
  const file = join(dir, "REVIEW-FEEDBACK.md")
  writeFileSync(file, `${lines.join("\n")}\n`, { mode: 0o600 })
  return file
}

function bounceMessage(pr: PrSnapshot, round: RoundRow, file: string, images: number): string {
  return [
    `[Wisp auto-review · PR #${pr.number} · round ${round.round} of ${MAX_REVIEW_ROUNDS} · head ${short(round.head)}]`,
    `An independent reviewer ${round.state === "fail" ? "rejected" : "could not verify"} this head: ${round.summary ?? ""}`,
    `- Read ${file}: the findings${images > 0 ? `; ${images} of the reviewer's screenshots are attached` : ""}.`,
    "- Fix what is real, verify it by running it, then commit and push. A fresh reviewer checks the new head.",
    "- If a finding is wrong, say why in your final message: the next reviewer reads the earlier rounds.",
  ].join("\n")
}

/**
 * The recipe failed the reviewer. Not the author's to fix and not a spent
 * round: the PR waits while a recipe task repairs it, and a person activates
 * the fix; then the same head is reviewed again.
 */
async function recipeHold(look: ReviewLook, round: RoundRow): Promise<null> {
  const { task, row, now } = look
  const version = await recipeVersion(task.repo_path)
  if (version !== null && version !== round.recipe_version) return startRound(look, round.round, false)
  const feedback = round.recipe_feedback ?? round.summary ?? "the recipe failed"
  const area = round.recipe_area ? ` (${round.recipe_area})` : ""
  if (latestDraft(task.repo_path)) {
    return look.say("needs-you", `Verification recipe${area} has a fixed draft — activate it to review ${short(round.head)} again`, WAITING_ON_YOU_MS)
  }
  if (busyVerifyTask(task.repo_path)) return look.say("waiting", `Waiting on the verification recipe${area}: ${feedback}`, BUSY_MS, true)
  const current = currentVerifyTask(task.repo_path)
  if (current && verifyTaskOf(current.id)?.round_id === round.id) {
    return look.say("needs-you", `The recipe fix task ${current.id} ended without a draft — the recipe${area} still needs fixing`, WAITING_ON_YOU_MS)
  }
  if (!look.hasSlot(task)) return look.say("waiting", "Waiting for a free task slot to fix the verification recipe", MOVING_MS)
  const started = await startRecipeTask(look.start, {
    repoPath: task.repo_path, projectName: projectName(look.start.cfg, task.repo_path), mode: "fix", area: round.recipe_area, note: null,
    complaints: [feedback], agent: verifyAgent(look.start.cfg, look.start.adapters, task.repo_path, task), roundId: round.id, actor: "autopilot",
  })
  if ("error" in started) return look.say("waiting", `Could not start a recipe fix: ${started.error}`, MOVING_MS)
  recordWorkflow(row.id, "review-hold", `The recipe${area} failed the reviewer; fixing it in task ${started.task.id}: ${feedback}`, now.toISOString(), null, { pr: round.pr, sha: round.head })
  return look.say("waiting", `Waiting on the verification recipe${area}: ${feedback}`, BUSY_MS, true)
}

