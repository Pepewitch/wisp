import { opendir, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, sep } from "node:path";
import type { ProjectEntriesResponse, ProjectEntry } from "../../shared/api/project-entries";
import { ignoredAsks, type IgnoreAsk } from "./project-ignore";

/**
 * One directory of a registered project, for the composer's `@` list.
 *
 * The boundary is the project root, enforced on RESOLVED paths: `dir` is
 * refused when absolute or when it names `..`, and what it resolves to after
 * every symlink is followed must still sit inside the root's own realpath. A
 * symlink inside the listing that leads out of the root is left out the same
 * way, so the list never offers a path the next request would refuse.
 *
 * `.git` is never listed or listable, by name or by a link's real path, nor
 * is anything git ignores (project-ignore.ts: asked in the repository that
 * owns each candidate, submodules included, and failing closed), and tracked
 * files stay listed even when a pattern matches them (git's own rule). A folder git ignores can
 * still be named outright (`dir=node_modules/react`); it is only never
 * offered.
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

/** Lists `dir` under `root`, which the caller has already matched to a registered project; `filter` keeps names containing it. */
export async function listProjectEntries(
  root: string,
  dir: string,
  filter = "",
): Promise<ProjectEntriesResponse | EntriesRefusal> {
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
  // a link to .git passes the containment check above: refuse it by where it lands
  if (inside(join(realRoot, ".git"), realDir)) return { status: 403, error: "dir resolves into .git" };

  const scanned = await scanDirectory(realRoot, realDir, filter.toLowerCase());
  const ignored = await ignoredAsks(scanned.entries.flatMap((entry) => entry.asks));
  const kept = scanned.entries
    .filter((entry) => !entry.asks.some(ignored))
    .map(({ name, kind }): ProjectEntry => ({ name, kind }))
    .sort(compareEntries);
  return {
    project: root,
    dir: rel,
    entries: kept.slice(0, ENTRY_CAP),
    truncated: kept.length > ENTRY_CAP,
    incompleteAfter: scanned.truncated ? SCAN_CAP : null,
  };
}

/**
 * A scanned row, and what git is asked about it (see project-ignore.ts): the
 * entry by its own name in the listed folder, with the trailing `/` that lets
 * `dir/` patterns match a folder; and for a link, also its target, by name in
 * the target's own folder, so a link to `node_modules` is ignored like
 * `node_modules`. A link's own name is asked about as a file, which is what
 * git sees. The entry is left out when ANY answer is "ignored".
 */
type ScannedEntry = ProjectEntry & { asks: IgnoreAsk[] };

function askFor(realPath: string, kind: ProjectEntry["kind"]): IgnoreAsk {
  return { cwd: dirname(realPath), path: kind === "dir" ? `${basename(realPath)}/` : basename(realPath) };
}

function compareEntries(a: ProjectEntry, b: ProjectEntry): number {
  if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
  const folded = a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  return folded !== 0 ? folded : a.name.localeCompare(b.name);
}

/** Every entry read counts toward SCAN_CAP, kept or not: the cap bounds the work, not the answer. */
async function scanDirectory(
  realRoot: string,
  realDir: string,
  filter: string,
): Promise<{ entries: ScannedEntry[]; truncated: boolean }> {
  const entries: ScannedEntry[] = [];
  let examined = 0;
  let truncated = false;
  const handle = await opendir(realDir);
  try {
    for await (const dirent of handle) {
      if (examined >= SCAN_CAP) {
        truncated = true;
        break;
      }
      examined += 1;
      if (dirent.name === ".git" || !dirent.name.toLowerCase().includes(filter)) continue;
      const path = join(realDir, dirent.name);
      const entry = dirent.isSymbolicLink()
        ? await linkEntry(realRoot, path, dirent.name)
        : direntEntry(path, dirent.name, dirent.isDirectory() ? "dir" : dirent.isFile() ? "file" : null);
      if (entry) entries.push(entry);
    }
  } finally {
    // `for await` closes the handle when it runs to the end; a break does not
    await handle.close().catch(() => {});
  }
  return { entries, truncated };
}

function direntEntry(path: string, name: string, kind: ProjectEntry["kind"] | null): ScannedEntry | null {
  return kind ? { name, kind, asks: [askFor(path, kind)] } : null;
}

/** A symlink is listed as what it leads to, and only when that stays inside the project and out of .git. */
async function linkEntry(realRoot: string, path: string, name: string): Promise<ScannedEntry | null> {
  try {
    const target = await realpath(path);
    if (!inside(realRoot, target) || inside(join(realRoot, ".git"), target)) return null;
    const info = await stat(target);
    const kind = info.isDirectory() ? "dir" : info.isFile() ? "file" : null;
    if (!kind) return null;
    // its own name, as the file git sees: `ln -s src build` is ignored by `build`;
    // and where it leads, unless that is the root itself, which nothing ignores
    const asks = [askFor(path, "file"), ...(target === realRoot ? [] : [askFor(target, kind)])];
    return { name, kind, asks };
  } catch {
    return null;
  }
}
