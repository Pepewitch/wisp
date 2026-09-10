import { lstatSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { archiveCleanup } from "./archive-jobs";
import { LOG_DIR, turnLogSettings, type WispConfig } from "./config";
import { emit } from "./events";
import { homeIsDraining, trackHomeWork } from "./home-lifetime";
import { db, getTask, turnForTask } from "./store";
import { acquireTaskRetention } from "./task-retention";
import { assertTaskProcessesEnded } from "./task-processes";
import { getTurnText } from "./turn-texts";
import { transcriptReadActive, TRANSCRIPT_EVICTED_NOTICE } from "./transcript-access";
import type { Turn } from "./types";

const BATCH = 100;
type RetentionTurn = Pick<Turn, "id" | "task_id" | "n" | "log_file" | "capture_state" | "capture_detail" | "status">;
interface LogGroup { turn: RetentionTurn; bytes: number; mtimeMs: number; paths: string[] }
export interface TurnLogRetentionResult { evicted: number; reclaimedBytes: number; retainedBytes: number; failed: number }

/** Only the runner's exact, flat managed names. Never follow directory or file symlinks. */
function logGroup(turn: RetentionTurn): LogGroup | null {
  const out = join(LOG_DIR, `${turn.task_id}-turn${turn.n}.out.log`);
  if (resolve(turn.log_file) !== resolve(out) || !lstatSync(LOG_DIR).isDirectory()) return null;
  const paths: string[] = [];
  let bytes = 0, mtimeMs = 0;
  for (const path of [out, out.replace(/\.out\.log$/, ".err.log")]) {
    try {
      const stat = lstatSync(path);
      if (!stat.isFile()) return null;
      paths.push(path); bytes += stat.size; mtimeMs = Math.max(mtimeMs, stat.mtimeMs);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const unfinished = turn.capture_state === "evicted" && turn.capture_detail?.includes("File removal pending");
  return paths.length || unfinished ? { turn, bytes, mtimeMs, paths } : null;
}

async function archivedLogs(): Promise<LogGroup[]> {
  const groups: LogGroup[] = [];
  let cursor = 0;
  for (;;) {
    if (homeIsDraining()) return groups;
    const batch = db.query(`SELECT n.id, n.task_id, n.n, n.log_file, n.capture_state, n.capture_detail, n.status
      FROM turns n JOIN tasks t ON t.id = n.task_id
      WHERE t.archived = 1 AND n.status <> 'running' AND n.id > ? ORDER BY n.id LIMIT ?`).all(cursor, BATCH) as RetentionTurn[];
    if (!batch.length) return groups;
    for (const turn of batch) {
      cursor = turn.id;
      try { const group = logGroup(turn); if (group) groups.push(group); }
      catch (error) { console.error(`[wisp] turn-log scan ${turn.id}: ${String(error)}`); }
    }
    await Bun.sleep(25);
  }
}

function eligible(turn: RetentionTurn): boolean {
  const task = getTask(turn.task_id);
  return Boolean(task?.archived && !task.purge_pending && !archiveCleanup(task.id) &&
    turn.status !== "running" && !transcriptReadActive(turn.id) && getTurnText(turn.id)?.state === "complete");
}

/** No await between the final safety check, durable eviction intent, and whole-turn removal. */
function removeGroup(group: LogGroup, detail: string): number {
  const turn = turnForTask(group.turn.task_id, group.turn.n);
  if (!turn || !eligible(turn)) return 0;
  const current = logGroup(turn);
  if (!current || current.bytes !== group.bytes || current.mtimeMs !== group.mtimeMs) return 0;
  // A crash after unlink must never leave a turn claiming its log is complete.
  // An evicted row with surviving files is retried by the next scan.
  db.run("UPDATE turns SET capture_state = 'evicted', capture_detail = ? WHERE id = ?",
    [`${TRANSCRIPT_EVICTED_NOTICE} File removal pending; ${detail}`, turn.id]);
  let removed = 0;
  try {
    for (const path of current.paths) {
      const bytes = lstatSync(path).size;
      unlinkSync(path);
      removed += bytes;
    }
    db.run("UPDATE turns SET captured_bytes = 0, capture_detail = ? WHERE id = ?", [`${TRANSCRIPT_EVICTED_NOTICE} ${detail}`, turn.id]);
  } finally {
    const task = getTask(turn.task_id)!;
    emit({ type: "task", taskId: task.id, state: task.state, stateDetail: task.state_detail, seq: task.seq });
  }
  return removed;
}

let working: Promise<TurnLogRetentionResult> | null = null;
export function retainTurnLogs(cfg: WispConfig, now = Date.now()): Promise<TurnLogRetentionResult> {
  if (working) return working;
  working = retentionPass(cfg, now).finally(() => { working = null; });
  return working;
}

async function retentionPass(cfg: WispConfig, now: number): Promise<TurnLogRetentionResult> {
  const result: TurnLogRetentionResult = { evicted: 0, reclaimedBytes: 0, retainedBytes: 0, failed: 0 };
  const settings = turnLogSettings(cfg);
  if (!settings.enabled || homeIsDraining()) return result;
  const groups = (await archivedLogs()).sort((a, b) => a.mtimeMs - b.mtimeMs || a.turn.id - b.turn.id);
  result.retainedBytes = groups.reduce((n, g) => n + g.bytes, 0);
  for (const group of groups) {
    if (homeIsDraining()) break;
    const expired = group.mtimeMs < now - settings.retentionMs;
    if (!expired && result.retainedBytes <= settings.maxBytes && group.turn.capture_state !== "evicted") continue;
    if (!eligible(group.turn)) continue;
    const release = acquireTaskRetention(group.turn.task_id);
    if (!release) continue;
    try {
      await assertTaskProcessesEnded(group.turn.task_id);
      if (homeIsDraining()) break;
      const bytes = removeGroup(group, expired ? "Retention age expired." : "Archived turn-log quota exceeded.");
      if (bytes || (group.bytes === 0 && turnForTask(group.turn.task_id, group.turn.n)?.capture_state === "evicted")) result.evicted++;
      result.reclaimedBytes += bytes; result.retainedBytes -= bytes;
    } catch (error) {
      result.failed++;
      console.error(`[wisp] turn-log retention ${group.turn.id}: ${String(error)}`);
    } finally { release(); }
    await Bun.sleep(25);
  }
  return result;
}

/** Resumable, single-flight maintenance after listening; shutdown waits for the current turn. */
export function startTurnLogRetentionLoop(cfg: WispConfig): ReturnType<typeof setInterval> {
  const kick = () => {
    void trackHomeWork(retainTurnLogs(cfg)).catch(error => console.error(`[wisp] turn-log retention: ${String(error)}`));
  };
  const timer = setInterval(kick, 60_000);
  timer.unref();
  kick();
  return timer;
}
