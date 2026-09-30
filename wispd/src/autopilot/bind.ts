/** Which pull request an armed task binds to, and the repository it is asked about. */
import { bunProbeSpawn } from "../probes"
import { githubRepository } from "../pull-request-github"
import type { Task } from "../types"
import type { OpenPullRequest } from "./github"

export async function originRepository(task: Task, signal: AbortSignal): Promise<string | null> {
  const origin = await Promise.resolve()
    .then(() => bunProbeSpawn(["git", "remote", "get-url", "origin"], { cwd: task.repo_path, signal }))
    .catch(() => null)
  return origin && origin.exitCode === 0 ? githubRepository(origin.stdout) : null
}

/**
 * Only a PR this task could have opened: authored by the account Wisp merges
 * as, opened after the task was created, from this repository. A worktree can
 * check out anyone's branch (`gh pr checkout`), and adopting that PR would
 * merge someone else's work under the owner's name. Among those, the task's
 * own branch names first, then the oldest onto the base, so a stacked child
 * never jumps its parent.
 */
export function choosePull(pulls: OpenPullRequest[], task: Task, viewer: string, allowedBases: ReadonlySet<string>, afterPr = 0): OpenPullRequest | null {
  const created = Date.parse(task.created_at)
  // After a merge, only a PR numbered above the merged one: GitHub numbers in
  // creation order, so that is the task's next change or a PR stacked on the
  // merged one, and never the merged PR itself (a lagging open list) or an
  // older open PR, which is stale or abandoned.
  const own = pulls
    .filter((pull) => !pull.isCrossRepository && viewer !== "" && pull.author === viewer && Date.parse(pull.createdAt) >= created && pull.number > afterPr)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.number - b.number)
  const named = (pull: OpenPullRequest) => pull.headRefName === task.branch || pull.headRefName.startsWith(`wisp/${task.id}-`)
  return own.find((pull) => named(pull) && allowedBases.has(pull.baseRefName)) ??
    own.find((pull) => allowedBases.has(pull.baseRefName)) ?? own.find(named) ?? own[0] ?? null
}

/** Why the first open PR was not adopted, so "Waiting for a PR" never hides one that exists. */
export function skippedPull(pulls: OpenPullRequest[], task: Task, viewer: string, mergedPr?: number): string | null {
  // the merged PR itself, still listed open for a moment, says nothing
  const pull = pulls.find((candidate) => candidate.number !== mergedPr)
  if (!pull) return null
  if (pull.isCrossRepository) return `#${pull.number} is from a fork`
  if (pull.author !== viewer) return `#${pull.number} was opened by @${pull.author ?? "someone else"}, not @${viewer}`
  if (Date.parse(pull.createdAt) < Date.parse(task.created_at)) return `#${pull.number} is older than this task`
  if (mergedPr !== undefined && pull.number < mergedPr) return `#${pull.number} is older than #${mergedPr}, which merged`
  return null
}
