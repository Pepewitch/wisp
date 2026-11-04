/**
 * Taking a task's worktree off disk: archive cleanup's "Remove workspace" step.
 * Most of it hands the directory to the trash (worktree-trash.ts says why), so
 * it first makes the checks `git worktree remove` would have made itself.
 */
import { realpath, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { WORKTREE_ROOT } from "./config";
import { pathExists } from "./fsutil";
import { WRITE_TIMEOUT_MS } from "./subprocess";
import { commitDirtyWork, git, must, worktreeHealth } from "./worktree";
import { kickTrashSweep, moveToTrash } from "./worktree-trash";

/**
 * The checks `git worktree remove` makes before it deletes anything, asked of
 * the worktree itself, because the fast path below deletes without git: the
 * path must be the top level of a linked worktree of this repository, and not
 * locked. Above all it must never be a main checkout.
 */
async function assertRemovableWorktree(repo: string, worktree: string): Promise<void> {
  const own = await git(["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir", "--show-toplevel"], worktree);
  const theirs = await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], repo);
  must(own, `could not read the worktree at ${worktree}`);
  must(theirs, `could not read the repository at ${repo}`);
  const [gitDir, commonDir, top] = own.out.trim().split("\n").map(line => line.trim());
  if (!gitDir || !commonDir || !top) throw new Error(`could not read the worktree at ${worktree}`);
  const real = await realpath(worktree);
  if ((await realpath(gitDir)) === (await realpath(commonDir))) {
    throw new Error(`${worktree} is a repository's main checkout, not a task worktree; Wisp never removes it`);
  }
  if ((await realpath(commonDir)) !== (await realpath(theirs.out.trim()))) {
    throw new Error(`${worktree} is a worktree of a different repository than ${repo}`);
  }
  if ((await realpath(top)) !== real) throw new Error(`${worktree} is inside a worktree, not its top level (${top})`);
  if (await pathExists(join(gitDir, "locked"))) {
    throw new Error(`${worktree} is locked; run git worktree unlock ${worktree} if it may be removed`);
  }
}

/**
 * Take a worktree directory off its path at once, if it lives where Wisp makes
 * worktrees: renamed into the trash, which deletes its bytes in the background.
 * False when it is somewhere else, or on another volume, and must be deleted in place.
 */
async function moveWorktreeToTrash(worktree: string): Promise<boolean> {
  const real = await realpath(worktree);
  if (dirname(real) !== (await realpath(WORKTREE_ROOT))) return false;
  if ((await moveToTrash(real)) === null) return false;
  kickTrashSweep();
  return true;
}

/**
 * Remove the worktree after archive preflight. The archive worker checkpoints
 * scripts separately before calling this filesystem/Git step. A throw is a
 * background failure the caller must surface (state_detail), never swallow.
 *
 * A worktree in WORKTREE_ROOT is moved into the trash and its admin entry
 * pruned, which takes milliseconds however big it is; worktree-trash.ts says
 * why. Interrupted between the two, a retry finds the directory gone and
 * prunes. Anywhere else, `git worktree remove` deletes it in place, as before.
 *
 * The branch is always kept.
 */
export async function removeWorktree(
  repoPath: string,
  worktree: string,
  branch: string,
  force: boolean,
  steps: { save?: boolean } = {},
): Promise<void> {
  const repo = resolve(repoPath);
  const health = await worktreeHealth(worktree);
  if (!health.ok) {
    // The recovery (D1 part 2): a worktree git has forgotten used to 409
    // forever, because `git worktree remove` on a path git does not know fails.
    // Prune the stale admin entry and let the row clear. The bytes are the
    // deviation documented in archivePreflight — force takes them, plain
    // archive leaves them.
    await git(["worktree", "prune"], repo, { timeoutMs: WRITE_TIMEOUT_MS });
    if (force && health.kind === "detached" && !(await moveWorktreeToTrash(worktree))) {
      await rm(worktree, { recursive: true, force: true });
    }
    return;
  }
  await assertRemovableWorktree(repo, worktree);
  if (steps.save !== false) await commitDirtyWork(worktree, branch);
  if (await moveWorktreeToTrash(worktree)) {
    must(await git(["worktree", "prune"], repo, { timeoutMs: WRITE_TIMEOUT_MS }), "git worktree prune failed");
    return;
  }
  must(await git(["worktree", "remove", "--force", worktree], repo, { timeoutMs: WRITE_TIMEOUT_MS }), "git worktree remove failed");
}
