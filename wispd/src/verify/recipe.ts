/**
 * A project's verification recipe: how to build, launch and drive the app,
 * and what evidence proves a change works. Auto-review's reviewer reads it;
 * the author's turns are pointed at it, so both sides work to one bar.
 *
 * It lives in the Wisp home, never in the repository: a repo is shared with
 * people whose workflow it is not Wisp's place to change. Layout, one
 * directory per project under PROJECTS_DIR:
 *
 *   verify/                 the active recipe, a git repository Wisp commits
 *     RECIPE.md             the project: global checks, verdict rules, notes
 *     areas/<name>/AREA.md  one runnable surface; frontmatter names the paths
 *     areas/<name>/…        free-form: features/, helpers/, anything the area needs
 *   drafts/<task>/          a recipe task's proposal, waiting to be activated
 *
 * The shape follows the verification skills in pstack (MIT), with one more
 * layer on top: a monorepo has several surfaces, and a change usually touches
 * one, so a reviewer is handed only the areas the diff touched.
 *
 * Every change to the active recipe is a draft a person activated: the recipe
 * decides what merges, so lowering the bar is never an agent's call alone.
 */
import { createHash } from "node:crypto"
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { basename, join, resolve } from "node:path"
import { PROJECTS_DIR } from "../config"
import { runBounded, READ_TIMEOUT_MS, WRITE_TIMEOUT_MS } from "../subprocess"

export const RECIPE_INDEX = "RECIPE.md"
export const AREA_INDEX = "AREA.md"
/** What a draft may hold: generous for markdown and helper scripts, small for a home directory. */
export const RECIPE_MAX_FILES = 300
export const RECIPE_MAX_BYTES = 4 * 1024 * 1024
export const RECIPE_MAX_FILE_BYTES = 512 * 1024
const AREA_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/
/** A draft is named for the recipe task that saved it: a task id, and nothing that could climb out of drafts/. */
const DRAFT_ID = /^[a-z0-9]{1,40}$/
const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/
const MAX_DEPTH = 8

export interface RecipeFile {
  path: string
  content: string
}

export interface RecipeArea {
  name: string
  /** globs, relative to the repository root, that put a changed file in this area */
  paths: string[]
  /** proven: the recipe task drove it once end to end and saw it work */
  status: "proven" | "unproven"
  /** screenshot: reviewer A's pass on a change here needs a `wisp capture` from its own worktree */
  evidence: "screenshot" | "none"
}

export interface RecipeSnapshot {
  files: string[]
  areas: RecipeArea[]
}

export interface RecipeDraft extends RecipeSnapshot {
  taskId: string
  savedAt: string
}

export class RecipeError extends Error {
  constructor(message: string, readonly status = 400) { super(message) }
}

const slug = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "project"

/** One directory per project, named so a person can find it and two repos with one name never share it. */
export function projectDir(repoPath: string): string {
  const path = resolve(repoPath)
  return join(PROJECTS_DIR, `${slug(basename(path))}-${createHash("sha256").update(path).digest("hex").slice(0, 10)}`)
}

export const recipeDir = (repoPath: string): string => join(projectDir(repoPath), "verify")
const draftsDir = (repoPath: string): string => join(projectDir(repoPath), "drafts")
function draftDir(repoPath: string, taskId: string): string {
  if (!DRAFT_ID.test(taskId)) throw new RecipeError(`not a draft: ${taskId.slice(0, 40)}`, 404)
  return join(draftsDir(repoPath), taskId)
}

/**
 * A recipe-relative path that is safe to write and to show: forward slashes,
 * no `..`, no absolute or hidden segments, not too deep.
 */
export function recipePathError(path: string): string | null {
  if (typeof path !== "string" || path === "") return "a file path is empty"
  const segments = path.split("/")
  if (segments.length > MAX_DEPTH) return `${path}: nested more than ${MAX_DEPTH} levels`
  for (const segment of segments) {
    if (!SEGMENT.test(segment)) return `${path}: each part must be letters, digits, '.', '_' or '-', and not start with '.'`
  }
  return null
}

/** The frontmatter of an AREA.md: `paths:` (a comma list, or `- glob` lines), `status:` and `evidence:`. */
export function parseAreaFrontmatter(text: string): Omit<RecipeArea, "name"> | string {
  const lines = text.replace(/\r\n/g, "\n").split("\n")
  if (lines[0]?.trim() !== "---") return "starts with no frontmatter (a '---' line, then 'paths: …')"
  const end = lines.indexOf("---", 1)
  const closing = end > 0 ? end : lines.findIndex((line, index) => index > 0 && line.trim() === "---")
  if (closing < 0) return "has frontmatter with no closing '---' line"
  const paths: string[] = []
  let status: "proven" | "unproven" = "unproven"
  let evidence: string = "none"
  let listing = false
  for (const raw of lines.slice(1, closing)) {
    const line = raw.trimEnd()
    const item = line.match(/^\s*-\s+(.+)$/)
    if (listing && item) { paths.push(unquote(item[1]!)); continue }
    listing = false
    const pair = line.match(/^([A-Za-z]+):\s*(.*)$/)
    if (!pair) continue
    const [, key, value] = pair
    if (key === "paths") {
      if (value!.trim() === "") listing = true
      else paths.push(...value!.replace(/^\[|\]$/g, "").split(",").map(unquote).filter(Boolean))
    } else if (key === "status") {
      status = unquote(value!) === "proven" ? "proven" : "unproven"
    } else if (key === "evidence") {
      evidence = unquote(value!)
    }
  }
  // a typo must not switch the rule off in silence
  if (evidence !== "screenshot" && evidence !== "none") return `has 'evidence: ${evidence}': it is 'screenshot' or 'none'`
  const globs = paths.map((glob) => glob.trim()).filter(Boolean)
  if (globs.length === 0) return "names no paths (frontmatter 'paths: apps/web/**' says which changes belong to the area)"
  const bad = globs.find((glob) => glob.startsWith("/") || glob.split("/").includes(".."))
  if (bad) return `has a path outside the repository: ${bad}`
  return { paths: globs, status, evidence }
}

const unquote = (value: string): string => value.trim().replace(/^["']|["']$/g, "").trim()

/** A glob list from frontmatter, or the reason it cannot be used. */
function globList(lines: string[], key: string): string[] | string {
  const out: string[] = []
  let listing = false
  for (const raw of lines) {
    const line = raw.trimEnd()
    const item = line.match(/^\s*-\s+(.+)$/)
    if (listing && item) { out.push(unquote(item[1]!)); continue }
    listing = false
    const pair = line.match(/^([A-Za-z]+):\s*(.*)$/)
    if (!pair || pair[1] !== key) continue
    if (pair[2]!.trim() === "") listing = true
    else out.push(...pair[2]!.replace(/^\[|\]$/g, "").split(",").map(unquote).filter(Boolean))
  }
  const bad = out.find((glob) => glob.startsWith("/") || glob.split("/").includes(".."))
  return bad ? `${key}: ${bad} is outside the repository` : out
}

export interface RecipeSettings {
  /** globs whose changes always get a deep review */
  sensitive: string[]
  /** globs that count as documentation (a docs-only change is light) */
  docs: string[]
}

/** RECIPE.md's optional frontmatter: `sensitive:` and `docs:` glob lists. */
export function parseRecipeFrontmatter(text: string): RecipeSettings | string {
  const lines = text.replace(/\r\n/g, "\n").split("\n")
  if (lines[0]?.trim() !== "---") return { sensitive: [], docs: [] }
  const closing = lines.findIndex((line, index) => index > 0 && line.trim() === "---")
  if (closing < 0) return "has frontmatter with no closing '---' line"
  const body = lines.slice(1, closing)
  const sensitive = globList(body, "sensitive")
  if (typeof sensitive === "string") return sensitive
  const docs = globList(body, "docs")
  if (typeof docs === "string") return docs
  return { sensitive, docs }
}

/** The project's settings from the active recipe; none when it has no recipe or they cannot be read. */
export function recipeSettings(repoPath: string): RecipeSettings {
  const index = readRecipeFile(repoPath, RECIPE_INDEX)
  const parsed = index ? parseRecipeFrontmatter(index) : null
  return parsed && typeof parsed !== "string" ? parsed : { sensitive: [], docs: [] }
}

/** How large a `## Review rules` section may be: the rules ride in every reviewer's prompt. */
export const REVIEW_RULES_MAX_BYTES = 8 * 1024

/** A `## Review rules` section (the first one, to the next `## ` heading), or null. */
export function reviewRulesSection(text: string | null): string | null {
  if (!text) return null
  const lines = text.replace(/\r\n/g, "\n").split("\n")
  const start = lines.findIndex((line) => /^##\s+review rules\s*$/i.test(line.trim()))
  if (start < 0) return null
  const end = lines.findIndex((line, index) => index > start && /^##\s/.test(line))
  const body = lines.slice(start + 1, end < 0 ? undefined : end).join("\n").trim()
  return body === "" ? null : body
}

/** The text with its `## Review rules` section taken out (it is given to reviewers once, on its own). */
export function withoutReviewRules(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n")
  const start = lines.findIndex((line) => /^##\s+review rules\s*$/i.test(line.trim()))
  if (start < 0) return text
  const end = lines.findIndex((line, index) => index > start && /^##\s/.test(line))
  return [...lines.slice(0, start), ...(end < 0 ? [] : lines.slice(end))].join("\n").trimEnd()
}

/** Every problem with a set of files, or null when they make a recipe. */
export function recipeFilesError(files: RecipeFile[]): string | null {
  if (!Array.isArray(files) || files.length === 0) return "a recipe needs at least RECIPE.md"
  if (files.length > RECIPE_MAX_FILES) return `a recipe holds at most ${RECIPE_MAX_FILES} files, got ${files.length}`
  const seen = new Set<string>()
  let total = 0
  for (const file of files) {
    const invalid = recipePathError(file.path)
    if (invalid) return invalid
    if (seen.has(file.path)) return `${file.path} appears twice`
    seen.add(file.path)
    if (typeof file.content !== "string") return `${file.path}: content must be text`
    const bytes = Buffer.byteLength(file.content)
    if (bytes > RECIPE_MAX_FILE_BYTES) return `${file.path}: larger than ${RECIPE_MAX_FILE_BYTES / 1024} KiB`
    if (file.content.includes("\u0000")) return `${file.path}: a recipe holds text files only`
    total += bytes
  }
  if (total > RECIPE_MAX_BYTES) return `a recipe holds at most ${RECIPE_MAX_BYTES / 1024 / 1024} MiB of files`
  if (!seen.has(RECIPE_INDEX)) return `a recipe needs ${RECIPE_INDEX} at its top level`
  // a path under areas/ must belong to a named area with its index
  for (const path of seen) {
    const parts = path.split("/")
    if (parts[0] !== "areas") continue
    if (parts.length < 3) return `${path}: files under areas/ go inside an area's directory (areas/<name>/…)`
    if (!AREA_NAME.test(parts[1]!)) return `areas/${parts[1]}: an area's name is lowercase letters, digits and '-', at most 40`
    if (!seen.has(`areas/${parts[1]}/${AREA_INDEX}`)) return `areas/${parts[1]} has no ${AREA_INDEX}`
  }
  for (const file of files) {
    const parts = file.path.split("/")
    const index = file.path === RECIPE_INDEX
    if (!index && (parts.length !== 3 || parts[0] !== "areas" || parts[2] !== AREA_INDEX)) continue
    const parsed = index ? parseRecipeFrontmatter(file.content) : parseAreaFrontmatter(file.content)
    if (typeof parsed === "string") return `${file.path} ${parsed}`
    const rules = reviewRulesSection(file.content)
    if (rules && Buffer.byteLength(rules) > REVIEW_RULES_MAX_BYTES) return `${file.path}: its Review rules section is over ${REVIEW_RULES_MAX_BYTES / 1024} KiB`
  }
  return null
}

function areasOf(files: RecipeFile[]): RecipeArea[] {
  const areas: RecipeArea[] = []
  for (const file of files) {
    const parts = file.path.split("/")
    if (parts.length !== 3 || parts[0] !== "areas" || parts[2] !== AREA_INDEX) continue
    const parsed = parseAreaFrontmatter(file.content)
    if (typeof parsed !== "string") areas.push({ name: parts[1]!, ...parsed })
  }
  return areas.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Every file under a directory, relative and sorted: hidden entries (`.git`)
 * and anything that is not a plain file or directory are left out, and the
 * walk stops at a recipe's own limits, so a damaged directory can never make
 * a read unbounded.
 */
function listFiles(root: string, prefix = "", out: string[] = []): string[] {
  const dir = join(root, prefix)
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir).sort()) {
    if (out.length >= RECIPE_MAX_FILES || name.startsWith(".")) continue
    const relative = prefix ? `${prefix}/${name}` : name
    const stat = lstatSync(join(root, relative))
    if (stat.isDirectory() && relative.split("/").length < MAX_DEPTH) listFiles(root, relative, out)
    else if (stat.isFile()) out.push(relative)
  }
  return out
}

function readFiles(root: string): RecipeFile[] {
  const files: RecipeFile[] = []
  let total = 0
  for (const path of listFiles(root)) {
    const size = lstatSync(join(root, path)).size
    if (size > RECIPE_MAX_FILE_BYTES || total + size > RECIPE_MAX_BYTES) continue
    total += size
    files.push({ path, content: readFileSync(join(root, path), "utf8") })
  }
  return files
}

/** The active recipe's files and areas, or null when the project has none yet. */
export function activeRecipe(repoPath: string): RecipeSnapshot | null {
  const root = recipeDir(repoPath)
  if (!existsSync(join(root, RECIPE_INDEX))) return null
  const files = readFiles(root)
  return { files: files.map((file) => file.path), areas: areasOf(files) }
}

/**
 * What the project list needs and nothing more: whether there is a recipe,
 * and how many areas. Reads only the area indexes, never helper contents.
 */
export function recipeSummary(repoPath: string): { active: boolean; areas: number } {
  const root = recipeDir(repoPath)
  if (!existsSync(join(root, RECIPE_INDEX))) return { active: false, areas: 0 }
  const areasRoot = join(root, "areas")
  if (!existsSync(areasRoot)) return { active: true, areas: 0 }
  const areas = readdirSync(areasRoot).filter((name) => AREA_NAME.test(name) && existsSync(join(areasRoot, name, AREA_INDEX))).length
  return { active: true, areas }
}

/** Whether any draft waits, without reading its files. */
export function hasDraft(repoPath: string, taskExists: (taskId: string) => boolean = () => true): boolean {
  const root = draftsDir(repoPath)
  if (!existsSync(root)) return false
  return readdirSync(root).some((name) => {
    const taskId = name.endsWith(".json") ? name.slice(0, -".json".length) : ""
    return DRAFT_ID.test(taskId) && taskExists(taskId) && existsSync(join(root, taskId, RECIPE_INDEX))
  })
}

/** Every file of the active recipe (or of one task's draft), for a checkout. */
export function recipeFiles(repoPath: string, draftTask?: string): RecipeFile[] {
  if (draftTask !== undefined && !DRAFT_ID.test(draftTask)) return []
  return readFiles(draftTask ? draftDir(repoPath, draftTask) : recipeDir(repoPath))
}

/** One file of the active recipe or of a draft, or null when there is no such file. */
export function readRecipeFile(repoPath: string, path: string, draftTask?: string): string | null {
  if (recipePathError(path) || (draftTask !== undefined && !DRAFT_ID.test(draftTask))) return null
  const file = join(draftTask ? draftDir(repoPath, draftTask) : recipeDir(repoPath), path)
  try {
    const stat = lstatSync(file)
    // the same bound a bulk read keeps: a recipe changed behind Wisp's back cannot make one read unbounded
    return stat.isFile() && stat.size <= RECIPE_MAX_FILE_BYTES ? readFileSync(file, "utf8") : null
  } catch {
    return null
  }
}

async function git(args: string[], cwd: string, write = false): Promise<string> {
  const result = await runBounded({
    // a recipe repository is Wisp's own: no hooks, no signing prompt, no user identity needed
    cmd: ["git", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "user.name=Wisp", "-c", "user.email=wisp@localhost", ...args],
    cwd, env: { GIT_TERMINAL_PROMPT: "0" }, timeoutMs: write ? WRITE_TIMEOUT_MS : READ_TIMEOUT_MS, maxBytes: 1024 * 1024,
  })
  if (result.timedOut) throw new Error(`git ${args[0]} timed out`)
  if (result.exitCode !== 0) throw new Error(`git ${args[0]} failed: ${(result.err || result.out).trim().split("\n")[0] ?? ""}`)
  return result.out.trim()
}

/** The active recipe's version (its commit), or null when there is none. */
export async function recipeVersion(repoPath: string): Promise<string | null> {
  const root = recipeDir(repoPath)
  if (!existsSync(join(root, ".git")) || !existsSync(join(root, RECIPE_INDEX))) return null
  try {
    return await git(["rev-parse", "--short=12", "HEAD"], root)
  } catch {
    return null
  }
}

const activationRecord = (repoPath: string): string => join(projectDir(repoPath), "activated.json")

/**
 * When a person last activated a draft, ISO-8601, or null. Kept apart from
 * the recipe's version: an activation that changed nothing (the recipe task
 * found the instructions already right) is still the person's go-ahead.
 */
export async function recipeActivatedAt(repoPath: string): Promise<string | null> {
  try {
    const at = (JSON.parse(readFileSync(activationRecord(repoPath), "utf8")) as { at?: unknown }).at
    if (typeof at === "string") return at
  } catch {
    // no record yet: an activation from before it existed, or none
  }
  const root = recipeDir(repoPath)
  if (!existsSync(join(root, ".git"))) return null
  try {
    return new Date(await git(["log", "-1", "--format=%cI"], root)).toISOString()
  } catch {
    return null
  }
}

/** A recipe task's proposal: replaces any earlier draft from the same task. */
export function saveDraft(repoPath: string, taskId: string, files: RecipeFile[], now = new Date()): RecipeDraft {
  const invalid = recipeFilesError(files)
  if (invalid) throw new RecipeError(invalid)
  const target = draftDir(repoPath, taskId)
  const staging = `${target}.saving-${process.pid}-${Date.now()}`
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(staging, { recursive: true, mode: 0o700 })
  for (const file of files) {
    const path = join(staging, file.path)
    mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 })
    writeFileSync(path, file.content, { mode: 0o600 })
  }
  writeFileSync(join(draftsDir(repoPath), `${taskId}.json`), JSON.stringify({ taskId, savedAt: now.toISOString() }), { mode: 0o600 })
  rmSync(target, { recursive: true, force: true })
  renameSync(staging, target)
  return { taskId, savedAt: now.toISOString(), files: files.map((file) => file.path).sort(), areas: areasOf(files) }
}

/**
 * The newest saved draft, or null. A draft whose recipe task is gone (purged)
 * is no one's proposal any more: it is thrown away rather than offered.
 */
export function latestDraft(repoPath: string, taskExists: (taskId: string) => boolean = () => true): RecipeDraft | null {
  const root = draftsDir(repoPath)
  if (!existsSync(root)) return null
  let newest: RecipeDraft | null = null
  for (const name of readdirSync(root)) {
    if (!name.endsWith(".json")) continue
    const taskId = name.slice(0, -".json".length)
    if (!DRAFT_ID.test(taskId)) continue
    const dir = draftDir(repoPath, taskId)
    if (!taskExists(taskId)) {
      rmSync(dir, { recursive: true, force: true })
      rmSync(join(root, name), { force: true })
      continue
    }
    if (!existsSync(join(dir, RECIPE_INDEX))) continue
    let savedAt: string
    try {
      savedAt = (JSON.parse(readFileSync(join(root, name), "utf8")) as { savedAt: string }).savedAt
    } catch {
      savedAt = statSync(dir).mtime.toISOString()
    }
    if (newest && newest.savedAt >= savedAt) continue
    const files = readFiles(dir)
    newest = { taskId, savedAt, files: files.map((file) => file.path), areas: areasOf(files) }
  }
  return newest
}

/** When a draft was saved, from its record; "" when the record is unreadable (it sorts oldest). */
function savedAtOf(record: string): string {
  try {
    return (JSON.parse(readFileSync(record, "utf8")) as { savedAt: string }).savedAt ?? ""
  } catch {
    return ""
  }
}

/** When one task's draft was saved: its record, else its directory's mtime, as latestDraft reads it. */
export function draftSavedAt(repoPath: string, taskId: string): string {
  return savedAtOf(join(draftsDir(repoPath), `${taskId}.json`)) || statSync(draftDir(repoPath, taskId)).mtime.toISOString()
}

/**
 * Throw away the activated draft and every draft saved before it. A draft
 * saved while the activation ran is newer, and stays to be activated next.
 */
export function discardDrafts(repoPath: string, activated: Pick<RecipeDraft, "taskId" | "savedAt">): void {
  const root = draftsDir(repoPath)
  if (!existsSync(root)) return
  for (const name of readdirSync(root)) {
    if (!name.endsWith(".json")) continue
    const taskId = name.slice(0, -".json".length)
    if (!DRAFT_ID.test(taskId)) continue
    // the activated task may have saved again while the activation ran: that newer save stays too
    if (savedAtOf(join(root, name)) > activated.savedAt) continue
    rmSync(join(root, taskId), { recursive: true, force: true })
    rmSync(join(root, name), { force: true })
  }
}

/** Undo a half-written activation: the working tree back to HEAD, or empty when there was no recipe yet. */
async function restoreActive(root: string, hasHead: boolean): Promise<void> {
  try {
    if (hasHead) {
      await git(["reset", "-q", "--hard", "HEAD"], root, true)
      await git(["clean", "-fdq"], root, true)
    } else {
      for (const name of readdirSync(root)) if (name !== ".git") rmSync(join(root, name), { recursive: true, force: true })
    }
  } catch (error) {
    console.error(`[wisp] verify: could not restore the recipe in ${root} after a failed activation: ${error instanceof Error ? error.message : String(error)}`)
  }
}

const activations = new Map<string, Promise<unknown>>()

/**
 * Make the newest draft the active recipe: its files replace the old ones in
 * one commit, so every verdict can name the version that judged it.
 */
export function activateDraft(repoPath: string, by: string, taskExists?: (taskId: string) => boolean): Promise<{ version: string; areas: RecipeArea[]; changed: boolean }> {
  const key = resolve(repoPath)
  const run = (activations.get(key) ?? Promise.resolve()).catch(() => {}).then(async () => {
    const draft = latestDraft(repoPath, taskExists)
    if (!draft) throw new RecipeError("There is no draft to activate", 409)
    const files = readFiles(draftDir(repoPath, draft.taskId))
    const invalid = recipeFilesError(files)
    if (invalid) throw new RecipeError(`The draft is not a valid recipe: ${invalid}`, 409)
    const root = recipeDir(repoPath)
    mkdirSync(root, { recursive: true, mode: 0o700 })
    if (!existsSync(join(root, ".git"))) await git(["init", "-q"], root, true)
    const hasHead = await git(["rev-parse", "--verify", "-q", "HEAD"], root).then(() => true, () => false)
    let changed: boolean
    try {
      for (const name of readdirSync(root)) if (name !== ".git") rmSync(join(root, name), { recursive: true, force: true })
      for (const file of files) {
        const path = join(root, file.path)
        mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 })
        writeFileSync(path, file.content, { mode: 0o600 })
      }
      await git(["add", "-A"], root, true)
      const pending = await git(["status", "--porcelain"], root)
      changed = pending !== "" || !hasHead
      if (changed) await git(["commit", "-q", "--allow-empty", "-m", `Activate the draft from task ${draft.taskId}`, "-m", `Activated by ${by}.`], root, true)
    } catch (error) {
      // files and version must never disagree: put the active recipe back as its commit has it
      await restoreActive(root, hasHead)
      throw error
    }
    discardDrafts(repoPath, draft)
    const version = await git(["rev-parse", "--short=12", "HEAD"], root)
    writeFileSync(activationRecord(repoPath), JSON.stringify({ at: new Date().toISOString(), version, by, changed }), { mode: 0o600 })
    return { version, areas: areasOf(files), changed }
  })
  activations.set(key, run)
  return run
}

/** The areas a set of changed files falls in; a file can be in several. */
export function matchAreas(areas: RecipeArea[], files: string[]): { matched: RecipeArea[]; unmapped: string[] } {
  const globs = areas.map((area) => ({ area, globs: area.paths.map((path) => new Bun.Glob(path)) }))
  const matched = new Set<RecipeArea>()
  const unmapped: string[] = []
  for (const file of files) {
    const hits = globs.filter(({ globs: list }) => list.some((glob) => glob.match(file)))
    for (const hit of hits) matched.add(hit.area)
    if (hits.length === 0) unmapped.push(file)
  }
  return { matched: areas.filter((area) => matched.has(area)), unmapped }
}

/**
 * Bring a PR's head into the local object store: a head made on GitHub (its
 * "Update branch", an applied suggestion, a co-author's push) is not there
 * until fetched. Best effort; the diff says when it still cannot be read.
 */
export async function fetchPullHead(repoPath: string, pr: number): Promise<void> {
  if (!Number.isSafeInteger(pr) || pr < 1) return
  await git(["fetch", "--no-tags", "--quiet", "origin", `+refs/pull/${pr}/head`], repoPath, true).catch(() => {})
}

/**
 * Bring the PR's base up to date: a local origin/<base> that lags would put
 * main's newer commits into the PR's three-dot diff. Best effort.
 */
export async function fetchBase(repoPath: string, base: string): Promise<void> {
  if (base === "" || base.startsWith("-") || base.includes("..") || /\s/.test(base)) return
  await git(["fetch", "--no-tags", "--quiet", "origin", `+refs/heads/${base}:refs/remotes/origin/${base}`], repoPath, true).catch(() => {})
}

/**
 * The files a PR head changes against its base: the three-dot diff, as
 * GitHub shows it. Null when git cannot compute it (the head or base is not
 * in the local store): never mistaken for a PR that changes nothing.
 */
export async function changedFiles(repoPath: string, base: string, head: string): Promise<string[] | null> {
  // names come from GitHub: a branch may start with "-", which git must never read as an option
  if (base.startsWith("-") || head.startsWith("-")) return null
  for (const ref of [`origin/${base}`, base]) {
    try {
      const out = await git(["diff", "--name-only", "-z", "--end-of-options", `${ref}...${head}`], repoPath)
      return out.split("\u0000").filter(Boolean)
    } catch {
      // try the next spelling of the base
    }
  }
  return null
}
