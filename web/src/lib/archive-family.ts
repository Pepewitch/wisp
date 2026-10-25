import { autopilotArchiveWords } from "./autopilot-words"
import { ApiError } from "./transport"
import { isReviewer } from "./subtask-tree"
import type { ApiTask } from "./types"

/*
 * Archiving a parent archives its family, and the confirm names every child
 * with what happens to it. The daemon decides: it refuses a parent with live
 * subtasks until asked to take them (`subtasks: "archive"`), names each child
 * that cannot go as it is, and wants its own yes to force them ("force") and
 * a separate one to stop a child's autopilot (`stopAutopilot`). This turns
 * those refusals, and the task list, into what the dialog says.
 */

/** One child the daemon refused, from a 409's `refusedSubtasks`. */
export interface RefusedSubtask {
  id: string
  title: string
  error: string
  /** `subtasks`: it goes only when asked to; `stopAutopilot`: its autopilot is on */
  needs?: "subtasks" | "stopAutopilot"
}

/** The consents sent so far; each is its own decision, never implied by another. */
export interface FamilyConsents {
  subtasks?: "archive" | "force"
  stopAutopilot: boolean
}

/** What the family confirm's button asks for next. */
export type FamilyStep = "archive" | "force" | "stopAutopilot"

export interface FamilyMember {
  id: string
  title: string
  /** what happens to it, or why it cannot go yet */
  outcome: string
  /** it holds the archive up until the next consent */
  refused: boolean
}

/** The children a 409 refused, or null when the refusal is not about subtasks. */
export function refusedSubtasks(error: unknown): RefusedSubtask[] | null {
  if (!(error instanceof ApiError)) return null
  const list = error.data.refusedSubtasks
  if (!Array.isArray(list)) return null
  return list.flatMap((entry: unknown) => {
    if (!entry || typeof entry !== "object") return []
    const { id, title, error: why, needs } = entry as Record<string, unknown>
    if (typeof id !== "string") return []
    return [{
      id,
      title: typeof title === "string" ? title : id,
      error: typeof why === "string" ? why : "refused",
      ...(needs === "subtasks" || needs === "stopAutopilot" ? { needs } : {}),
    }]
  })
}

/** The unarchived family archiving `parentId` takes along: children and their reviewers, as the daemon walks it. */
function liveFamily(parentId: string, tasks: readonly ApiTask[]): ApiTask[] {
  const live = tasks.filter((task) => !task.archived)
  const children = live.filter((task) => task.parent_task_id === parentId)
  return children.flatMap((child) => [child, ...live.filter((task) => task.parent_task_id === child.id)])
}

/** Its autopilot watches a PR, so archiving needs the separate yes (the daemon asks the same). */
const autopilotOn = (task: ApiTask): boolean => autopilotArchiveWords(task.autopilot) !== null

/**
 * Every member of the family with its outcome, and the one consent the
 * confirm asks for next: force the children that cannot go as they are,
 * then stop the autopilot of those still watching a PR, and otherwise take
 * them along.
 */
export function familyPlan(
  parentId: string,
  tasks: readonly ApiTask[],
  refused: readonly RefusedSubtask[],
  sent: FamilyConsents,
): { members: FamilyMember[]; next: FamilyStep } {
  const byId = new Map(refused.map((child) => [child.id, child]))
  const family = liveFamily(parentId, tasks)
  const known = new Set(family.map((task) => task.id))
  const members: FamilyMember[] = family.map((task) => {
    const refusal = byId.get(task.id)
    if (refusal && refusal.needs !== "subtasks") return { id: task.id, title: task.title, outcome: refusal.error, refused: true }
    if (isReviewer(task)) return { id: task.id, title: task.title, outcome: "a reviewer: its review ends, and it is archived", refused: false }
    const forced = sent.subtasks === "force" ? "forced" : "archived with it"
    const stops = autopilotOn(task) ? (sent.stopAutopilot ? "; its autopilot is switched off" : "; its autopilot is asked about first") : ""
    return { id: task.id, title: task.title, outcome: `${forced}${stops}`, refused: false }
  })
  // a child the list has not caught up with yet is still named
  for (const refusal of refused) {
    if (!known.has(refusal.id)) members.push({ id: refusal.id, title: refusal.title, outcome: refusal.needs === "subtasks" ? "archived with it" : refusal.error, refused: refusal.needs !== "subtasks" })
  }
  const next: FamilyStep = refused.some((child) => !child.needs)
    ? "force"
    : refused.some((child) => child.needs === "stopAutopilot")
      ? "stopAutopilot"
      : "archive"
  return { members, next }
}

/** The consents to send for `step`, on top of the ones already given. */
export function withConsent(sent: FamilyConsents, step: FamilyStep): FamilyConsents {
  if (step === "stopAutopilot") return { ...sent, stopAutopilot: true }
  return { ...sent, subtasks: step === "force" ? "force" : (sent.subtasks ?? "archive") }
}
