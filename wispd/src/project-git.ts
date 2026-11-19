/**
 * "Initialize Git" for a project folder that has none: the one action that
 * turns a plain folder, whose tasks can only run in place, into a repository
 * whose tasks can each have their own worktree.
 *
 * A worktree forks from a commit, so `git init` alone is not enough: the
 * folder's current files become a first commit. Without them, every worktree
 * task would start from an empty tree and never see the files the person
 * added the folder for. The project's own `.gitignore`, when it has one, is
 * honoured by `git add` as usual.
 */
import { realpathSync } from "node:fs";
import { folderGit, type FolderGit } from "./folder-git";
import { git } from "./git-run";

/** Staging and committing a folder of real files can take a while; a hung hook or signer must still end. */
const INIT_TIMEOUT_MS = 120_000;

export type ProjectGitInit =
  | { ok: true; git: FolderGit }
  | { ok: false; status: 409; error: string };

/** First line of git's complaint, so a refusal names the cause without a wall of text. */
function firstLine(text: string): string {
  return text.split("\n").map((line) => line.trim()).find((line) => line !== "") ?? "";
}

export async function initProjectGit(root: string): Promise<ProjectGitInit> {
  try {
    return await initialize(root);
  } catch (error) {
    // git() throws only on its deadline; the folder may be half-done, so say where
    const why = error instanceof Error ? error.message : String(error);
    return { ok: false, status: 409, error: `${why} — check ${root} and finish with git yourself` };
  }
}

async function initialize(root: string): Promise<ProjectGitInit> {
  const before = await folderGit(root);
  if (before === "repo") return { ok: false, status: 409, error: `${root} is already a Git repository with a commit` };
  if (before === "unborn") {
    // `rev-parse` answers for the nearest repository up the tree, which may be
    // a parent folder's. Committing there would commit the parent's files.
    const top = await git(["rev-parse", "--show-toplevel"], root);
    // git prints the real path (macOS /tmp is /private/tmp), so compare real paths
    if (!top.ok || realpathSync(top.out) !== realpathSync(root)) {
      const where = top.ok ? top.out : "a parent folder";
      return { ok: false, status: 409, error: `${root} is inside another Git repository (${where}) — make its first commit there` };
    }
  } else {
    const init = await git(["init"], root);
    if (!init.ok) return { ok: false, status: 409, error: `git init failed: ${firstLine(init.err)}` };
  }
  const add = await git(["add", "-A"], root, { timeoutMs: INIT_TIMEOUT_MS });
  if (!add.ok) return { ok: false, status: 409, error: `Git is initialized, but staging the folder failed: ${firstLine(add.err)}` };
  const commit = await git(["commit", "--allow-empty", "-m", "Initial commit"], root, { timeoutMs: INIT_TIMEOUT_MS });
  if (!commit.ok) {
    return {
      ok: false,
      status: 409,
      error: `Git is initialized, but the first commit failed: ${firstLine(commit.err) || firstLine(commit.out)} — fix that and commit in ${root}`,
    };
  }
  return { ok: true, git: await folderGit(root) };
}
