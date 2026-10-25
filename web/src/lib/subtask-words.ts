import type { ApiTask, SubtaskKind } from "./types"

/*
 * The words the task view uses for a subtask: its kind, and where its pinned
 * base came from (`base_from`, recorded at creation).
 */

/** What each kind is for, in the New subtask dialog's words. */
export const KIND_WORDS: Record<SubtaskKind, string> = {
  explore: "Its own branch, to try something and open its own PR.",
  review: "Reads this task's PR and reports what it finds; it never pushes.",
  continue: "Carries this task's work on; this task merges its branch.",
}

/** The same, short enough for the kind menu's hint column. */
export const KIND_HINT: Record<SubtaskKind, string> = {
  explore: "own branch and PR",
  review: "reads the PR",
  continue: "from this tip",
}

/** Where a new subtask of `parent` starts when no base is chosen: pinned when it starts. */
export function subtaskBasePreview(kind: SubtaskKind, parent: Pick<ApiTask, "branch">): string {
  if (kind === "review") return "this task's PR head, pinned when it starts"
  if (kind === "continue") return `this task's tip${parent.branch ? ` (${parent.branch})` : ""}, pinned when it starts`
  return "the project's base, pinned when it starts"
}

/**
 * The new-task composer keeps an unsent draft per scope. A subtask's is its
 * parent's, kept apart from the project's own: a project scope is a path,
 * which never starts with this prefix.
 */
export const subtaskDraftScope = (parentId: string): string => `subtask:${parentId}`

/** Where the base came from, and the commit when the worktree exists. */
export function baseWords(task: Pick<ApiTask, "base_from" | "base_sha">): string | null {
  const from = task.base_from
  if (!from) return null
  const pr = /^pr#(\d+)$/.exec(from)
  const source = pr ? `PR #${pr[1]}'s head` : from.startsWith("parent:") ? "the parent's tip" : from === "project" ? "the project's base" : "a chosen base"
  return task.base_sha ? `${source} at ${task.base_sha.slice(0, 7)}` : source
}
