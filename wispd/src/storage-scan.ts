import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";

export interface StorageEntry { path: string; bytes: number; mtimeMs: number; directory: boolean }

/** Logical file bytes, without following symlinks (including directory symlinks). */
export async function scanStorage(path: string, visit?: (entry: StorageEntry) => void): Promise<number> {
  let stat;
  try { stat = await lstat(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0; throw error; }
  if (stat.isSymbolicLink()) return 0;
  if (stat.isDirectory()) {
    let bytes = 0;
    for (const name of await readdir(path)) bytes += await scanStorage(join(path, name), visit);
    visit?.({ path, bytes, mtimeMs: stat.mtimeMs, directory: true });
    return bytes;
  }
  if (!stat.isFile()) return 0;
  visit?.({ path, bytes: stat.size, mtimeMs: stat.mtimeMs, directory: false });
  return stat.size;
}

export function storageBytes(bytes: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let n = bytes, unit = 0;
  while (n >= 1024 && unit < units.length - 1) { n /= 1024; unit++; }
  return `${unit ? n.toFixed(1) : n} ${units[unit]}`;
}

export const DAY_MS = 86_400_000;
export function archivedBefore(value: unknown, now = Date.now()): string {
  if (typeof value !== "string") throw new Error("--archived-before requires Nd or YYYY-MM-DD");
  if (/^[1-9]\d*d$/.test(value)) {
    const time = now - Number(value.slice(0, -1)) * DAY_MS;
    if (Number.isFinite(time) && time >= 0) return new Date(time).toISOString();
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const date = new Date(`${value}T00:00:00.000Z`);
    if (Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value) return date.toISOString();
  }
  throw new Error("--archived-before requires a positive age (30d) or a valid UTC date (YYYY-MM-DD)");
}
