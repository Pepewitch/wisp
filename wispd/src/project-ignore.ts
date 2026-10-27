import { READ_TIMEOUT_MS, runBounded } from "./subprocess";

/**
 * What git ignores among a listing's candidates, for the composer's `@` list.
 *
 * Each candidate is asked about from the folder that holds it (`cwd`), by its
 * name there, so git answers with the rules of the repository that OWNS it: a
 * folder inside a submodule gets the submodule's `.gitignore`, and a link's
 * target is asked about where it lives, never through the link (git refuses a
 * path inside a submodule or beyond a symlink with a fatal error).
 *
 * One `git check-ignore --stdin` per folder. When one fails anyway, its
 * candidates are asked one at a time, and one git still cannot answer for is
 * treated as ignored: a lookup that failed never shows what it should have
 * hidden. The single exception is a folder no git work tree contains, where
 * there are no ignore rules at all and nothing beyond `.git` is hidden.
 */

/** One question for git: is `path` (relative to `cwd`; `name/` for a folder) ignored? */
export interface IgnoreAsk {
  cwd: string;
  path: string;
}

/** The two git calls this needs, injectable so the fail-closed path is testable. */
export interface IgnoreGit {
  /** the ignored subset of `paths`, or null when git could not answer (any exit but 0 or 1) */
  checkIgnore(cwd: string, paths: string[]): Promise<Set<string> | null>;
  insideWorkTree(cwd: string): Promise<boolean>;
}

/** Past this many candidates, a failed folder is not retried one by one: all of them are hidden. */
export const RETRY_CAP = 64;

const GIT_ENV = { GIT_TERMINAL_PROMPT: "0" };

export const GIT: IgnoreGit = {
  async checkIgnore(cwd, paths) {
    const result = await runBounded({
      cmd: ["git", "check-ignore", "--stdin", "-z"],
      cwd,
      env: GIT_ENV,
      input: paths.map((path) => `${path}\0`).join(""),
      timeoutMs: READ_TIMEOUT_MS,
    });
    if (result.truncated || result.timedOut || result.cancelled) return null;
    // 0: some are ignored, 1: none are; anything else is git failing to answer
    if (result.exitCode === 1) return new Set();
    if (result.exitCode !== 0) return null;
    return new Set(result.out.split("\0").filter((path) => path !== ""));
  },
  async insideWorkTree(cwd) {
    const result = await runBounded({
      cmd: ["git", "rev-parse", "--is-inside-work-tree"],
      cwd,
      env: GIT_ENV,
      timeoutMs: READ_TIMEOUT_MS,
    });
    return result.exitCode === 0 && result.out.trim() === "true";
  },
};

/** A predicate over the asks: true when git ignores it, or could not say that it does not. */
export async function ignoredAsks(asks: IgnoreAsk[], git: IgnoreGit = GIT): Promise<(ask: IgnoreAsk) => boolean> {
  const byFolder = new Map<string, string[]>();
  for (const { cwd, path } of asks) byFolder.set(cwd, [...(byFolder.get(cwd) ?? []), path]);
  const answers = new Map(
    await Promise.all([...byFolder].map(async ([cwd, paths]) => [cwd, await ignoredIn(cwd, [...new Set(paths)], git)] as const)),
  );
  return (ask) => answers.get(ask.cwd)?.has(ask.path) ?? true;
}

async function ignoredIn(cwd: string, paths: string[], git: IgnoreGit): Promise<Set<string>> {
  const batch = await git.checkIgnore(cwd, paths);
  if (batch) return batch;
  // no repository here: there are no rules to break, so nothing is hidden
  if (!(await git.insideWorkTree(cwd))) return new Set();
  if (paths.length > RETRY_CAP) return new Set(paths);
  const hidden = new Set<string>();
  for (const path of paths) {
    const one = await git.checkIgnore(cwd, [path]);
    if (!one || one.has(path)) hidden.add(path);
  }
  return hidden;
}
