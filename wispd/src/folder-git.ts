import { git } from "./git-run";

/**
 * What Git knows about a project folder: a repository with at least one commit
 * (`repo`), a repository with none yet (`unborn`), or nothing at all (`none`).
 * Only `repo` can host a worktree task, which forks from a commit.
 *
 * A folder inside another repository answers for that repository, the same
 * way git itself does: it is a subfolder of a checkout, not a plain folder.
 */
export type FolderGit = "repo" | "unborn" | "none";

export async function folderGit(path: string): Promise<FolderGit> {
  if (!(await git(["rev-parse", "--git-dir"], path)).ok) return "none";
  return (await git(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], path)).ok ? "repo" : "unborn";
}

/** The muted sentence a local task in a non-Git folder shows where its changes would be. */
export function plainFolderReason(state: Exclude<FolderGit, "repo">): string {
  return state === "unborn"
    ? "This folder's Git repository has no commits yet, so Wisp shows no changes for this task. Make a first commit to track changes."
    : "This folder is not a Git repository, so Wisp shows no changes for this task. Initialize Git on the project to track changes.";
}
