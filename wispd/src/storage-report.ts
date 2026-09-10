import { basename, dirname, join, resolve } from "node:path";
import { readStorageLedger } from "./storage-ledger";
import { archivedBefore, DAY_MS, scanStorage, storageBytes, type StorageEntry } from "./storage-scan";

interface StorageTask {
  id: string; state: string; archived: number; updated_at: string;
  worktree_path: string | null; mode: string | null;
}
interface StorageTurn { id: number; task_id: string; log_file: string }
export interface WorktreeStorage { name: string; bytes: number; taskId: string | null; state: string; orphan: boolean }
export interface StorageReport {
  total: number;
  directories: { name: string; bytes: number }[];
  worktrees: WorktreeStorage[];
  logs: { live: number; archived: number; unknown: number; bytesPerDay: number | null };
  done: { tasks: number; bytes: number };
  purge: { tasks: number; bytes: number; cutoff: string };
}

export async function storageReport(home: string, before = "30d", now = Date.now()): Promise<StorageReport> {
  home = resolve(home);
  const cutoff = archivedBefore(before, now), ledger = await readStorageLedger(join(home, "wisp.db"));
  let tasks: StorageTask[] = [], turns: StorageTurn[] = [];
  try {
    if (ledger) {
      tasks = ledger.query("SELECT id, state, archived, updated_at, worktree_path, mode FROM tasks").all() as StorageTask[];
      turns = ledger.query("SELECT id, task_id, log_file FROM turns").all() as StorageTurn[];
    }
  } finally { ledger?.close(); }
  const taskMap = new Map(tasks.map(t => [t.id, t]));
  const turnMap = new Map(turns.map(t => [t.id, t.task_id]));
  const logMap = new Map(turns.map(t => [resolve(t.log_file), t.task_id]));
  const entries: StorageEntry[] = [];
  const total = await scanStorage(home, entry => entries.push(entry));
  const top = entries.filter(e => dirname(e.path) === home);
  const worktrees = entries.filter(e => e.directory && dirname(e.path) === join(home, "worktrees")).map(e => {
    const name = basename(e.path);
    const task = tasks.find(t => t.worktree_path !== null && resolve(t.worktree_path) === e.path)
      ?? taskMap.get(name.slice(name.lastIndexOf("-") + 1));
    return { name, bytes: e.bytes, taskId: task?.id ?? null,
      state: task?.archived ? "archived" : task?.state ?? "missing", orphan: !task || Boolean(task.archived) };
  }).sort((a, b) => b.bytes - a.bytes);
  const logs = { live: 0, archived: 0, unknown: 0, bytesPerDay: null as number | null };
  let oldest = now, logCount = 0;
  const taskBytes = new Map<string, number>();
  for (const e of entries.filter(e => !e.directory)) {
    const relative = e.path.slice(home.length + 1), parts = relative.split("/");
    let id: string | undefined;
    if (parts[0] === "tasks") id = parts[1];
    if (parts[0] === "diagnostics") id = turnMap.get(Number(/^turn-(\d+)-\d{6}\.jsonl$/.exec(parts[1] ?? "")?.[1]));
    if (parts[0] === "logs") {
      id = logMap.get(e.path) ?? parts[1]?.split("-")[0];
      const task = taskMap.get(id ?? "");
      logs[task ? task.archived ? "archived" : "live" : "unknown"] += e.bytes;
      oldest = Math.min(oldest, e.mtimeMs); logCount++;
    }
    if (id) taskBytes.set(id, (taskBytes.get(id) ?? 0) + e.bytes);
  }
  if (logCount && oldest < now) logs.bytesPerDay = (logs.live + logs.archived + logs.unknown) / ((now - oldest) / DAY_MS);
  const done = tasks.filter(t => !t.archived && t.state === "done" && t.mode !== "local");
  const purge = tasks.filter(t => t.archived && t.updated_at < cutoff);
  return { total, directories: top.map(e => ({ name: basename(e.path) + (e.directory ? "/" : ""), bytes: e.bytes })).sort((a, b) => b.bytes - a.bytes),
    worktrees, logs,
    done: { tasks: done.length, bytes: worktrees.filter(w => done.some(t => t.id === w.taskId)).reduce((sum, w) => sum + w.bytes, 0) },
    purge: { tasks: purge.length, bytes: purge.reduce((sum, t) => sum + (taskBytes.get(t.id) ?? 0), 0), cutoff } };
}

export function formatStorageReport(report: StorageReport): string {
  const row = (name: string, bytes: number) => `  ${storageBytes(bytes).padStart(11)}  ${name}`;
  const tree = (w: WorktreeStorage) => row(`${w.name}  task ${w.taskId ?? "unknown"} · ${w.state}`, w.bytes);
  const orphans = report.worktrees.filter(w => w.orphan);
  return [
    `Wisp storage: ${storageBytes(report.total)} (read-only)`,
    ...report.directories.map(e => row(e.name, e.bytes)),
    "\nLargest worktrees", ...report.worktrees.slice(0, 10).map(tree),
    `\nOrphan worktrees: ${orphans.length}`, ...orphans.map(tree),
    "\nLogs", row("live tasks", report.logs.live), row("archived tasks", report.logs.archived), row("unknown tasks", report.logs.unknown),
    `  Growth estimate: ${report.logs.bytesPerDay === null ? "unavailable (no dated logs)" : `${storageBytes(report.logs.bytesPerDay)}/day`}, retained bytes / age of oldest log mtime`,
    "\nPotential reclaim",
    row(`archive ${report.done.tasks} done worktree tasks (subject to archive safety checks)`, report.done.bytes),
    row(`purge ${report.purge.tasks} archives last updated before ${report.purge.cutoff}`, report.purge.bytes),
    "  Purge excludes worktrees and SQLite pages; incomplete cleanup may refuse deletion.",
    "Logical file bytes; symlinks are not followed. Files may change during the scan.",
  ].join("\n");
}
