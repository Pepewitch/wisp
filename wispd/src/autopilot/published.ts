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

/** Branch-level: the PR's own branch, and anything built on the PR that only this machine has. */
async function branchesHoldNothingMore(cwd: string, branch: string, head: string, signal: AbortSignal): Promise<PublishedWork | null> {
  // `rev-parse --verify --quiet` exits 1 for a missing object, where
  // `cat-file -e` exits 128 and would be indistinguishable from an error.
  const present = () => yesNo(["rev-parse", "--verify", "--quiet", `${head}^{commit}`], cwd, signal)
  if (!(await present())) {
    // Usual when the remote moved ahead (a suggestion committed on GitHub,
    // "Update branch"): fetch it, read-only for the worktree.
    await git(["fetch", "--quiet", "origin", branch], cwd, signal, 60_000)
    if (!(await present())) throw new Unverifiable()
  }
  const local = await git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`], cwd, signal)
  if (local.exitCode === 0) {
    if (local.out !== head && !(await yesNo(["merge-base", "--is-ancestor", local.out, head], cwd, signal))) return UNPUBLISHED
  } else if (local.exitCode !== 1) {
    throw new Unverifiable()
  }
  // Every branch in the repository, so the reason names the one that holds
  // the work: it may belong to another task stacked on this one.
  const containing = await git(["for-each-ref", "--format=%(objectname) %(refname:short)", "--contains", head, "refs/heads/"], cwd, signal)
  if (containing.exitCode !== 0) throw new Unverifiable()
  for (const line of containing.out.split("\n")) {
    const [sha, name] = line.split(" ")
    if (!sha || sha === head) continue
    if (await onlyHere(sha, cwd, signal)) return { ok: false, reason: `Branch ${name} has unpushed commits built on the PR` }
  }
  return null
}

async function onlyHere(sha: string, cwd: string, signal: AbortSignal): Promise<boolean> {
  const remotes = await git(["for-each-ref", "--format=%(refname)", "--count=1", "--contains", sha, "refs/remotes/"], cwd, signal)
  if (remotes.exitCode !== 0) throw new Unverifiable()
  return remotes.out === ""
}

const UNPUBLISHED: PublishedWork = { ok: false, reason: "Worktree has commits the PR does not" }

/** Worktree-level: HEAD, an operation in progress, and tracked edits — when HEAD is the PR's line of work. */
async function worktreeIsClean(worktree: string, branch: string, head: string, signal: AbortSignal): Promise<PublishedWork> {
  const current = await git(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], worktree, signal)
  if (current.exitCode !== 0) throw new Unverifiable()
  const onPrLine = current.out === head || (await yesNo(["merge-base", "--is-ancestor", head, current.out], worktree, signal))
  if (onPrLine && current.out !== head && (await onlyHere(current.out, worktree, signal))) return UNPUBLISHED
  const named = await git(["symbolic-ref", "--quiet", "--short", "HEAD"], worktree, signal)
  if (named.exitCode !== 0 && named.exitCode !== 1) throw new Unverifiable()
  const onBranch = named.exitCode === 0 ? named.out : null
  // Unrelated work on another branch is not this PR's business.
  if (!onPrLine && onBranch !== branch && onBranch !== null) return { ok: true }
  const gitDir = await git(["rev-parse", "--git-dir"], worktree, signal)
  if (gitDir.exitCode !== 0) throw new Unverifiable()
  const dir = isAbsolute(gitDir.out) ? gitDir.out : join(worktree, gitDir.out)
  if (["rebase-merge", "rebase-apply", "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"].some((name) => existsSync(join(dir, name)))) {
    return { ok: false, reason: "Worktree has a rebase or merge in progress" }
  }
  const status = await git(["status", "--porcelain", "--untracked-files=no"], worktree, signal)
  if (status.exitCode !== 0) throw new Unverifiable()
  return status.out === "" ? { ok: true } : { ok: false, reason: "Worktree has uncommitted changes" }
}

async function inspect(task: Task, branch: string, head: string, signal: AbortSignal): Promise<PublishedWork> {
  const cwd = task.worktree_path ?? task.repo_path
  if (!existsSync(cwd)) throw new Unverifiable()
  return (await branchesHoldNothingMore(cwd, branch, head, signal)) ??
    (task.worktree_path ? await worktreeIsClean(task.worktree_path, branch, head, signal) : { ok: true })
}

export async function publishedWork(task: Task, branch: string, head: string, signal: AbortSignal): Promise<PublishedWork> {
  try {
    return await inspect(task, branch, head, signal)
  } catch (error) {
    if (error instanceof Unverifiable) return { ok: false, reason: "Can't verify the worktree" }
    throw error
  }
}
