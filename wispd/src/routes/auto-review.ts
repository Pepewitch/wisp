/**
 * GET  /api/tasks/:id/auto-review                 the task's auto-review rounds, newest first
 * POST /api/tasks/:reviewer/auto-review/verdict   a reviewer's verdict (`wisp review submit`)
 *
 * GET  /api/projects/verification?path=           where the project's verification stands
 * POST /api/projects/verification/tasks           start a recipe task: { path, mode, area?, note?, harness?, model?, effort? }
 * POST /api/projects/verification/activate        make the newest draft the active recipe: { path }
 * GET  /api/projects/verification/files?path=[&file=][&draft=<task>]
 *                                                 one recipe file, or the list (active, or a task's draft)
 * GET  /api/projects/verification/checkout?path=[&draft=<task>]
 *                                                 every file, for `wisp verify checkout`
 * POST /api/projects/verification/draft           a recipe task saves its proposal: { task, files }
 */
import { existsSync, statSync } from "node:fs"
import { isAbsolute, resolve } from "node:path"
import type { AutoReviewRoundsResponse, AutoReviewVerdictBody, VerificationTaskBody } from "../../../shared/api/auto-review"
import type { AdapterDef } from "../adapters"
import { autopilotRow, checkAutopilotSoon } from "../autopilot/store"
import type { WispConfig } from "../config"
import { createAndLaunchTask } from "../domain/task-create"
import { emit } from "../events"
import type { ModelProbeCache } from "../model-probes"
import { getTask, listTasks } from "../store"
import { requestActor, TASK_HEADER } from "../task-audit"
import { announceWorkflow, recordWorkflow } from "../workflows/store"
import { projectName } from "../verify/project"
import { activateDraft, readRecipeFile, recipeFiles, RecipeError, saveDraft, type RecipeFile } from "../verify/recipe"
import { startRecipeTask, submitVerdict, VerdictError, verdictError } from "../verify/reviewer"
import { recipeComplaints, roundsOf, roundView } from "../verify/rounds"
import { busyVerifyTask, draftTaskExists, verificationStatus, verifyTaskOf } from "../verify/status"
import { err, json, jsonObjectBody } from "./http"

export const AUTO_REVIEW_PATH = /^\/api\/tasks\/([a-z0-9]+)\/auto-review(?:\/(verdict))?$/

const VERDICT_WORDS: Record<string, string> = {
  pass: "passed", fail: "rejected", inconclusive: "could not verify", recipe: "could not follow the recipe",
}

export async function autoReviewRoute(req: Request, path: string): Promise<Response> {
  const match = path.match(AUTO_REVIEW_PATH)!
  const taskId = match[1]!
  if (!getTask(taskId)) return err("Task not found", 404)
  if (!match[2]) {
    if (req.method !== "GET") return err("Method not allowed", 405)
    return json<AutoReviewRoundsResponse>({ rounds: roundsOf(taskId).map(roundView) })
  }
  if (req.method !== "POST") return err("Method not allowed", 405)
  const body = await jsonObjectBody(req)
  if (body instanceof Response) return body
  const invalid = verdictError(body)
  if (invalid) return err(invalid, 400)
  try {
    const round = submitVerdict(taskId, body as unknown as AutoReviewVerdictBody)
    const at = round.finished_at ?? new Date().toISOString()
    recordWorkflow(round.workflow_id, "review", `Round ${round.round}: the reviewer ${VERDICT_WORDS[round.state] ?? round.state} — ${round.summary ?? ""}`, at, null, { pr: round.pr, sha: round.head })
    announceWorkflow(round.task_id)
    checkAutopilotSoon(round.task_id)
    // a recipe complaint changes the project's verification state
    if (round.state === "recipe") {
      const author = getTask(round.task_id)
      if (author) emit({ type: "project", action: "update", path: resolve(author.repo_path) })
    }
    return json(roundView(round))
  } catch (error) {
    if (error instanceof VerdictError) return err(error.message, error.status)
    throw error
  }
}

/** A project path from a query or a body: absolute, and an existing directory. */
function projectPath(raw: unknown): string | Response {
  if (typeof raw !== "string" || raw === "") return err("path is required", 400)
  if (!isAbsolute(raw)) return err(`path must be absolute: ${raw}`, 400)
  try {
    if (!statSync(raw).isDirectory()) return err(`path is not a directory: ${raw}`, 400)
  } catch {
    return err(`path does not exist: ${raw}`, 400)
  }
  return resolve(raw)
}

const MODES = new Set(["setup", "improve", "fix"])

function taskBodyError(body: Record<string, unknown>): string | null {
  for (const key of Object.keys(body)) if (!["path", "mode", "area", "note", "harness", "model", "effort"].includes(key)) return `unknown field '${key}'`
  if (typeof body.mode !== "string" || !MODES.has(body.mode)) return "mode must be setup, improve or fix"
  for (const key of ["area", "note", "harness", "model", "effort"] as const) {
    if (body[key] !== undefined && typeof body[key] !== "string") return `${key} must be a string`
  }
  if (typeof body.note === "string" && [...body.note].length > 4000) return "note is at most 4000 characters"
  if (typeof body.area === "string" && !/^[a-z0-9][a-z0-9-]{0,39}$/.test(body.area)) return "area is an area's name"
  return null
}

/** The daemon's whole autopilot rows in a project: what an activation may unblock. */
function kickProject(repoPath: string): void {
  for (const task of listTasks()) {
    if (resolve(task.repo_path) !== repoPath || !autopilotRow(task.id)) continue
    checkAutopilotSoon(task.id)
  }
}

function filesOf(raw: unknown): RecipeFile[] | string {
  if (!Array.isArray(raw)) return "files must be a list of { path, content }"
  const files: RecipeFile[] = []
  for (const [index, file] of raw.entries()) {
    if (!file || typeof file !== "object" || Array.isArray(file)) return `files[${index}] must be { path, content }`
    const { path, content } = file as Record<string, unknown>
    if (typeof path !== "string" || typeof content !== "string") return `files[${index}] needs a string path and content`
    files.push({ path, content })
  }
  return files
}

export function verificationRoute(
  req: Request, url: URL, path: string, method: string, cfg: WispConfig, adapters: Record<string, AdapterDef>, models: ModelProbeCache,
): Response | Promise<Response> | null {
  if (!path.startsWith("/api/projects/verification")) return null
  const sub = path.slice("/api/projects/verification".length)
  if (sub === "" && method === "GET") {
    const project = projectPath(url.searchParams.get("path"))
    if (project instanceof Response) return project
    return verificationStatus(project, cfg).then((status) => json(status))
  }
  if (sub === "/files" && method === "GET") return fileRoute(url)
  if (sub === "/checkout" && method === "GET") {
    const project = projectPath(url.searchParams.get("path"))
    if (project instanceof Response) return project
    const draft = draftParam(url)
    if (draft instanceof Response) return draft
    return json({ files: recipeFiles(project, draft) })
  }
  if (method !== "POST") return err("Method not allowed", 405)
  if (sub === "/tasks") return recipeTaskRoute(req, cfg, adapters, models)
  if (sub === "/activate") return activateRoute(req)
  if (sub === "/draft") return draftRoute(req)
  return err("not found", 404)
}

const DRAFT_ID = /^[a-z0-9]{1,40}$/

/** The `draft` query: a recipe task's id, or absent for the active recipe. */
function draftParam(url: URL): string | undefined | Response {
  const draft = url.searchParams.get("draft")
  if (draft === null || draft === "") return undefined
  return DRAFT_ID.test(draft) ? draft : err("draft must be a recipe task's id", 400)
}

function fileRoute(url: URL): Response {
  const project = projectPath(url.searchParams.get("path"))
  if (project instanceof Response) return project
  const draft = draftParam(url)
  if (draft instanceof Response) return draft
  const file = url.searchParams.get("file")
  if (!file) return json({ files: recipeFiles(project, draft).map((entry) => entry.path) })
  const content = readRecipeFile(project, file, draft)
  return content === null ? err(`no such recipe file: ${file}`, 404) : json({ path: file, content })
}

async function recipeTaskRoute(req: Request, cfg: WispConfig, adapters: Record<string, AdapterDef>, models: ModelProbeCache): Promise<Response> {
  const body = await jsonObjectBody(req)
  if (body instanceof Response) return body
  const project = projectPath(body.path)
  if (project instanceof Response) return project
  const invalid = taskBodyError(body)
  if (invalid) return err(invalid, 400)
  const request = body as unknown as VerificationTaskBody
  // the answer a person expects first; startRecipeTask holds the atomic guarantee for every caller
  const busy = busyVerifyTask(project)
  if (busy) return err(`Task ${busy.id} is already working on this project's verification recipe`, 409)
  const chosen = request.harness ? { harness: request.harness, model: request.model, effort: request.effort } : agentFor(cfg, project)
  if (!chosen) return err("harness is required (or choose the project's verification agent in its settings)", 400)
  if (!adapters[chosen.harness]) return err(`unknown harness '${chosen.harness}'`, 400)
  const complaints = request.mode === "fix" ? recipeComplaints(project, null).filter((c) => !request.area || c.area === request.area).map((c) => c.feedback) : []
  const started = await startRecipeTask({ cfg, adapters, launch: (input) => createAndLaunchTask(input, cfg, adapters, models) }, {
    repoPath: project, projectName: projectName(cfg, project), mode: request.mode, area: request.area ?? null, note: request.note?.trim() || null,
    complaints, agent: chosen, roundId: null, actor: requestActor(req),
  })
  if ("error" in started) return err(started.error, started.status)
  emit({ type: "project", action: "update", path: project })
  return json({ task: { id: started.task.id, title: started.task.title } }, 201)
}

function agentFor(cfg: WispConfig, project: string): { harness: string; model?: string; effort?: string } | null {
  const entry = cfg.repos.find((candidate) => typeof candidate !== "string" && resolve(candidate.path) === project)
  return entry && typeof entry !== "string" && entry.verify ? entry.verify : null
}

async function activateRoute(req: Request): Promise<Response> {
  const body = await jsonObjectBody(req)
  if (body instanceof Response) return body
  const project = projectPath(body.path)
  if (project instanceof Response) return project
  try {
    // the recipe decides what merges: an agent may propose a draft, never activate one
    const actor = requestActor(req)
    if (actor.startsWith("agent:")) return err("A person activates a verification recipe draft; an agent can only propose one", 403)
    const activated = await activateDraft(project, actor, draftTaskExists)
    emit({ type: "project", action: "update", path: project })
    // a PR held on a broken recipe can be reviewed again now
    kickProject(project)
    return json(activated)
  } catch (error) {
    if (error instanceof RecipeError) return err(error.message, error.status)
    throw error
  }
}

async function draftRoute(req: Request): Promise<Response> {
  const body = await jsonObjectBody(req)
  if (body instanceof Response) return body
  for (const key of Object.keys(body)) if (key !== "task" && key !== "files") return err(`unknown field '${key}'`, 400)
  if (typeof body.task !== "string") return err("task is required: only a recipe task saves a draft", 400)
  const task = getTask(body.task)
  const record = task ? verifyTaskOf(task.id) : null
  if (!task || task.verify_role !== "recipe" || !record) return err("Only a verification recipe task can save a draft", 403)
  // and only from that task's own turn: the CLI names the turn's task in a header
  if (req.headers.get(TASK_HEADER)?.trim() !== task.id) return err("A draft is saved from its recipe task's own turn", 403)
  if (task.archived) return err("This recipe task is archived", 409)
  if (!existsSync(record.project_path)) return err(`The project is gone: ${record.project_path}`, 409)
  const files = filesOf(body.files)
  if (typeof files === "string") return err(files, 400)
  try {
    const draft = saveDraft(record.project_path, task.id, files)
    emit({ type: "project", action: "update", path: record.project_path })
    kickProject(record.project_path)
    return json(draft)
  } catch (error) {
    if (error instanceof RecipeError) return err(error.message, error.status)
    throw error
  }
}
