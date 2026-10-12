/**
 * Where a project's verification stands, for the sidebar, the project
 * settings and `wisp verify status`: the active recipe and its areas, a
 * draft waiting to be activated, the recipe task at work, and what reviewers
 * reported about the recipe since it was last activated.
 */
import { resolve } from "node:path"
import type { VerificationStatus, VerificationTask } from "../../../shared/api/auto-review"
import { repoConfigFor, type WispConfig } from "../config"
import { db } from "../store-database"
import { getTask } from "../store"
import { activeRecipe, latestDraft, recipeActivatedAt, recipeVersion } from "./recipe"
import { recipeComplaints } from "./rounds"

export type VerifyMode = VerificationTask["mode"]

interface VerifyTaskRow {
  task_id: string
  project_path: string
  mode: VerifyMode
  area: string | null
  round_id: string | null
  created_at: string
}

export function recordVerifyTask(input: { taskId: string; projectPath: string; mode: VerifyMode; area: string | null; roundId: string | null }, now = new Date()): void {
  db.run("INSERT OR REPLACE INTO verify_tasks(task_id, project_path, mode, area, round_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    [input.taskId, resolve(input.projectPath), input.mode, input.area, input.roundId, now.toISOString()])
}

export function verifyTaskOf(taskId: string): VerifyTaskRow | null {
  return db.query("SELECT * FROM verify_tasks WHERE task_id = ?").get(taskId) as VerifyTaskRow | null
}

/** The project's newest recipe task that is not archived. */
export function currentVerifyTask(projectPath: string): VerificationTask | null {
  const rows = db.query(`SELECT v.*, t.state AS task_state, t.archived AS archived FROM verify_tasks v JOIN tasks t ON t.id = v.task_id
    WHERE v.project_path = ? AND t.archived = 0 ORDER BY v.created_at DESC LIMIT 1`).all(resolve(projectPath)) as (VerifyTaskRow & { task_state: string; archived: number })[]
  const row = rows[0]
  return row ? { id: row.task_id, mode: row.mode, area: row.area, state: row.task_state, archived: row.archived !== 0 } : null
}

/** A recipe task of this project still at work (not settled), if any. */
export function busyVerifyTask(projectPath: string): VerificationTask | null {
  const task = currentVerifyTask(projectPath)
  if (!task) return null
  const row = getTask(task.id)
  return row && ["creating", "running", "stuck"].includes(row.state) ? task : null
}

export async function verificationStatus(repoPath: string, cfg: WispConfig): Promise<VerificationStatus> {
  const recipe = activeRecipe(repoPath)
  const [version, activatedAt] = recipe ? await Promise.all([recipeVersion(repoPath), recipeActivatedAt(repoPath)]) : [null, null]
  const complaints = recipeComplaints(repoPath, activatedAt)
  const names = new Set(recipe?.areas.map((area) => area.name) ?? [])
  const byArea = new Map<string, string>()
  for (const complaint of complaints) {
    if (complaint.area && names.has(complaint.area) && !byArea.has(complaint.area)) byArea.set(complaint.area, complaint.feedback)
  }
  const loose = complaints.find((complaint) => !complaint.area || !names.has(complaint.area))
  const draft = latestDraft(repoPath)
  const reviewer = repoConfigFor(cfg, repoPath)?.verify
  return {
    state: recipe ? "active" : "none",
    version, activatedAt,
    areas: (recipe?.areas ?? []).map((area) => ({ ...area, attention: byArea.get(area.name) ?? null })),
    draft: draft ? { taskId: draft.taskId, savedAt: draft.savedAt, areas: draft.areas } : null,
    task: currentVerifyTask(repoPath),
    reviewer: reviewer ? { harness: reviewer.harness, model: reviewer.model ?? null, effort: reviewer.effort ?? null } : null,
    attention: loose?.feedback ?? null,
  }
}
