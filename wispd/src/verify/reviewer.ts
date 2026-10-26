/**
 * The tasks Wisp starts for verification, and what comes back from them.
 *
 * A reviewer is an ordinary task in its own worktree at the PR's head, so a
 * person can open it, read what it did, and answer it like any other. What
 * makes it a reviewer is its role, its round, and the token its turns carry:
 * the verdict must show that token. That keeps an author agent from passing
 * its own work by mistake or as a shortcut; it is no boundary against a
 * hostile process running as the same user, which can read Wisp's database.
 */
import type { AutoReviewEvidence, AutoReviewFinding, AutoReviewSignals, AutoReviewVerdictBody } from "../../../shared/api/auto-review"
import type { AdapterDef } from "../adapters"
import type { PrSnapshot } from "../autopilot/github"
import { repoConfigFor, type WispConfig } from "../config"
import { archiveTaskRows } from "../domain/archive"
import type { NewTask, NewTaskInput, NewTaskRefusal } from "../domain/task-create"
import { emit } from "../events"
import { activeLiveInput } from "../live-input"
import { parseOutputManifest } from "../outputs"
import { startNextQueuedMessage } from "../runner"
import { createTaskMessage, getTask, randomId } from "../store"
import { db } from "../store-database"
import type { Task } from "../types"
import { captureAvailable } from "../capture/chrome"
import { capturesOfReview } from "../capture/store"
import { maxTier, numstatOf, signalsOf, tierOf } from "./depth"
import { evidenceShortfall, requiredAreas, waiversError } from "./evidence"
import { recipePrompt, reviewerPrompt, verdictNudge, type RecipePromptInput } from "./prompts"
import {
  activeRecipe, AREA_INDEX, fetchBase, fetchPullHead, matchAreas, readRecipeFile, RECIPE_INDEX, recipeSettings, recipeVersion, reviewRulesSection, type RecipeArea,
} from "./recipe"
import { createPanelRound, endReview, finishReview, getReview, launchedReview, markReviewNudged, reviewOfTask, type PanelAgent, type ReviewRow } from "./reviews"
import { getRound, highestTier, roundsOf, roundView, VERDICT_STATES, type RoundRow } from "./rounds"
import { busyVerifyTask, recordVerifyTask, type VerifyMode } from "./status"
import { resolve } from "node:path"

/** Starts a task the way a person's request would: the same admission, audit and launch. */
export type Launch = (input: NewTaskInput) => Promise<NewTask | NewTaskRefusal>

/** Who runs a verification task: the project's choice, else the author's own agent. */
export function verifyAgent(cfg: WispConfig, adapters: Record<string, AdapterDef>, repoPath: string, fallback: { harness: string; model: string | null; effort: string | null }):
  { harness: string; model?: string; effort?: string } {
  const chosen = repoConfigFor(cfg, repoPath)?.verify
  if (chosen && adapters[chosen.harness]) return { harness: chosen.harness, model: chosen.model, effort: chosen.effort }
  return { harness: fallback.harness, model: fallback.model ?? undefined, effort: fallback.effort ?? undefined }
}

/** The author's goal for the reviewer: what it was asked. */
function authorGoal(author: Task): string {
  const first = db.query("SELECT prompt FROM turns WHERE task_id = ? ORDER BY n LIMIT 1").get(author.id) as { prompt: string } | null
  const asked = (first?.prompt ?? author.title).trim()
  return asked.length > 2000 ? `${asked.slice(0, 2000)}…` : asked
}

export interface ReviewerStart {
  cfg: WispConfig
  adapters: Record<string, AdapterDef>
  launch: Launch
}

/** Who reviews second on a project: its chosen agent, nobody ("off"), or the primary's own agent. */
export function secondAgent(cfg: WispConfig, adapters: Record<string, AdapterDef>, repoPath: string, primary: { harness: string; model?: string; effort?: string }):
  { harness: string; model?: string; effort?: string } | null {
  const chosen = repoConfigFor(cfg, repoPath)?.verifySecond
  if (chosen === "off") return null
  if (chosen && adapters[chosen.harness]) return { harness: chosen.harness, model: chosen.model, effort: chosen.effort }
  return primary
}

/** What a round's diff looks like: the snapshot its tier, its areas and its prompts all read. */
export interface DiffSnapshot {
  changed: string[] | null
  /** changed paths plus where renames came from: what areas are matched against */
  touched: string[] | null
  signals: AutoReviewSignals | null
  matched: RecipeArea[]
  unmapped: string[]
}

/**
 * The snapshot each round was planned from, so its reviewers' prompts read the
 * diff its tier was chosen on without fetching again. After a restart a
 * launch measures afresh.
 */
const roundSnapshots = new Map<string, DiffSnapshot>()
const KEPT_SNAPSHOTS = 32

/** Fetch the PR's head and base, then measure the diff once. */
export async function diffSnapshot(repoPath: string, pr: Pick<PrSnapshot, "number" | "baseRefName" | "head">): Promise<DiffSnapshot> {
  await fetchPullHead(repoPath, pr.number)
  await fetchBase(repoPath, pr.baseRefName)
  const recipe = activeRecipe(repoPath)
  const numstat = await numstatOf(repoPath, pr.baseRefName, pr.head)
  const changed = numstat ? numstat.map((entry) => entry.path) : null
  // a rename belongs to the area it left as well as the one it joined
  const touched = numstat ? numstat.flatMap((entry) => (entry.from ? [entry.from, entry.path] : [entry.path])) : null
  // an unreadable diff matches no areas: the reviewer is told so and reads the diff itself
  const { matched, unmapped } = recipe && touched ? matchAreas(recipe.areas, touched) : { matched: [], unmapped: changed ?? [] }
  const settings = recipeSettings(repoPath)
  const signals = numstat
    ? signalsOf(numstat, {
      areas: matched.length, unmapped: recipe ? unmapped.length : 0, mapped: (recipe?.areas.length ?? 0) > 0, sensitive: settings.sensitive, docs: settings.docs,
    })
    : null
  return { changed, touched, signals, matched, unmapped: recipe ? unmapped : [] }
}

/**
 * Plan a round: measure the diff, choose its tier (never lower than an
 * earlier round's on this PR), and write the round with every review its
 * panel needs, in one transaction. Nothing launches here; the reviews start
 * when slots allow (launchReview), and the panel never shrinks on its own.
 */
export async function planRound(start: ReviewerStart, input: {
  author: Task; workflowId: string; pr: PrSnapshot; round: number; counted: boolean; carried?: ReviewRow[]
}): Promise<RoundRow> {
  const { author, pr } = input
  const snapshot = await diffSnapshot(author.repo_path, pr)
  const tier = maxTier(tierOf(snapshot.signals), highestTier(input.workflowId, pr.number))
  const primary = verifyAgent(start.cfg, start.adapters, author.repo_path, author)
  const second = tier === "light" ? null : secondAgent(start.cfg, start.adapters, author.repo_path, primary)
  const agents: PanelAgent[] = [
    { role: "primary", harness: primary.harness, model: primary.model ?? null, effort: primary.effort ?? null },
    ...(second ? [{ role: "second" as const, harness: second.harness, model: second.model ?? null, effort: second.effort ?? null }] : []),
  ]
  const recipe = activeRecipe(author.repo_path)
  const { round } = createPanelRound({
    taskId: author.id, workflowId: input.workflowId, pr: pr.number, head: pr.head, base: pr.baseRefName, round: input.round, counted: input.counted,
    recipeVersion: recipe ? await recipeVersion(author.repo_path) : null, tier, signals: snapshot.signals, agents, carried: input.carried,
    // an unreadable diff keeps the floor: every area that asks for a capture needs one
    required: !recipe ? [] : snapshot.touched === null
      ? recipe.areas.filter((area) => area.evidence === "screenshot").map((area) => area.name)
      : requiredAreas(snapshot.matched, snapshot.touched, recipeSettings(author.repo_path).docs),
  })
  roundSnapshots.set(round.id, snapshot)
  for (const id of roundSnapshots.keys()) if (roundSnapshots.size > KEPT_SNAPSHOTS) roundSnapshots.delete(id)
  return round
}

/** The author's answer to the last rejection: its newest turn's final words since that round ended. */
function authorRebuttal(author: Task, since: string | null): string | null {
  if (!since) return null
  const turn = db.query("SELECT result FROM turns WHERE task_id = ? AND started_at > ? AND result IS NOT NULL ORDER BY n DESC LIMIT 1").get(author.id, since) as { result: string } | null
  return turn?.result?.trim() || null
}

/**
 * Start one pending review's task. A refusal for capacity leaves it pending
 * (the next look tries again); any other refusal ends it as an error, which
 * needs a person (a harness that no longer exists, say).
 */
export async function launchReview(start: ReviewerStart, input: {
  author: Task; round: RoundRow; review: ReviewRow; pr: PrSnapshot; budget: number
}): Promise<{ launched: true } | { wait: string } | { error: string }> {
  const { author, pr, round, review } = input
  const recipe = activeRecipe(author.repo_path)
  const snapshot = roundSnapshots.get(round.id) ?? await diffSnapshot(author.repo_path, pr)
  const previous = roundsOf(author.id, pr.number).filter((earlier) => earlier.id !== round.id && VERDICT_STATES.includes(earlier.state))
  const rules = [
    reviewRulesSection(recipe ? readRecipeFile(author.repo_path, RECIPE_INDEX) : null),
    ...snapshot.matched.map((area) => {
      const rules = reviewRulesSection(readRecipeFile(author.repo_path, `areas/${area.name}/${AREA_INDEX}`))
      return rules ? `For code in area "${area.name}":\n${rules}` : null
    }),
  ].filter((rule): rule is string => Boolean(rule))
  const prompt = reviewerPrompt({
    role: review.role, tier: round.tier ?? "standard", signals: snapshot.signals, projectRules: rules.length > 0 ? rules.join("\n\n") : null,
    rebuttal: authorRebuttal(author, previous[0]?.finished_at ?? null),
    pr: { number: pr.number, title: author.custom_title ? author.title : `the change from task ${author.id}`, url: pr.url, base: pr.baseRefName, head: pr.head },
    round: round.round, budget: input.budget, counted: round.counted === 1, goal: authorGoal(author), repoPath: author.repo_path,
    changed: snapshot.changed, previous: previous.map((earlier) => roundView(earlier)), authorTaskId: author.id,
    capture: captureAvailable(start.cfg.chromePath), required: parsedList(round.required_json),
    recipe: {
      version: round.recipe_version,
      index: recipe ? readRecipeFile(author.repo_path, RECIPE_INDEX) : null,
      areas: snapshot.matched.map((area) => ({
        area, text: readRecipeFile(author.repo_path, `areas/${area.name}/${AREA_INDEX}`) ?? "",
        files: recipe!.files.filter((file) => file.startsWith(`areas/${area.name}/`)),
      })),
      unmapped: snapshot.unmapped,
    },
  })
  const label = review.role === "primary" ? "A" : "B"
  const created = await start.launch({
    repoPath: author.repo_path,
    prompt: `Auto-review ${label}${review.fallback_json ? " (fallback)" : ""} · PR #${pr.number} · round ${round.round}${round.counted === 1 ? "" : " (re-run)"} · ${pr.head.slice(0, 7)}`,
    firstTurnPrompt: prompt,
    harness: review.harness, model: review.model ?? undefined, effort: review.effort ?? undefined,
    fast: false, mode: "worktree", actor: "autopilot", verifyRole: "reviewer",
    // a review subtask of the author, on the head this round reviews
    subtask: { parentId: author.id, kind: "review" },
    base: { ref: `refs/pull/${pr.number}/head`, commit: pr.head, from: `pr#${pr.number}` },
    prepare: (task) => { launchedReview(review.id, task.id) },
  })
  if (!("kind" in created)) return { launched: true }
  if (created.kind === "at-capacity") return { wait: `Waiting for a free task slot to start reviewer ${label}` }
  endReview(review.id, "error", `could not start: ${created.error}`)
  return { error: `Could not start reviewer ${label}: ${created.error}` }
}

/** Start a recipe task: setting up the recipe, improving it, or fixing one area a reviewer could not follow. */
/** Projects whose recipe task is being created right now: checked and claimed before any await. */
const recipeAdmissions = new Set<string>()

export async function startRecipeTask(start: ReviewerStart, input: {
  repoPath: string; projectName: string; mode: VerifyMode; area: string | null; note: string | null; complaints: string[]
  agent: { harness: string; model?: string; effort?: string }; roundId: string | null; actor: string
}): Promise<{ task: Task } | { error: string; status: number }> {
  // One recipe writer per project, for every caller (the API and autopilot's
  // fix): the check and the claim happen together, before anything awaits.
  const project = resolve(input.repoPath)
  const busy = busyVerifyTask(project)
  if (busy) return { error: `Task ${busy.id} is already working on this project's verification recipe`, status: 409 }
  if (recipeAdmissions.has(project)) return { error: "A recipe task for this project is already being started", status: 409 }
  recipeAdmissions.add(project)
  try {
    return await launchRecipeTask(start, input)
  } finally {
    recipeAdmissions.delete(project)
  }
}

async function launchRecipeTask(start: ReviewerStart, input: Parameters<typeof startRecipeTask>[1]): Promise<{ task: Task } | { error: string; status: number }> {
  const promptInput: RecipePromptInput = {
    mode: input.mode, projectName: input.projectName, repoPath: input.repoPath, area: input.area, note: input.note,
    complaints: input.complaints, hasRecipe: activeRecipe(input.repoPath) !== null, capture: captureAvailable(start.cfg.chromePath),
  }
  const title = input.mode === "setup" ? `Set up verification · ${input.projectName}`
    : input.mode === "improve" ? `Improve verification · ${input.projectName}`
      : `Fix verification${input.area ? ` (${input.area})` : ""} · ${input.projectName}`
  const created = await start.launch({
    repoPath: input.repoPath, prompt: title, firstTurnPrompt: recipePrompt(promptInput),
    harness: input.agent.harness, model: input.agent.model, effort: input.agent.effort,
    fast: false, mode: "worktree", actor: input.actor, verifyRole: "recipe",
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

const VERDICT_FIELDS = new Set(["token", "verdict", "cause", "summary", "findings", "recipeFeedback", "recipeArea", "reviewed", "rationale", "escalate", "waivers"])
const LEGACY_FINDING_FIELDS = new Set(["title", "detail", "file", "line"])
const FINDING_FIELDS = new Set([...LEGACY_FINDING_FIELDS, "severity", "lens"])
const LENSES = new Set(["correctness", "architecture", "slop", "security", "performance", "tests", "docs", "verification"])
/** Lenses whose blocker must point at code: a file, and a line where it can. */
const CODE_LENSES = new Set(["correctness", "architecture", "slop", "security", "performance"])
const text = (value: unknown, max: number): boolean => typeof value === "string" && codePoints(value) <= max

/** Who is submitting: the protocol its prompt taught it (1 before the panel), and its role. */
export interface VerdictContext {
  protocol: number
  role: "primary" | "second"
}

/** Every problem with a verdict, or null. */
export function verdictError(body: Record<string, unknown>, context: VerdictContext = { protocol: 2, role: "primary" }): string | null {
  const unknown = Object.keys(body).find((key) => !VERDICT_FIELDS.has(key))
  if (unknown) return `unknown field '${unknown}'`
  if (typeof body.token !== "string" || body.token === "") return "token is required (WISP_REVIEW_TOKEN, set only in a reviewer's turns)"
  return verdictShapeError(body, context) ?? findingsError(body.findings, body.verdict, context) ?? recipeFieldsError(body) ?? panelFieldsError(body, context)
    ?? waiverFieldError(body.waivers, context)
}

function verdictShapeError(body: Record<string, unknown>, context: VerdictContext): string | null {
  if (body.verdict !== "pass" && body.verdict !== "fail" && body.verdict !== "inconclusive") return "verdict must be pass, fail or inconclusive"
  if (body.verdict === "inconclusive" && body.cause !== "change" && body.cause !== "recipe") return "an inconclusive verdict needs cause: change or recipe"
  if (body.verdict !== "inconclusive" && body.cause !== undefined) return "cause belongs to an inconclusive verdict only"
  if (body.cause === "recipe" && context.role === "second") return "cause recipe is the verifying reviewer's: reviewer B does not run the recipe"
  if (typeof body.summary !== "string" || body.summary.trim() === "") return "summary is required"
  if (!text(body.summary, 600)) return "summary is at most 600 characters"
  return null
}

function findingsError(findings: unknown, verdict: unknown, context: VerdictContext): string | null {
  if (findings === undefined) return verdict === "fail" ? "a fail verdict lists at least one finding" : null
  if (!Array.isArray(findings)) return "findings must be a list"
  if (findings.length > 20) return "at most 20 findings"
  if (verdict === "fail" && findings.length === 0) return "a fail verdict lists at least one finding"
  for (const [index, finding] of findings.entries()) {
    const invalid = findingError(finding, context)
    if (invalid) return `findings[${index}]${invalid}`
  }
  if (context.protocol < 2) return null
  const blocking = (findings as { severity?: string }[]).filter((finding) => finding.severity === "blocking").length
  if (verdict === "fail" && blocking === 0) return "a fail verdict needs at least one blocking finding (notes alone do not stop a merge)"
  if (verdict === "pass" && blocking > 0) return "a pass carries no blocking finding: fail instead, or make it a note"
  return null
}

/** Waivers belong to the verifying reviewer of a review that knows them (protocol 3). */
function waiverFieldError(raw: unknown, context: VerdictContext): string | null {
  if (raw === undefined) return null
  if (context.protocol < 3) return "waivers are not part of this review's verdict"
  if (context.role === "second") return "waivers are the verifying reviewer's: reviewer B does not capture"
  return waiversError(raw)
}

/** A JSON list of strings, or empty. */
function parsedList(json: string | null | undefined): string[] {
  try {
    const value: unknown = JSON.parse(json ?? "[]")
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []
  } catch {
    return []
  }
}

function findingError(finding: unknown, context: VerdictContext): string | null {
  if (!finding || typeof finding !== "object" || Array.isArray(finding)) return " must be an object"
  const f = finding as Record<string, unknown>
  const allowed = context.protocol < 2 ? LEGACY_FINDING_FIELDS : FINDING_FIELDS
  const unknown = Object.keys(f).find((key) => !allowed.has(key))
  if (unknown) return `: unknown field '${unknown}'`
  if (!text(f.title, 200) || (f.title as string).trim() === "") return ".title is required, at most 200 characters"
  if (f.detail !== undefined && !text(f.detail, 2000)) return ".detail is text, at most 2000 characters"
  if (f.file !== undefined && !text(f.file, 300)) return ".file is a path, at most 300 characters"
  if (f.line !== undefined && (!Number.isSafeInteger(f.line) || (f.line as number) < 1)) return ".line is a positive whole number"
  if (context.protocol < 2) return null
  if (f.severity !== "blocking" && f.severity !== "note") return ".severity is blocking or note"
  if (typeof f.lens !== "string" || !LENSES.has(f.lens)) return `.lens is one of ${[...LENSES].join(", ")}`
  if (f.lens === "verification" && context.role === "second") return ".lens verification is the verifying reviewer's"
  if (f.severity === "blocking") {
    if (typeof f.detail !== "string" || f.detail.trim() === "") return ": a blocking finding needs detail — what goes wrong, and how it is reached"
    if (CODE_LENSES.has(f.lens) && (typeof f.file !== "string" || f.file.trim() === "")) return ": a blocking finding on code names its file"
  }
  return null
}

function recipeFieldsError(body: Record<string, unknown>): string | null {
  if (body.recipeFeedback !== undefined && !text(body.recipeFeedback, 4000)) return "recipeFeedback is text, at most 4000 characters"
  if (body.cause === "recipe" && (typeof body.recipeFeedback !== "string" || body.recipeFeedback.trim() === "")) return "cause recipe needs recipeFeedback: what in the recipe failed"
  if (body.recipeArea !== undefined && (typeof body.recipeArea !== "string" || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(body.recipeArea))) return "recipeArea is an area's name"
  return null
}

function panelFieldsError(body: Record<string, unknown>, context: VerdictContext): string | null {
  if (body.reviewed !== undefined) {
    if (!Array.isArray(body.reviewed) || body.reviewed.length > 30 || body.reviewed.some((item) => !text(item, 200))) return "reviewed is a list of at most 30 items, each at most 200 characters"
  }
  if (body.rationale !== undefined && !text(body.rationale, 2000)) return "rationale is text, at most 2000 characters"
  if (body.escalate !== undefined) {
    if (context.role !== "primary") return "escalate is the primary reviewer's"
    const escalate = body.escalate as Record<string, unknown> | null
    if (!escalate || typeof escalate !== "object" || Array.isArray(escalate) || !text(escalate.reason, 400) || (escalate.reason as string).trim() === "") {
      return "escalate is { reason }: why a second reviewer should look, at most 400 characters"
    }
  }
  return null
}

export class VerdictError extends Error {
  constructor(message: string, readonly status: number) { super(message) }
}

/** The review a reviewer task submits for, and how it must answer. */
export function verdictContextOf(reviewerTaskId: string): VerdictContext | null {
  const review = reviewOfTask(reviewerTaskId)
  return review ? { protocol: review.protocol, role: review.role } : null
}

/**
 * Record a reviewer's verdict. Only that review's own reviewer, with its
 * token, while its review is open, can; its token dies with the verdict.
 */
export function submitVerdict(reviewerTaskId: string, body: AutoReviewVerdictBody, now = new Date()): { round: RoundRow; review: ReviewRow } {
  const reviewer = getTask(reviewerTaskId)
  if (!reviewer || reviewer.verify_role !== "reviewer") throw new VerdictError("This task is not an auto-review reviewer", 409)
  const review = reviewOfTask(reviewerTaskId)
  if (!review) throw new VerdictError("This reviewer has no review", 409)
  if (review.state !== "running") throw new VerdictError(`This review already ended (${review.state})`, 409)
  if (body.token !== review.token) throw new VerdictError("The token does not match this review", 403)
  const state = body.verdict === "inconclusive" ? (body.cause === "recipe" ? "recipe" : "inconclusive") : body.verdict
  const findings: AutoReviewFinding[] = (body.findings ?? []).map((finding) => ({
    title: finding.title.trim(), ...(finding.detail ? { detail: finding.detail } : {}), ...(finding.file ? { file: finding.file } : {}),
    ...(finding.line ? { line: finding.line } : {}), ...(finding.severity ? { severity: finding.severity } : {}), ...(finding.lens ? { lens: finding.lens } : {}),
  }))
  const evidence = reviewerEvidence(reviewerTaskId).map((image) => ({ ...image, reviewerTaskId }))
  const waivers = (body.waivers ?? []).map((waiver) => ({ area: waiver.area, reason: waiver.reason.trim() }))
  if (state === "pass" && review.role === "primary" && review.protocol >= 3) {
    // a fallback's pass stands on its own captures, never on the failed reviewer's
    const captures = capturesOfReview(review.id).filter((capture) => capture.task_id === reviewerTaskId)
    const short = evidenceShortfall({ required: parsedList(getRound(review.round_id)?.required_json), captures, waivers, images: evidence.length })
    if (short) throw new VerdictError(`Not a pass yet: ${short}`, 400)
  }
  const ok = finishReview(review.id, {
    state, cause: body.cause ?? null, summary: body.summary.trim(), rationale: body.rationale?.trim() || null, findings,
    reviewed: body.reviewed?.map((item) => item.trim()).filter(Boolean) ?? [], recipeFeedback: body.recipeFeedback?.trim() || null,
    recipeArea: body.recipeArea ?? null, evidence, escalated: body.escalate?.reason.trim() || null, waivers,
  }, now)
  if (!ok) throw new VerdictError("This review already ended", 409)
  return { round: getRound(review.round_id)!, review: getReview(review.id)! }
}

/**
 * Ask a reviewer for its verdict, once: after a turn that ended without one,
 * or as the automatic answer to a question (a reviewer never waits on a
 * person). A second time ends the review as an error instead.
 */
export async function nudgeReviewer(review: ReviewRow, adapters: Record<string, AdapterDef>, cfg: WispConfig, asked: boolean): Promise<boolean> {
  if (!review.reviewer_task_id || review.nudged > 0) return false
  // claimed before the answer is awaited, so a concurrent pass never nudges twice
  markReviewNudged(review.id)
  if (asked && await answerQuestion(review.reviewer_task_id)) return true
  // no live question channel (or it refused): a message, which the next turn reads
  const id = randomId("m", 12)
  const round = getRound(review.round_id)
  createTaskMessage({
    id, taskId: review.reviewer_task_id, text: verdictNudge(asked), attachmentHash: "", origin: "workflow",
    source: { by: "autopilot", kind: "review-nudge", pr: round?.pr ?? null, round: round?.round ?? null, rounds: null },
  }, false)
  emit({ type: "message", taskId: review.reviewer_task_id, messageId: id })
  startNextQueuedMessage(review.reviewer_task_id, adapters, cfg, id)
  return true
}

/** Answer the questionnaire a reviewer's turn is blocked on, in its harness's protocol, so the turn resumes. */
async function answerQuestion(taskId: string): Promise<boolean> {
  const live = activeLiveInput(taskId)
  const pending = live?.answer ? live.question?.() : null
  if (!live?.answer || !pending) return false
  try {
    await live.answer(pending.id, pending.questions.map((question) => ({ index: question.index, answer: verdictNudge(true) })))
    return true
  } catch {
    return false
  }
}

/** How long a reviewer that has given its verdict may keep its turn going before it is stopped. */
export const RETIRE_GRACE_MS = 5 * 60_000

/**
 * A reviewer whose review has ended goes away once its turn is over (at once
 * when it was superseded or ended in error, and at most RETIRE_GRACE_MS after
 * its verdict, so a turn that never ends cannot hold a slot): archived, its
 * transcript still readable under archived tasks, its worktree removed.
 * Force, because a reviewer's worktree holds nothing anyone keeps.
 */
export async function retireReviewer(review: ReviewRow, cfg: WispConfig, now = new Date()): Promise<boolean> {
  if (review.carried_from) return false
  const task = review.reviewer_task_id ? getTask(review.reviewer_task_id) : null
  if (!task || task.archived) return false
  const busy = ["creating", "running", "stuck"].includes(task.state)
  const lingering = review.finished_at !== null && now.getTime() - Date.parse(review.finished_at) > RETIRE_GRACE_MS
  if (busy && review.state !== "superseded" && review.state !== "error" && !lingering) return false
  const result = await archiveTaskRows([task], true, cfg, { stopAutopilot: true, actor: "autopilot", reason: `auto-review ${review.role} review ${review.state}` })
  return !("error" in result)
}
