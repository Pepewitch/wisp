import { opendir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import type { ProjectEntriesResponse, ProjectEntry } from "../../shared/api/project-entries";
import { READ_TIMEOUT_MS, runBounded } from "./subprocess";

/**
 * One directory of a registered project, for the composer's `@` list.
 *
 * The boundary is the project root, enforced on RESOLVED paths: `dir` is
 * refused when absolute or when it names `..`, and what it resolves to after
 * every symlink is followed must still sit inside the root's own realpath. A
 * symlink inside the listing that leads out of the root is left out the same
 * way, so the list never offers a path the next request would refuse.
 *
 * `.git` is never listed, nor is anything git ignores: one `git check-ignore
 * --stdin` call per listing answers for every candidate at once, and tracked
 * files stay listed even when a pattern matches them (git's own rule).
 */

/** The most rows one listing serves; the composer shows a handful of them. */
export const ENTRY_CAP = 500;
/** The most directory entries read before filtering, so a huge folder costs a bounded scan. */
export const SCAN_CAP = 5_000;

export type EntriesRefusal = { status: 400 | 403 | 404; error: string };

/** `dir` as path segments, or why it may not be listed. `""` and `"."` are the root. */
export function projectDirSegments(dir: string): string[] | EntriesRefusal {
  if (dir.includes("\0")) return { status: 400, error: "dir may not contain NUL" };
  if (isAbsolute(dir) || dir.startsWith("\\")) return { status: 400, error: "dir must be relative to the project" };
  const segments = dir.split(/[/\\]/).filter((segment) => segment !== "" && segment !== ".");
  if (segments.includes("..")) return { status: 400, error: "dir may not leave the project" };
  if (segments.includes(".git")) return { status: 400, error: "dir may not name .git" };
  return segments;
}

function inside(root: string, path: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

/** Lists `dir` under `root`, which the caller has already matched to a registered project. */
export async function listProjectEntries(root: string, dir: string): Promise<ProjectEntriesResponse | EntriesRefusal> {
  const segments = projectDirSegments(dir);
  if (!Array.isArray(segments)) return segments;
  const rel = segments.join("/");
  let realRoot: string;
  try {
    realRoot = await realpath(root);
  } catch {
    return { status: 404, error: "the project's folder is missing" };
  }
  let realDir: string;
  try {
    realDir = await realpath(join(realRoot, rel));
    if (!(await stat(realDir)).isDirectory()) return { status: 404, error: `not a folder: ${rel}` };
  } catch {
    return { status: 404, error: `no such folder: ${rel}` };
  }
  if (!inside(realRoot, realDir)) return { status: 403, error: "dir resolves outside the project" };

  const scanned = await scanDirectory(realRoot, realDir);
  // git is asked about the folder's real path: through a link it refuses the batch
  const gitRel = relative(realRoot, realDir).split(sep).join("/");
  const ignored = await ignoredPaths(realRoot, scanned.entries.map((entry) => entryPath(gitRel, entry)));
  const kept = scanned.entries
    .filter((entry) => !ignored.has(entryPath(gitRel, entry)))
    .map(({ name, kind }): ProjectEntry => ({ name, kind }))
    .sort(compareEntries);
  return {
    project: root,
    dir: rel,
    entries: kept.slice(0, ENTRY_CAP),
    truncated: scanned.truncated || kept.length > ENTRY_CAP,
  };
}

/** A scanned row; `link` because git sees a symlink as a file whatever it leads to. */
type ScannedEntry = ProjectEntry & { link: boolean };

/**
 * What git is asked about: root-relative, with the trailing `/` that lets
 * `dir/` patterns match a real folder. Never on a link: git answers a path
 * through a symlink with a fatal "beyond a symbolic link", which would fail
 * the whole batch.
 */
function entryPath(rel: string, entry: ScannedEntry): string {
  const path = rel === "" ? entry.name : `${rel}/${entry.name}`;
  return entry.kind === "dir" && !entry.link ? `${path}/` : path;
}

function compareEntries(a: ProjectEntry, b: ProjectEntry): number {
  if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
  const folded = a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  return folded !== 0 ? folded : a.name.localeCompare(b.name);
}

async function scanDirectory(realRoot: string, realDir: string): Promise<{ entries: ScannedEntry[]; truncated: boolean }> {
  const entries: ScannedEntry[] = [];
  let truncated = false;
  const handle = await opendir(realDir);
  try {
    for await (const dirent of handle) {
      if (entries.length >= SCAN_CAP) {
        truncated = true;
        break;
      }
      if (dirent.name === ".git") continue;
      let kind: ProjectEntry["kind"] | null = dirent.isDirectory() ? "dir" : dirent.isFile() ? "file" : null;
      if (dirent.isSymbolicLink()) kind = await linkKind(realRoot, join(realDir, dirent.name));
      if (kind) entries.push({ name: dirent.name, kind, link: dirent.isSymbolicLink() });
    }
  } finally {
    // `for await` closes the handle when it runs to the end; a break does not
    await handle.close().catch(() => {});
  }
  return { entries, truncated };
}

/** A symlink is listed as what it leads to, and only when that stays inside the project. */
async function linkKind(realRoot: string, path: string): Promise<ProjectEntry["kind"] | null> {
  try {
    const target = await realpath(path);
    if (!inside(realRoot, target)) return null;
    const info = await stat(target);
    return info.isDirectory() ? "dir" : info.isFile() ? "file" : null;
  } catch {
    return null;
  }
}

/**
 * The subset of `paths` git ignores, in one process. A folder that is not a
 * git checkout (exit 128), or a git that fails, hides nothing beyond `.git`:
 * the list is a convenience, and an empty one would be the worse answer.
 */
async function ignoredPaths(realRoot: string, paths: string[]): Promise<Set<string>> {
  if (paths.length === 0) return new Set();
  const result = await runBounded({
    cmd: ["git", "check-ignore", "--stdin", "-z"],
    cwd: realRoot,
    env: { GIT_TERMINAL_PROMPT: "0" },
    input: paths.map((path) => `${path}\0`).join(""),
    timeoutMs: READ_TIMEOUT_MS,
  });
  // 0: some are ignored, 1: none are
  if (result.exitCode !== 0 || result.truncated) return new Set();
  return new Set(result.out.split("\0").filter((path) => path !== ""));
}
