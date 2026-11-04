/**
 * Where removed worktrees go to be deleted.
 *
 * Archive cleanup used to delete a worktree with `git worktree remove --force`,
 * under the 120-second deadline every git write carries. A large monorepo
 * worktree, node_modules included, is a few hundred thousand entries, and on a
 * machine whose filesystem is slow to unlink (seen at about 470 entries a
 * second, the process blocked on the filesystem, not busy) that delete does not
 * fit. The deadline killed it halfway, five attempts later the cleanup needed
 * attention, and six tasks in one morning left 11 GB stranded on a nearly full
 * disk. A longer deadline would only move the cliff, and hold one of the two
 * cleanup workers for minutes while it waited.
 *
 * So removal comes in two halves. The cleanup step renames the worktree into
 * this directory, which is instant and atomic because the trash sits inside the
 * worktree root and so on the same volume, then prunes git's admin entry. The
 * bytes are deleted here, in the background: one entry at a time, with no
 * deadline, and resumable, because a sweep runs at every daemon start. A
 * shutdown is free to abandon a sweep halfway.
 */
import { chmod, lstat, mkdir, readdir, rename, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { WORKTREE_ROOT } from "./config";
import { TRASH_DIR_NAME } from "./worktree-trash-name";

export const TRASH_ROOT = join(WORKTREE_ROOT, TRASH_DIR_NAME);
/** Retries an entry that failed to delete; a sweep with nothing to do is one readdir. */
const SWEEP_INTERVAL_MS = 60_000;

/**
 * Move a directory into the trash. Returns where it went, or null when a rename
 * cannot do it atomically (another volume), so the caller deletes it the old way.
 */
export async function moveToTrash(path: string): Promise<string | null> {
  await mkdir(TRASH_ROOT, { recursive: true, mode: 0o700 });
  const target = join(TRASH_ROOT, `${basename(path)}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  try {
    await rename(path, target);
    return target;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EXDEV") return null;
    throw error;
  }
}

let sweeping: Promise<void> | null = null;
let again = false;
/** Entries whose failure was already logged, so a stuck one logs once, not every minute. */
const reported = new Set<string>();

/**
 * Delete everything in the trash. Single-flight: a call during a sweep asks
 * that sweep to look again when it finishes, and resolves with it.
 */
export function sweepTrash(): Promise<void> {
  if (sweeping) {
    again = true;
    return sweeping;
  }
  sweeping = (async () => {
    do {
      again = false;
      await sweepOnce();
    } while (again);
  })().finally(() => { sweeping = null; });
  return sweeping;
}

async function sweepOnce(): Promise<void> {
  let names: string[];
  try {
    names = await readdir(TRASH_ROOT);
  } catch {
    return; // no trash yet
  }
  for (const name of names) {
    const path = join(TRASH_ROOT, name);
    try {
      await purge(path);
      reported.delete(name);
    } catch (error) {
      if (reported.has(name)) continue;
      reported.add(name);
      console.error(`[wisp] could not delete ${path} yet; retrying every minute: ${String(error)}`);
    }
  }
}

async function purge(path: string): Promise<void> {
  try {
    await rm(path, { recursive: true, force: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EACCES" && code !== "EPERM") throw error;
    // A read-only directory (Go's module cache makes them) refuses to let its
    // entries be unlinked. The tree is already ours to delete.
    await makeWritable(path);
    await rm(path, { recursive: true, force: true });
  }
}

/** u+rwx on every directory under path. lstat and Dirent never follow a symlink out of the tree. */
async function makeWritable(path: string): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isDirectory()) return;
  await chmod(path, stat.mode | 0o700);
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.isDirectory()) await makeWritable(join(path, entry.name));
  }
}

export function kickTrashSweep(): void {
  void sweepTrash().catch(error => console.error(`[wisp] worktree trash: ${String(error)}`));
}

export function startTrashSweepLoop(): ReturnType<typeof setInterval> {
  const timer = setInterval(kickTrashSweep, SWEEP_INTERVAL_MS);
  timer.unref();
  kickTrashSweep();
  return timer;
}
