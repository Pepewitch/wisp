import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, sep } from "node:path";
import { TASKS_DIR, WISP_HOME } from "./config";
import { MAX_OUTPUT_IMAGE_BYTES, OutputError } from "./outputs";
import { getTask, getTurn } from "./store";

function realOrNull(path: string | null | undefined): string | null {
  if (!path) return null;
  try { return realpathSync(path); } catch { return null; }
}

function within(path: string, root: string | null): boolean {
  return root !== null && (path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`));
}

/**
 * Read an image file a harness reported the agent just viewed, for harnesses
 * whose events name a path instead of carrying bytes. The rule, applied to the
 * fully resolved path (symlinks followed first, then checked):
 *
 *  - inside the task's worktree, or the task's own Wisp directory (its
 *    attachments and outputs), is allowed;
 *  - inside the OS temp directory or `/tmp` is allowed, unless it is also
 *    inside the Wisp home: a home under the temp directory must not open the
 *    rest of the home (config, token, other tasks) through that root;
 *  - everything else is refused, including the rest of the Wisp home.
 *
 * Only a regular file within the per-image cap is read; the caller's
 * publication sniffs the bytes and applies the per-turn caps. Call it only
 * while the harness reports the view: a file read later cannot show what the
 * step saw.
 */
export function readViewedImage(turnId: number, path: string): Uint8Array {
  if (!isAbsolute(path)) throw new OutputError("the image path is not absolute");
  const real = realOrNull(path);
  if (!real) throw new OutputError("the image file was not found");
  const turn = getTurn(turnId);
  const task = turn ? getTask(turn.task_id) : null;
  if (!task) throw new OutputError("no such task", 404);
  const owned = within(real, realOrNull(task.worktree_path)) || within(real, realOrNull(join(TASKS_DIR, task.id)));
  const temporary = [tmpdir(), "/tmp"].some((root) => within(real, realOrNull(root))) && !within(real, realOrNull(WISP_HOME));
  if (!owned && !temporary) throw new OutputError("the image is outside the task's worktree, its Wisp files and the temp directory", 403);
  let fd: number;
  try { fd = openSync(real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch { throw new OutputError("the image file could not be opened"); }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new OutputError("the image path is not a regular file");
    if (stat.size > MAX_OUTPUT_IMAGE_BYTES) throw new OutputError("output image exceeds the 8 MiB limit", 413);
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (read === 0) break;
      offset += read;
    }
    return bytes.subarray(0, offset);
  } finally { closeSync(fd); }
}

/**
 * Whether what `path` names changed after `at`, for a file copied after the
 * fact (a followed log, logged-images.ts): the file written or renamed over,
 * or the link or any folder on the way to it replaced or relinked, up to the
 * place it is allowed to be in. Conservative: a folder that merely gained a
 * file since then counts too, and the image is then not captured.
 */
export function viewedPathChangedAfter(turnId: number, path: string, at: number): boolean {
  const target = statSync(path);
  if (Math.max(target.mtimeMs, target.ctimeMs) > at) return true;
  const turn = getTurn(turnId);
  const task = turn ? getTask(turn.task_id) : null;
  const roots = new Set<string>();
  for (const root of [task?.worktree_path, task ? join(TASKS_DIR, task.id) : null, tmpdir(), "/tmp"]) {
    if (!root) continue;
    roots.add(root);
    const real = realOrNull(root);
    if (real) roots.add(real);
  }
  for (let current = path; ; current = dirname(current)) {
    if (lstatSync(current).ctimeMs > at) return true;
    const parent = dirname(current);
    if (parent === current || roots.has(parent)) return false;
  }
}
