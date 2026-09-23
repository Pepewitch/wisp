/**
 * The one merge condition GitHub cannot see: whether the task's worktree holds
 * work the pull request does not. Merging then would silently leave the
 * agent's latest commits stranded on a merged branch.
 *
 * It asks about the PR's own branch, not whatever HEAD happens to be — an
 * agent that went on to a second branch has not unpublished the first. And it
 * ignores untracked files: tools drop them into worktrees on their own (a code
 * index, an editor's swap file), and a new file an agent forgot to add almost
 * always breaks the PR's own checks first.
 */
import { runBounded } from "../subprocess"
import type { Task } from "../types"
import type { PublishedWork } from "./gate"

async function git(args: string[], cwd: string, signal: AbortSignal, timeoutMs = 15_000) {
  return await runBounded({ cmd: ["git", ...args], cwd, signal, timeoutMs, maxBytes: 1_000_000, maxErrorBytes: 2000 })
}

export async function publishedWork(task: Task, branch: string, head: string, signal: AbortSignal): Promise<PublishedWork> {
  const cwd = task.worktree_path ?? task.repo_path
  const local = await git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`], cwd, signal)
  if (local.exitCode === 0) {
    const localSha = local.out.trim()
    if (localSha !== head) {
      let present = (await git(["cat-file", "-e", `${head}^{commit}`], cwd, signal)).exitCode === 0
      if (!present) {
        // Usual when the remote moved ahead (a suggestion committed on GitHub,
        // "Update branch"): fetch it, read-only for the worktree.
        await git(["fetch", "--quiet", "origin", branch], cwd, signal, 60_000)
        present = (await git(["cat-file", "-e", `${head}^{commit}`], cwd, signal)).exitCode === 0
      }
      if (!present) return { ok: false, reason: "Can't verify local commits" }
      const ancestry = await git(["merge-base", "--is-ancestor", localSha, head], cwd, signal)
      if (ancestry.exitCode === 1) return { ok: false, reason: "Worktree has unpushed commits" }
      if (ancestry.exitCode !== 0) return { ok: false, reason: "Can't verify local commits" }
    }
  }
  if (!task.worktree_path) return { ok: true }
  const current = await git(["symbolic-ref", "--quiet", "--short", "HEAD"], task.worktree_path, signal)
  if (current.exitCode !== 0 || current.out.trim() !== branch) return { ok: true }
  const status = await git(["status", "--porcelain", "--untracked-files=no"], task.worktree_path, signal)
  if (status.exitCode !== 0) return { ok: false, reason: "Can't read the worktree" }
  return status.out.trim() === "" ? { ok: true } : { ok: false, reason: "Worktree has uncommitted changes" }
}
