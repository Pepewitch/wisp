import { open, stat } from "node:fs/promises";

/**
 * Positioned reads so log endpoints never slurp whole files into memory
 * (a prior audit: an uncapped or large log must not become a per-poll OOM).
 * Everything here is async (a prior audit): these run on the daemon's only
 * thread, per log-follow poll, so even capped reads go through fs/promises.
 */

/** existsSync without blocking the event loop. */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** True only for an existing directory (used by project registration). */
export async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** Read up to `max` bytes starting at `start`. `size` is the next read offset. */
export async function readSlice(path: string, start: number, max: number): Promise<{ text: string; size: number }> {
  let fh;
  try {
    fh = await open(path, "r");
  } catch {
    return { text: "", size: start };
  }
  try {
    const fileSize = (await fh.stat()).size;
    const from = Math.max(0, Math.min(start, fileSize));
    const len = Math.max(0, Math.min(max, fileSize - from));
    if (len === 0) return { text: "", size: from };
    const buf = Buffer.alloc(len);
    const { bytesRead } = await fh.read(buf, 0, len, from);
    return { text: buf.toString("utf8", 0, bytesRead), size: from + bytesRead };
  } finally {
    await fh.close();
  }
}

/**
 * readTailOf that also reports the end offset (`size`, same convention as
 * readSlice). Follow-style streaming needs it: the backlog stops exactly at
 * `size`, so the append stream continuing from there has no gap or overlap —
 * a stat-then-read pair would race with a growing log file on both sides.
 */
export async function readTailSlice(path: string, max: number): Promise<{ text: string; size: number }> {
  let fh;
  try {
    fh = await open(path, "r");
  } catch {
    return { text: "", size: 0 };
  }
  try {
    const fileSize = (await fh.stat()).size;
    const from = Math.max(0, fileSize - max);
    const len = fileSize - from;
    if (len === 0) return { text: "", size: from };
    const buf = Buffer.alloc(len);
    const { bytesRead } = await fh.read(buf, 0, len, from);
    return { text: (from > 0 ? "…" : "") + buf.toString("utf8", 0, bytesRead), size: from + bytesRead };
  } finally {
    await fh.close();
  }
}

/** Read at most the last `max` bytes; prefixes "…" when truncated. */
export async function readTailOf(path: string, max: number): Promise<string> {
  return (await readTailSlice(path, max)).text;
}
