import { READ_TIMEOUT_MS, runBounded } from "./subprocess";

/**
 * What Git knows about a project folder: a repository something can fork a
 * worktree from (`repo`), a repository with no commit and no ref at all yet
 * (`unborn`), or a folder git positively says is not a repository (`none`).
 * Only `repo` can host a worktree task.
 *
 * A folder inside another repository answers for that repository, the same
 * way git itself does: it is a subfolder of a checkout, not a plain folder.
 *
 * Plain is never a guess. Only git's own "not a git repository" (in the C
 * locale, so the words are stable) makes a folder `none`, and only a
 * repository with no ref anywhere is `unborn`: a HEAD on an orphan branch
 * still forks from `origin/HEAD` or the project's base branch. Anything git
 * cannot answer — a timeout, `safe.directory` refusing the owner, git missing
 * from PATH — reads as `repo`, which is how Wisp treated every folder before
 * plain folders existed: the task fails later with git's own reason rather
 * than quietly running in place.
 */
export type FolderGit = "repo" | "unborn" | "none";

const GIT_ENV = { GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" };

async function ask(path: string, args: string[]): Promise<{ exitCode: number | null; out: string; err: string }> {
  try {
    const result = await runBounded({ cmd: ["git", ...args], cwd: path, env: GIT_ENV, timeoutMs: READ_TIMEOUT_MS });
    return { exitCode: result.timedOut ? null : result.exitCode, out: result.out.trim(), err: result.err };
  } catch (e) {
    // a spawn that failed (a missing folder, the process limit) is no answer either
    return { exitCode: null, out: "", err: e instanceof Error ? e.message : String(e) };
  }
}

export async function folderGit(path: string): Promise<FolderGit> {
  const dir = await ask(path, ["rev-parse", "--git-dir"]);
  if (dir.exitCode === 128 && /not a git repository/i.test(dir.err)) return "none";
  if (dir.exitCode !== 0) return "repo";
  if ((await ask(path, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"])).exitCode === 0) return "repo";
  const refs = await ask(path, ["for-each-ref", "--count=1", "--format=%(refname)", "refs/heads", "refs/remotes"]);
  return refs.exitCode === 0 && refs.out === "" ? "unborn" : "repo";
}

/** The muted sentence a local task in a non-Git folder shows where its changes would be. */
export function plainFolderReason(state: Exclude<FolderGit, "repo">): string {
  return state === "unborn"
    ? "This folder's Git repository has no commits yet, so Wisp shows no changes for this task. Make a first commit to track changes."
    : "This folder is not a Git repository, so Wisp shows no changes for this task. Initialize Git on the project to track changes.";
}
