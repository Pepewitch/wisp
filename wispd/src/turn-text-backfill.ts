/**
 * Index the prose of turns that ended before this feature existed.
 *
 * A migration cannot do this: it would read thousands of log files inside the
 * transaction that starts the daemon, and a Wisp home with a year of history
 * would take minutes to boot. So it is background work in the shape
 * archive-worker.ts already establishes — resumable by construction, because
 * "indexed" is a row in `turn_texts` rather than a cursor: whatever a crash
 * interrupted is simply still missing next time.
 *
 * Newest turns first. A search is far likelier to be looking for last week's
 * work than for a task from March, so the index becomes useful immediately
 * instead of after the whole history is walked.
 *
 * While it runs, search says so (`GET /api/search` carries `indexing`), and
 * the sidebar prints one muted line. A partial index that presents itself as a
 * whole one is the dishonesty this whole feature exists to avoid.
 */
import type { AdapterDef } from "./adapters";
import { homeIsDraining, trackHomeWork } from "./home-lifetime";
import { db } from "./store-database";
import { indexTurnProse, TURN_TEXT_PROSE } from "./turn-texts";

/** Turns per pass. Small enough that a shutdown never waits on the backfill. */
const BATCH = 25;
/** Between passes: the daemon answers requests while this runs, not after. */
const PAUSE_MS = 25;
/** A status read is per keystroke at worst, so it is cached for a beat. */
const STATUS_CACHE_MS = 1000;

interface PendingTurn {
  id: number;
  task_id: string;
  log_file: string;
  result: string | null;
  harness: string | null;
}

export interface TurnTextIndexStatus {
  /** settled turns whose prose is not indexed yet */
  remaining: number;
}

let working: Promise<void> | null = null;
let cached: { at: number; remaining: number } | null = null;

/**
 * A settled turn with no prose row. `status <> 'running'` is the whole guard:
 * a live turn's log is still being written, and finalizeTurn indexes it the
 * moment it settles.
 */
function pendingQuery(select: string, limit?: number): string {
  return `SELECT ${select}
     FROM turns n
     LEFT JOIN turn_texts x ON x.turn_id = n.id AND x.kind = '${TURN_TEXT_PROSE}'
     WHERE x.turn_id IS NULL AND n.status <> 'running'
     ORDER BY n.id DESC${limit === undefined ? "" : ` LIMIT ${limit}`}`;
}

export function pendingProseTurns(limit = BATCH): PendingTurn[] {
  return db.query(pendingQuery("n.id, n.task_id, n.log_file, n.result, n.harness", limit)).all() as PendingTurn[];
}

export function countPendingProseTurns(): number {
  const row = db.query(`SELECT COUNT(*) AS n FROM (${pendingQuery("n.id")})`).get() as { n: number };
  return row.n;
}

/** What a client is told. Cached for a beat: a burst of keystrokes is one answer. */
export function turnTextIndexStatus(): TurnTextIndexStatus {
  const now = Date.now();
  if (cached && now - cached.at < STATUS_CACHE_MS) return { remaining: cached.remaining };
  const remaining = countPendingProseTurns();
  cached = { at: now, remaining };
  return { remaining };
}

/** Forget the cached count — after indexing, the number a client sees is stale. */
function invalidateStatus(): void {
  cached = null;
}

/**
 * Index until nothing is pending, or until the home starts draining. One
 * worker: this is catch-up work, not the critical path, and two would only
 * contend for the same disk.
 */
export function backfillTurnTexts(adapters: Record<string, AdapterDef>): Promise<void> {
  if (working) return working;
  working = (async () => {
    for (;;) {
      if (homeIsDraining()) return;
      const batch = pendingProseTurns();
      if (batch.length === 0) return;
      for (const turn of batch) {
        if (homeIsDraining()) return;
        try {
          await indexTurnProse({
            turnId: turn.id,
            taskId: turn.task_id,
            logFile: turn.log_file,
            result: turn.result,
            def: turn.harness === null ? undefined : adapters[turn.harness],
          });
        } catch (error) {
          // A row is written even for an unreadable log, so reaching here means
          // something unexpected. Reporting it and moving on is right: one bad
          // turn must not park the whole history.
          console.error(`[wisp] prose backfill turn ${turn.id}: ${error instanceof Error ? error.message : String(error)}`);
          return;
        }
      }
      invalidateStatus();
      await Bun.sleep(PAUSE_MS);
    }
  })().finally(() => {
    working = null;
    invalidateStatus();
  });
  return working;
}

export function kickTurnTextBackfill(adapters: Record<string, AdapterDef>): void {
  void trackHomeWork(backfillTurnTexts(adapters)).catch((error: unknown) =>
    console.error(`[wisp] prose backfill: ${error instanceof Error ? error.message : String(error)}`),
  );
}

/**
 * Start catching up, and keep an eye out for turns no finalize wrote a row for
 * — a daemon killed mid-turn leaves one behind, and the next pass adopts it.
 */
export function startTurnTextBackfillLoop(adapters: Record<string, AdapterDef>): ReturnType<typeof setInterval> {
  const timer = setInterval(() => kickTurnTextBackfill(adapters), 60_000);
  timer.unref();
  kickTurnTextBackfill(adapters);
  return timer;
}
