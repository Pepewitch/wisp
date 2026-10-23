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

async function gitOut(args: string[], cwd: string): Promise<string | null> {
  try {
    const result = await runBounded({ cmd: ["git", ...args], cwd, env: { GIT_TERMINAL_PROMPT: "0" }, timeoutMs: READ_TIMEOUT_MS });
    return result.exitCode === 0 ? result.out.trim() : null;
  } catch {
    return null; // a project directory that no longer exists
  }
}

async function gitDirs(path: string): Promise<GitDirs | null> {
  const out = await gitOut(["rev-parse", "--git-dir", "--git-common-dir"], path);
  const [gitDir, commonDir] = (out ?? "").split("\n");
  if (!gitDir || !commonDir) return null;
  // either may be printed relative to the directory git ran in
  return { gitDir: real(resolve(path, gitDir)), commonDir: real(resolve(path, commonDir)) };
}

/** The checkout among `paths` that shares `commonDir`: a main checkout first, then a configured linked worktree. */
async function sameRepository(
  paths: { path: string; configured: boolean }[],
  commonDir: string,
): Promise<string | null> {
  const probed = await Promise.all(paths.map(async (c) => ({ ...c, dirs: await gitDirs(c.path) })));
  const same = probed.filter((c) => c.dirs?.commonDir === commonDir);
  const main = same.find((c) => c.dirs?.gitDir === c.dirs?.commonDir);
  return main?.path ?? same.find((c) => c.configured)?.path ?? null;
}

/**
 * The checkout to create a worktree task for, given the path the caller named.
 *
 * `configured` are the projects in config.json; `history` the repositories of
 * live tasks. The path itself is kept when it is a configured project, when it
 * is not inside a linked worktree, or when no known checkout shares its
 * repository. Configured projects are tried before task history, and within
 * each a main checkout wins; a history entry that is itself a linked worktree
 * is never chosen, since that is exactly the mistake being undone.
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
  const unseen = (paths: readonly string[], isConfigured: boolean): { path: string; configured: boolean }[] =>
    paths.flatMap((path) => {
      const key = real(path);
      if (seen.has(key)) return [];
      seen.add(key);
      // the spelling Wisp already uses for it: the recipe and settings are keyed by that
      return [{ path: resolve(path), configured: isConfigured }];
    });
  // configured projects first: task history can hold many old repositories,
  // and is only probed when no configured project matches
  return (await sameRepository(unseen(configured, true), dirs.commonDir))
    ?? (await sameRepository(unseen(history, false), dirs.commonDir))
    ?? repoPath;
}

/**
 * The base to hand on once the repository changed from `given` to `checkout`.
 * Branches and tags name the same commit in both, so they are kept as typed;
 * a ref that depends on the directory (`HEAD`, `HEAD~1`, `@`) is pinned to the
 * commit it names where the caller asked, never re-read in the checkout.
 */
export async function baseFromCaller(given: string, checkout: string, base: string | undefined): Promise<string | undefined> {
  if (base === undefined || base.trim() === "" || real(given) === real(checkout)) return base;
  // --end-of-options, as worktree.ts does: guards a ref that starts with "-"
  const commitIn = (dir: string) => gitOut(["rev-parse", "--verify", "--quiet", "--end-of-options", `${base.trim()}^{commit}`], dir);
  const [there, here] = await Promise.all([commitIn(given), commitIn(checkout)]);
  return there && there !== here ? there : base;
}
