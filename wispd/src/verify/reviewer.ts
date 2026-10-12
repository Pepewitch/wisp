/**
 * The tasks Wisp starts for verification, and what comes back from them.
 *
 * A reviewer is an ordinary task in its own worktree at the PR's head, so a
 * person can open it, read what it did, and answer it like any other. What
 * makes it a reviewer is its role, its round, and the token its turns carry:
 * only a turn of that task can submit the round's verdict.
 */
import { resolve } from "node:path"
import type { AutoReviewEvidence, AutoReviewFinding, AutoReviewVerdictBody } from "../../../shared/api/auto-review"
import type { TaskBriefV1 } from "../../../shared/task-brief"
import type { AdapterDef } from "../adapters"
import type { PrSnapshot } from "../autopilot/github"
import { repoConfigFor, type WispConfig } from "../config"
import { archiveTaskRows } from "../domain/archive"
import type { NewTask, NewTaskInput, NewTaskRefusal } from "../domain/task-create"
import { emit } from "../events"
import { parseOutputManifest } from "../outputs"
import { startNextQueuedMessage } from "../runner"
import { createTaskMessage, getTask, randomId } from "../store"
import { db } from "../store-database"
import type { Task } from "../types"
import { authorReviewNote, recipePrompt, reviewerPrompt, verdictNudge, type RecipePromptInput } from "./prompts"
import { activeRecipe, AREA_INDEX, changedFiles, matchAreas, readRecipeFile, RECIPE_INDEX, recipeVersion } from "./recipe"
import {
  createRound, finishRound, getRound, markNudged, roundOfReviewer, roundsOf, roundView, setRoundReviewer, VERDICT_STATES, type RoundRow,
} from "./rounds"
import { recordVerifyTask, type VerifyMode } from "./status"

/** Starts a task the way a person's request would: the same admission, audit and launch. */
export type Launch = (input: NewTaskInput) => Promise<NewTask | NewTaskRefusal>

/** Who runs a verification task: the project's choice, else the author's own agent. */
export function verifyAgent(cfg: WispConfig, adapters: Record<string, AdapterDef>, repoPath: string, fallback: { harness: string; model: string | null; effort: string | null }):
  { harness: string; model?: string; effort?: string } {
  const chosen = repoConfigFor(cfg, repoPath)?.verify
  if (chosen && adapters[chosen.harness]) return { harness: chosen.harness, model: chosen.model, effort: chosen.effort }
  return { harness: fallback.harness, model: fallback.model ?? undefined, effort: fallback.effort ?? undefined }
}

/** The author's goal for the reviewer: what it was asked, and what its agent last reported. */
function authorGoal(author: Task): { title: string; outcome: string | null } {
  const first = db.query("SELECT prompt FROM turns WHERE task_id = ? ORDER BY n LIMIT 1").get(author.id) as { prompt: string } | null
  const asked = (first?.prompt ?? author.title).trim()
  const brief = db.query("SELECT payload_json FROM task_briefs WHERE task_id = ? ORDER BY turn_n DESC LIMIT 1").get(author.id) as { payload_json: string } | null
  return { title: asked.length > 2000 ? `${asked.slice(0, 2000)}…` : asked, outcome: briefOutcome(brief?.payload_json) }
}

function briefOutcome(payload: string | undefined): string | null {
  if (!payload) return null
  try {
    return (JSON.parse(payload) as TaskBriefV1).outcome
  } catch {
    return null
  }
}

export interface ReviewerStart {
  cfg: WispConfig
  adapters: Record<string, AdapterDef>
  launch: Launch
}

/**
 * Start one round: the round row first (its token must exist before the
 * reviewer's first turn), then the reviewer task. A refused start leaves no
 * round behind.
 */
export async function startReviewer(start: ReviewerStart, input: {
  author: Task; workflowId: string; pr: PrSnapshot; round: number; counted: boolean
}): Promise<{ round: RoundRow } | { wait: string }> {
  const { author, pr } = input
  const recipe = activeRecipe(author.repo_path)
  const version = recipe ? await recipeVersion(author.repo_path) : null
  const changed = await changedFiles(author.repo_path, pr.baseRefName, pr.head)
  const { matched, unmapped } = recipe ? matchAreas(recipe.areas, changed) : { matched: [], unmapped: [] }
  const previous = roundsOf(author.id, pr.number).filter((round) => VERDICT_STATES.includes(round.state)).map(roundView)
  const row = createRound({ taskId: author.id, workflowId: input.workflowId, pr: pr.number, head: pr.head, round: input.round, counted: input.counted, recipeVersion: version })
  const prompt = reviewerPrompt({
    pr: { number: pr.number, title: author.custom_title ? author.title : `the change from task ${author.id}`, url: pr.url, base: pr.baseRefName, head: pr.head },
    round: input.round, counted: input.counted, goal: authorGoal(author), repoPath: author.repo_path, changed, previous, authorTaskId: author.id,
    recipe: {
      version,
      index: recipe ? readRecipeFile(author.repo_path, RECIPE_INDEX) : null,
      areas: matched.map((area) => ({
        area, text: readRecipeFile(author.repo_path, `areas/${area.name}/${AREA_INDEX}`) ?? "",
        files: recipe!.files.filter((file) => file.startsWith(`areas/${area.name}/`)),
      })),
      unmapped,
    },
  })
  const agent = verifyAgent(start.cfg, start.adapters, author.repo_path, author)
  const created = await start.launch({
    repoPath: author.repo_path,
    prompt: `Auto-review · PR #${pr.number} · round ${input.round}${input.counted ? "" : " (re-run)"} · ${pr.head.slice(0, 7)}`,
    firstTurnPrompt: prompt,
    harness: agent.harness, model: agent.model, effort: agent.effort,
    fast: false, brief: false, mode: "worktree", base: pr.head, actor: "autopilot", verifyRole: "reviewer",
    prepare: (task) => setRoundReviewer(row.id, task.id),
  })
  if ("kind" in created) {
    db.run("DELETE FROM auto_review_rounds WHERE id = ?", [row.id])
    return { wait: created.kind === "at-capacity" ? "Waiting for a free task slot to start the reviewer" : `Could not start the reviewer: ${created.error}` }
  }
  return { round: getRound(row.id)! }
}

/** Start a recipe task: setting up the recipe, improving it, or fixing one area a reviewer could not follow. */
export async function startRecipeTask(start: ReviewerStart, input: {
  repoPath: string; projectName: string; mode: VerifyMode; area: string | null; note: string | null; complaints: string[]
  agent: { harness: string; model?: string; effort?: string }; roundId: string | null; actor: string
}): Promise<{ task: Task } | { error: string; status: number }> {
  const promptInput: RecipePromptInput = {
    mode: input.mode, projectName: input.projectName, repoPath: input.repoPath, area: input.area, note: input.note,
    complaints: input.complaints, hasRecipe: activeRecipe(input.repoPath) !== null,
  }
  const title = input.mode === "setup" ? `Set up verification · ${input.projectName}`
    : input.mode === "improve" ? `Improve verification · ${input.projectName}`
      : `Fix verification${input.area ? ` (${input.area})` : ""} · ${input.projectName}`
  const created = await start.launch({
    repoPath: input.repoPath, prompt: title, firstTurnPrompt: recipePrompt(promptInput),
    harness: input.agent.harness, model: input.agent.model, effort: input.agent.effort,
    fast: false, brief: false, mode: "worktree", actor: input.actor, verifyRole: "recipe",
    prepare: (task) => recordVerifyTask({ taskId: task.id, projectPath: input.repoPath, mode: input.mode, area: input.area, roundId: input.roundId }),
  })
  if ("kind" in created) {
    const status = created.kind === "at-capacity" ? 429 : created.kind === "invalid" ? 400 : created.kind === "attachment" ? created.status : 409
    return { error: created.error, status }
  }
  return { task: created.task }
}

/** The images a reviewer published, oldest turn first: its evidence. */
export function reviewerEvidence(reviewerTaskId: string): AutoReviewEvidence[] {
  const turns = db.query("SELECT n, outputs_json FROM turns WHERE task_id = ? AND outputs_json IS NOT NULL ORDER BY n").all(reviewerTaskId) as { n: number; outputs_json: string }[]
  return turns.flatMap((turn) => parseOutputManifest(turn.outputs_json).map((image) => ({ turn: turn.n, id: image.id, name: image.name, mediaType: image.mediaType }))).slice(0, 32)
}

const codePoints = (text: string): number => [...text].length

const VERDICT_FIELDS = new Set(["token", "verdict", "cause", "summary", "findings", "recipeFeedback", "recipeArea"])
const FINDING_FIELDS = new Set(["title", "detail", "file", "line"])
const text = (value: unknown, max: number): boolean => typeof value === "string" && codePoints(value) <= max

/** Every problem with a verdict, or null. */
export function verdictError(body: Record<string, unknown>): string | null {
  const unknown = Object.keys(body).find((key) => !VERDICT_FIELDS.has(key))
  if (unknown) return `unknown field '${unknown}'`
  if (typeof body.token !== "string" || body.token === "") return "token is required (WISP_REVIEW_TOKEN, set only in a reviewer's turns)"
  return verdictShapeError(body) ?? findingsError(body.findings, body.verdict) ?? recipeFieldsError(body)
}

function verdictShapeError(body: Record<string, unknown>): string | null {
  if (body.verdict !== "pass" && body.verdict !== "fail" && body.verdict !== "inconclusive") return "verdict must be pass, fail or inconclusive"
  if (body.verdict === "inconclusive" && body.cause !== "change" && body.cause !== "recipe") return "an inconclusive verdict needs cause: change or recipe"
  if (body.verdict !== "inconclusive" && body.cause !== undefined) return "cause belongs to an inconclusive verdict only"
  if (typeof body.summary !== "string" || body.summary.trim() === "") return "summary is required"
  if (!text(body.summary, 600)) return "summary is at most 600 characters"
  return null
}

function findingsError(findings: unknown, verdict: unknown): string | null {
  if (findings === undefined) return verdict === "fail" ? "a fail verdict lists at least one finding" : null
  if (!Array.isArray(findings)) return "findings must be a list"
  if (findings.length > 20) return "at most 20 findings"
  if (verdict === "fail" && findings.length === 0) return "a fail verdict lists at least one finding"
  for (const [index, finding] of findings.entries()) {
    const invalid = findingError(finding)
    if (invalid) return `findings[${index}]${invalid}`
  }
  return null
}

function findingError(finding: unknown): string | null {
  if (!finding || typeof finding !== "object" || Array.isArray(finding)) return " must be an object"
  const f = finding as Record<string, unknown>
  const unknown = Object.keys(f).find((key) => !FINDING_FIELDS.has(key))
  if (unknown) return `: unknown field '${unknown}'`
  if (!text(f.title, 200) || (f.title as string).trim() === "") return ".title is required, at most 200 characters"
  if (f.detail !== undefined && !text(f.detail, 2000)) return ".detail is text, at most 2000 characters"
  if (f.file !== undefined && !text(f.file, 300)) return ".file is a path, at most 300 characters"
  if (f.line !== undefined && (!Number.isSafeInteger(f.line) || (f.line as number) < 1)) return ".line is a positive whole number"
  return null
}

function recipeFieldsError(body: Record<string, unknown>): string | null {
  if (body.recipeFeedback !== undefined && !text(body.recipeFeedback, 4000)) return "recipeFeedback is text, at most 4000 characters"
  if (body.cause === "recipe" && (typeof body.recipeFeedback !== "string" || body.recipeFeedback.trim() === "")) return "cause recipe needs recipeFeedback: what in the recipe failed"
  if (body.recipeArea !== undefined && (typeof body.recipeArea !== "string" || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(body.recipeArea))) return "recipeArea is an area's name"
  return null
}

export class VerdictError extends Error {
  constructor(message: string, readonly status: number) { super(message) }
}

/** Record a reviewer's verdict. Only the round's own reviewer, while the round is open, can. */
export function submitVerdict(reviewerTaskId: string, body: AutoReviewVerdictBody, now = new Date()): RoundRow {
  const reviewer = getTask(reviewerTaskId)
  if (!reviewer || reviewer.verify_role !== "reviewer") throw new VerdictError("This task is not an auto-review reviewer", 409)
  const round = roundOfReviewer(reviewerTaskId)
  if (!round) throw new VerdictError("This reviewer has no round", 409)
  if (round.state !== "running") throw new VerdictError(`This round already ended (${round.state})`, 409)
  if (body.token !== round.token) throw new VerdictError("The token does not match this round", 403)
  const state = body.verdict === "inconclusive" ? (body.cause === "recipe" ? "recipe" : "inconclusive") : body.verdict
  const findings: AutoReviewFinding[] = (body.findings ?? []).map((finding) => ({
    title: finding.title.trim(), ...(finding.detail ? { detail: finding.detail } : {}), ...(finding.file ? { file: finding.file } : {}), ...(finding.line ? { line: finding.line } : {}),
  }))
  const ok = finishRound(round.id, {
    state, cause: body.cause ?? null, summary: body.summary.trim(), findings,
    recipeFeedback: body.recipeFeedback?.trim() || null, recipeArea: body.recipeArea ?? null, evidence: reviewerEvidence(reviewerTaskId),
  }, now)
  if (!ok) throw new VerdictError("This round already ended", 409)
  return getRound(round.id)!
}

/** Ask a reviewer that ended its turn without a verdict for one, once. */
export function nudgeReviewer(round: RoundRow, adapters: Record<string, AdapterDef>, cfg: WispConfig): boolean {
  if (!round.reviewer_task_id || round.nudged) return false
  const id = randomId("m", 12)
  createTaskMessage({ id, taskId: round.reviewer_task_id, text: verdictNudge(), attachmentHash: "", origin: "workflow" }, false)
  markNudged(round.id)
  emit({ type: "message", taskId: round.reviewer_task_id, messageId: id })
  startNextQueuedMessage(round.reviewer_task_id, adapters, cfg, id)
  return true
}

/**
 * A finished reviewer goes away once its turn is over: archived (its
 * transcript stays readable under archived tasks), its worktree removed.
 * Force, because a reviewer's worktree holds nothing anyone keeps.
 */
export async function retireReviewer(round: RoundRow, cfg: WispConfig): Promise<boolean> {
  const task = round.reviewer_task_id ? getTask(round.reviewer_task_id) : null
  if (!task || task.archived) return false
  const busy = ["creating", "running", "stuck"].includes(task.state)
  if (busy && round.state !== "superseded") return false
  const result = await archiveTaskRows([task], true, cfg, { stopAutopilot: true, actor: "autopilot", reason: `auto-review round ${round.round} ${round.state}` })
  return !("error" in result)
}

/** The note an author's turns carry while auto-review is on. */
export function authorNote(author: Task, which: string): string {
  return authorReviewNote({ which, hasRecipe: activeRecipe(author.repo_path) !== null })
}

/** Is this repository path the project the recipe task was started for? */
export const sameProject = (a: string, b: string): boolean => resolve(a) === resolve(b)
