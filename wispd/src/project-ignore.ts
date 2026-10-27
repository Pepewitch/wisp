import { READ_TIMEOUT_MS, runBounded } from "./subprocess";

/**
 * What git ignores among one listed folder's entries, for the composer's `@`
 * list: one `git check-ignore --stdin` run FROM that folder, over the
 * entries' names, so git applies the rules of the repository that owns the
 * folder (a submodule's own `.gitignore` inside a submodule). A symlink is
 * asked about by its own name, as the file git sees; where it leads is never
 * asked about.
 *
 * At most two git processes per listing: the check, and, only when it fails,
 * a `rev-parse` that tells a folder outside every repository (no rules, so
 * nothing is hidden) from a repository git could not read. The latter fails
 * the request: a listing is never served unfiltered because git broke.
 */

/** Git could not answer for a folder that is inside a repository. */
export class IgnoreRulesUnreadable extends Error {
  constructor(detail: string) {
    super(detail === "" ? "couldn't read this project's ignore rules" : `couldn't read this project's ignore rules: ${detail}`);
    this.name = "IgnoreRulesUnreadable";
  }
}

export type CheckIgnore = { ok: true; ignored: Set<string> } | { ok: false; detail: string };

/** The two git calls this needs, injectable so the bounds and the failure paths are testable. */
export interface IgnoreGit {
  checkIgnore(cwd: string, paths: string[]): Promise<CheckIgnore>;
  /** true only when git positively says `cwd` is in no repository */
  outsideRepository(cwd: string): Promise<boolean>;
}

/** Cap on the one stderr line a refusal may carry. */
const DETAIL_CAP = 160;

function firstLine(text: string): string {
  const line = text.split("\n").map((part) => part.trim()).find((part) => part !== "") ?? "";
  return line.length > DETAIL_CAP ? `${line.slice(0, DETAIL_CAP)}…` : line;
}

/** The C locale, so "not a git repository" is the sentence matched below. */
const GIT_ENV = { GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" };

async function git(cwd: string, args: string[], input?: string) {
  try {
    return await runBounded({ cmd: ["git", ...args], cwd, env: GIT_ENV, input, timeoutMs: READ_TIMEOUT_MS });
  } catch (e) {
    // a spawn that failed (the process limit, say) is an unanswered question too
    return { exitCode: null, out: "", err: e instanceof Error ? e.message : String(e), truncated: false, timedOut: false, cancelled: false };
  }
}

export const GIT: IgnoreGit = {
  async checkIgnore(cwd, paths) {
    // `./` first, so a name like `:(exclude)x` is a path and not pathspec magic
    // (check-ignore refuses GIT_LITERAL_PATHSPECS); git echoes the prefix back
    const result = await git(cwd, ["check-ignore", "--stdin", "-z"], paths.map((path) => `./${path}\0`).join(""));
    if (result.timedOut) return { ok: false, detail: "git timed out" };
    // 0: some are ignored, 1: none are; anything else is git failing to answer
    if (result.truncated || (result.exitCode !== 0 && result.exitCode !== 1)) return { ok: false, detail: firstLine(result.err) };
    return { ok: true, ignored: new Set(result.out.split("\0").flatMap((path) => (path.startsWith("./") ? [path.slice(2)] : []))) };
  },
  async outsideRepository(cwd) {
    const result = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
    return result.exitCode === 128 && /not a git repository/i.test(result.err);
  },
};

/** The names (as given, `name/` for a folder) git ignores in `folder`; throws IgnoreRulesUnreadable when it cannot say. */
export async function ignoredNames(folder: string, names: string[], ignoreGit: IgnoreGit = GIT): Promise<Set<string>> {
  if (names.length === 0) return new Set();
  const check = await ignoreGit.checkIgnore(folder, names);
  if (check.ok) return check.ignored;
  if (await ignoreGit.outsideRepository(folder)) return new Set();
  throw new IgnoreRulesUnreadable(check.detail);
}
