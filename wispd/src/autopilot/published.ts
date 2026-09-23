/**
 * The one merge condition GitHub cannot see: whether the task's worktree holds
 * work the pull request does not. Merging then would leave the agent's latest
 * commits stranded on a merged branch.
 *
 * Every answer other than a definite yes or no is "Can't verify", so a git
 * error, a timeout, or a state it does not recognise never reads as clean.
 *
 * What counts as unpublished:
 * - the PR's own local branch has commits the PR head lacks;
 * - ANY local branch, or the worktree's HEAD (detached included), contains the
 *   PR head plus commits that exist on no remote — work built on the PR under
 *   another name that only this machine has. (A stacked child that was pushed
 *   for its own PR is not stranded, so it never holds its parent back.)
 * - tracked changes, or an unfinished rebase/merge/cherry-pick, in a worktree
 *   whose HEAD is the PR's line of work.
 *
 * A worktree that moved on to unrelated work (a second branch off the base)
 * has not unpublished the first PR. Untracked files are ignored: tools drop
 * them into worktrees on their own, and a new file an agent forgot to add
 * almost always breaks the PR's own checks first.
 */
import { existsSync } from "node:fs"
import { isAbsolute, join } from "node:path"
import { runBounded } from "../subprocess"
import type { Task } from "../types"
import type { PublishedWork } from "./gate"

class Unverifiable extends Error {}

async function git(args: string[], cwd: string, signal: AbortSignal, timeoutMs = 15_000) {
  const result = await runBounded({ cmd: ["git", ...args], cwd, signal, timeoutMs, maxBytes: 1_000_000, maxErrorBytes: 2000 })
  if (result.timedOut || result.cancelled || result.truncated || result.cleanupError || result.exitCode === null) throw new Unverifiable()
  return { exitCode: result.exitCode, out: result.out.trim() }
}

/** exit 0 → true, exit 1 → false, anything else → cannot say. */
async function yesNo(args: string[], cwd: string, signal: AbortSignal): Promise<boolean> {
  const result = await git(args, cwd, signal)
  if (result.exitCode === 0) return true
  if (result.exitCode === 1) return false
  throw new Unverifiable()
}

async function inspect(task: Task, branch: string, head: string, signal: AbortSignal): Promise<PublishedWork> {
  const unpublished: PublishedWork = { ok: false, reason: "Worktree has commits the PR does not" }
  const cwd = task.worktree_path ?? task.repo_path
  if (!existsSync(cwd)) throw new Unverifiable()
  if (!(await yesNo(["cat-file", "-e", `${head}^{commit}`], cwd, signal))) {
    // Usual when the remote moved ahead (a suggestion committed on GitHub,
    // "Update branch"): fetch it, read-only for the worktree.
    await git(["fetch", "--quiet", "origin", branch], cwd, signal, 60_000)
    if (!(await yesNo(["cat-file", "-e", `${head}^{commit}`], cwd, signal))) throw new Unverifiable()
  }

  const local = await git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`], cwd, signal)
  if (local.exitCode === 0) {
    if (local.out !== head && !(await yesNo(["merge-base", "--is-ancestor", local.out, head], cwd, signal))) return unpublished
  } else if (local.exitCode !== 1) {
    throw new Unverifiable()
  }

  const onlyHere = async (sha: string): Promise<boolean> => {
    const remotes = await git(["for-each-ref", "--format=%(refname)", "--count=1", "--contains", sha, "refs/remotes/"], cwd, signal)
    if (remotes.exitCode !== 0) throw new Unverifiable()
    return remotes.out === ""
  }
  const containing = await git(["for-each-ref", "--format=%(objectname)", "--contains", head, "refs/heads/"], cwd, signal)
  if (containing.exitCode !== 0) throw new Unverifiable()
  for (const sha of new Set(containing.out.split("\n").filter((tip) => tip !== "" && tip !== head))) {
    if (await onlyHere(sha)) return unpublished
  }

  if (!task.worktree_path) return { ok: true }
  const current = await git(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], task.worktree_path, signal)
  if (current.exitCode !== 0) throw new Unverifiable()
  const onPrLine = current.out === head || (await yesNo(["merge-base", "--is-ancestor", head, current.out], task.worktree_path, signal))
  if (onPrLine && current.out !== head && (await onlyHere(current.out))) return unpublished
  const named = await git(["symbolic-ref", "--quiet", "--short", "HEAD"], task.worktree_path, signal)
  const onBranch = named.exitCode === 0 ? named.out : null
  if (named.exitCode !== 0 && named.exitCode !== 1) throw new Unverifiable()
  // Unrelated work on another branch is not this PR's business.
  if (!onPrLine && onBranch !== branch && onBranch !== null) return { ok: true }

  const gitDir = await git(["rev-parse", "--git-dir"], task.worktree_path, signal)
  if (gitDir.exitCode !== 0) throw new Unverifiable()
  const dir = isAbsolute(gitDir.out) ? gitDir.out : join(task.worktree_path, gitDir.out)
  if (["rebase-merge", "rebase-apply", "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"].some((name) => existsSync(join(dir, name)))) {
    return { ok: false, reason: "Worktree has a rebase or merge in progress" }
  }
  const status = await git(["status", "--porcelain", "--untracked-files=no"], task.worktree_path, signal)
  if (status.exitCode !== 0) throw new Unverifiable()
  return status.out === "" ? { ok: true } : { ok: false, reason: "Worktree has uncommitted changes" }
}

export async function publishedWork(task: Task, branch: string, head: string, signal: AbortSignal): Promise<PublishedWork> {
  try {
    return await inspect(task, branch, head, signal)
  } catch (error) {
    if (error instanceof Unverifiable) return { ok: false, reason: "Can't verify the worktree" }
    throw error
  }
}
