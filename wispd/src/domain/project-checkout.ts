/**
 * Which project a creation path belongs to (#412).
 *
 * `wisp new` defaults its repository to the current directory, and inside a
 * task's turn that is the task's own worktree. A task created for that path is
 * keyed to a disposable directory: the project's verification recipe and
 * settings are looked up by the project path and miss, and archiving the
 * calling task removes the directory the new task names as its repository.
 *
 * So a path inside a linked worktree is taken back to the checkout Wisp knows
 * for the same repository: the one whose git common directory is the same.
 */
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { READ_TIMEOUT_MS, runBounded } from "../subprocess";

interface GitDirs {
  gitDir: string;
  commonDir: string;
}

/** Real paths, so a symlinked spelling (macOS `/var` vs `/private/var`) still matches. */
function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

async function gitDirs(path: string): Promise<GitDirs | null> {
  let result;
  try {
    result = await runBounded({
      cmd: ["git", "rev-parse", "--git-dir", "--git-common-dir"],
      cwd: path,
      env: { GIT_TERMINAL_PROMPT: "0" },
      timeoutMs: READ_TIMEOUT_MS,
    });
  } catch {
    return null; // a project directory that no longer exists
  }
  if (result.exitCode !== 0) return null;
  const [gitDir, commonDir] = result.out.trim().split("\n");
  if (!gitDir || !commonDir) return null;
  // either may be printed relative to the directory git ran in
  return { gitDir: real(resolve(path, gitDir)), commonDir: real(resolve(path, commonDir)) };
}

/**
 * The checkout to create a worktree task for, given the path the caller named.
 *
 * `configured` are the projects in config.json; `history` the repositories of
 * live tasks. The path itself is kept when it is a configured project, when it
 * is not inside a linked worktree, or when no known checkout shares its
 * repository. A main checkout wins over a configured linked worktree; a
 * history entry that is itself a linked worktree is never chosen, since that is
 * exactly the mistake being undone.
 */
export async function projectCheckoutFor(
  repoPath: string,
  configured: readonly string[],
  history: readonly string[],
): Promise<string> {
  const target = real(repoPath);
  const pinned = new Set(configured.map(real));
  if (pinned.has(target)) return repoPath;
  const dirs = await gitDirs(target);
  if (!dirs || dirs.gitDir === dirs.commonDir) return repoPath;

  const seen = new Set<string>([target]);
  const candidates: { path: string; configured: boolean }[] = [];
  for (const path of [...configured, ...history]) {
    const key = real(path);
    if (seen.has(key)) continue;
    seen.add(key);
    // the spelling Wisp already uses for it: the recipe and settings are keyed by that
    candidates.push({ path: resolve(path), configured: pinned.has(key) });
  }
  const probed = await Promise.all(candidates.map(async (c) => ({ ...c, dirs: await gitDirs(c.path) })));
  const same = probed.filter((c) => c.dirs?.commonDir === dirs.commonDir);
  const main = same.find((c) => c.dirs?.gitDir === c.dirs?.commonDir);
  return main?.path ?? same.find((c) => c.configured)?.path ?? repoPath;
}
