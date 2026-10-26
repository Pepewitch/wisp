/**
 * `wisp verify …`: a project's verification recipe, which lives in the Wisp
 * home and never in the repository.
 *
 * The project is `--project <path>`, else the task's own repository (inside a
 * task), else the repository around the current directory.
 */
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { isAbsolute, join, resolve } from "node:path"
import type { VerificationStatus } from "../../shared/api/auto-review"
import type { Flags } from "./cli-args"
import { api, CliApiError, daemonRequest, exitApi } from "./cli-api"
import { print, printError, printJson } from "./cli-print"
import { wispCommand } from "./command"
import { controlFree } from "./control-free"

const COMMAND = wispCommand()

export const VERIFY_USAGE = `usage: ${COMMAND} verify status [project] [--json]
       ${COMMAND} verify show [file] [--project <path>] [--draft <task>]
       ${COMMAND} verify checkout <dir> [--project <path>] [--draft <task>]
       ${COMMAND} verify draft save <dir>
       ${COMMAND} verify setup|improve|fix [project] [--area <name>] [--note "…"] [--harness <h>] [--model <m>] [--effort <e>]
       ${COMMAND} verify activate [project]
       ${COMMAND} verify fallback a|b <harness> [--model <m>] [--effort <e>] [--project <path>]
       ${COMMAND} verify fallback a|b none [--project <path>]`

/** What a draft directory may hold before anything is sent: the daemon checks the rest. */
const MAX_FILES = 300
const MAX_BYTES = 4 * 1024 * 1024

function usage(): never {
  printError(VERIFY_USAGE)
  process.exit(2)
}

function projectOf(flags: Flags, positional?: string): string {
  const named = typeof flags.project === "string" ? flags.project : positional
  if (named) return resolve(named)
  if (process.env.WISP_REPO) return resolve(process.env.WISP_REPO)
  const top = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], { stderr: "ignore" })
  const out = top.exitCode === 0 ? top.stdout.toString().trim() : ""
  return out ? resolve(out) : process.cwd()
}

const query = (project: string, extra: Record<string, string | undefined> = {}): string => {
  const params = new URLSearchParams({ path: project })
  for (const [key, value] of Object.entries(extra)) if (value) params.set(key, value)
  return params.toString()
}

export function formatVerification(status: VerificationStatus, project: string): string {
  const lines = [`${controlFree(project)}: ${status.state === "active" ? `recipe ${status.version ?? "?"}, ${status.areas.length} area${status.areas.length === 1 ? "" : "s"}` : "no verification recipe yet"}`]
  for (const area of status.areas) {
    lines.push(`  ${area.name} (${area.status}) · ${area.paths.join(", ")}${area.attention ? `\n    needs attention: ${controlFree(area.attention)}` : ""}`)
  }
  if (status.attention) lines.push(`  needs attention: ${controlFree(status.attention)}`)
  if (status.draft) lines.push(`  draft from task ${status.draft.taskId} (${status.draft.areas.length} areas) — activate with: ${COMMAND} verify activate`)
  if (status.task) lines.push(`  recipe task ${status.task.id} (${status.task.mode}${status.task.area ? ` ${status.task.area}` : ""}): ${status.task.state}`)
  const agent = (named: { harness: string; model: string | null; effort?: string | null }) =>
    `${named.harness}${named.model ? ` ${named.model}` : ""}${named.effort ? ` (${named.effort} effort)` : ""}`
  lines.push(`  reviewer: ${status.reviewer ? agent(status.reviewer) : "each task's own agent"}`)
  for (const [role, named] of [["A", status.fallbacks?.primary], ["B", status.fallbacks?.second]] as const) {
    if (named) lines.push(`  fallback for ${role}: ${agent(named)}, after an infrastructure failure`)
  }
  return lines.join("\n")
}

/** Every file under a draft directory, relative; refuses links and anything too large before sending. */
function readDraft(root: string): { path: string; content: string }[] {
  const files: { path: string; content: string }[] = []
  let total = 0
  const walk = (prefix: string): void => {
    for (const name of readdirSync(join(root, prefix)).sort()) {
      const relative = prefix ? `${prefix}/${name}` : name
      // hidden entries (.git, a stray .DS_Store) are no part of a recipe, as the daemon reads it too
      if (name.startsWith(".")) continue
      const stat = lstatSync(join(root, relative))
      if (stat.isSymbolicLink()) throw new Error(`${relative} is a link; a recipe holds plain files`)
      if (stat.isDirectory()) { walk(relative); continue }
      if (!stat.isFile()) continue
      total += stat.size
      if (files.length >= MAX_FILES || total > MAX_BYTES) throw new Error(`a recipe holds at most ${MAX_FILES} files and ${MAX_BYTES / 1024 / 1024} MiB`)
      files.push({ path: relative, content: readFileSync(join(root, relative), "utf8") })
    }
  }
  walk("")
  return files
}

async function saveDraft(dir: string | undefined): Promise<void> {
  if (!dir) usage()
  const root = resolve(dir)
  if (!existsSync(root)) { printError(`no such directory: ${dir}`); process.exit(1) }
  const task = process.env.WISP_TASK_ID ?? ""
  if (!/^[a-z0-9]+$/.test(task)) { printError("Draft not saved: run this inside a verification recipe task."); process.exit(1) }
  let files: { path: string; content: string }[]
  try {
    files = readDraft(root)
  } catch (error) {
    printError(`Draft not saved: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
  try {
    const draft = await daemonRequest("/api/projects/verification/draft", "POST", JSON.stringify({ task, files })) as { files: string[]; areas: { name: string; status: string }[] }
    print(`Draft saved: ${draft.files.length} files, areas ${draft.areas.map((area) => `${area.name} (${area.status})`).join(", ") || "none"}. A person activates it.`)
  } catch (error) {
    if (error instanceof CliApiError && (error.status === 400 || error.status === 403)) { printError(`Draft not saved: ${error.message}`); process.exit(1) }
    exitApi(error)
  }
}

async function checkout(dir: string | undefined, flags: Flags): Promise<void> {
  if (!dir) usage()
  const root = resolve(dir)
  if (existsSync(root) && readdirSync(root).length > 0) { printError(`${dir} is not empty; check out into a new or empty directory`); process.exit(1) }
  const project = projectOf(flags)
  const { files } = await api(`/api/projects/verification/checkout?${query(project, { draft: typeof flags.draft === "string" ? flags.draft : undefined })}`) as { files: { path: string; content: string }[] }
  if (files.length === 0) { print("This project has no verification recipe yet: start one from scratch in that directory."); return }
  for (const file of files) {
    // the daemon validated these paths; a checkout still never writes outside its directory
    const target = resolve(root, file.path)
    if (isAbsolute(file.path) || !target.startsWith(`${root}/`)) continue
    mkdirSync(join(target, ".."), { recursive: true })
    writeFileSync(target, file.content)
  }
  print(`Checked out ${files.length} recipe files into ${dir}. Edit them, then: ${COMMAND} verify draft save ${dir}`)
}

async function showFile(file: string | undefined, flags: Flags): Promise<void> {
  const project = projectOf(flags)
  const draft = typeof flags.draft === "string" ? flags.draft : undefined
  const data = await api(`/api/projects/verification/files?${query(project, { file, draft })}`) as { files?: string[]; content?: string }
  if (data.content !== undefined) { print(controlFree(data.content)); return }
  print(data.files && data.files.length > 0 ? data.files.join("\n") : "This project has no verification recipe yet.")
}

/**
 * Who stands in for reviewer A or B when its task fails for an infrastructure
 * reason: a project setting, saved like the reviewer agents are.
 */
async function setFallback(role: string | undefined, harness: string | undefined, flags: Flags): Promise<void> {
  const key = role?.toLowerCase() === "a" ? "verifyFallback" : role?.toLowerCase() === "b" ? "verifySecondFallback" : null
  if (!key || !harness) usage()
  const none = harness === "none"
  if (none && (flags.model !== undefined || flags.effort !== undefined)) { printError("--model and --effort name a fallback agent, not none"); process.exit(2) }
  for (const flag of ["model", "effort"] as const) {
    if (flags[flag] !== undefined && typeof flags[flag] !== "string") { printError(`--${flag} requires a value`); process.exit(2) }
  }
  const agent = none ? null : {
    harness, ...(typeof flags.model === "string" ? { model: flags.model } : {}), ...(typeof flags.effort === "string" ? { effort: flags.effort } : {}),
  }
  const project = projectOf(flags)
  await api("/api/projects", "POST", { path: project, [key]: agent })
  const letter = key === "verifyFallback" ? "A" : "B"
  print(agent
    ? `Reviewer ${letter} falls back to ${agent.harness}${agent.model ? ` ${agent.model}` : ""} when its task fails on the network, the provider or setup`
    : `Reviewer ${letter} has no fallback: an infrastructure failure ends its round for a person`)
}

export async function verifyCommand(positional: string[], flags: Flags): Promise<void> {
  const [verb, argument, extra] = positional
  if (verb === "status") {
    const project = projectOf(flags, argument)
    const status = await api(`/api/projects/verification?${query(project)}`) as VerificationStatus
    if (flags.json) printJson(status)
    else print(formatVerification(status, project))
    return
  }
  if (verb === "show") return showFile(argument, flags)
  if (verb === "checkout") return checkout(argument, flags)
  if (verb === "draft" && argument === "save") return saveDraft(extra)
  if (verb === "setup" || verb === "improve" || verb === "fix") {
    const project = projectOf(flags, argument)
    const body: Record<string, string> = { path: project, mode: verb }
    for (const key of ["area", "note", "harness", "model", "effort"] as const) if (typeof flags[key] === "string") body[key] = flags[key] as string
    const created = await api("/api/projects/verification/tasks", "POST", body) as { task: { id: string; title: string } }
    print(`created ${created.task.id} — ${controlFree(created.task.title)}`)
    return
  }
  if (verb === "fallback") return setFallback(argument, extra, flags)
  if (verb === "activate") {
    const project = projectOf(flags, argument)
    const done = await api("/api/projects/verification/activate", "POST", { path: project }) as { version: string; areas: unknown[]; changed: boolean }
    print(done.changed ? `Activated recipe ${done.version} (${done.areas.length} areas)` : `The draft matched the active recipe ${done.version}; nothing changed`)
    return
  }
  usage()
}
