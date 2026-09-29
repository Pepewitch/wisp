/**
 * The in-process half of the benchmark: seed a synthetic home through the
 * store's own writers, then measure the SQLite paths on it. Run by run.ts as a
 * child process, because the daemon's paths are bound to WISP_HOME when its
 * modules load. Prints one JSON object on stdout.
 *
 * Query plans are taken from the statements the real functions run, recorded
 * as they prepare them, so a rewritten query is checked as written rather than
 * through a copy of its SQL here.
 */
import type { Database } from "bun:sqlite";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertBenchHome, median, text, type Measurement } from "./shared";

interface SeedPlan {
  repo: string;
  base: string;
  /** one existing worktree per live task, in order */
  worktrees: string[];
  archived: number;
  turns: number;
  /** bytes of the transcript written for the first live task's latest turn */
  transcriptBytes: number;
}

const plan = JSON.parse(process.argv[2] ?? "null") as SeedPlan;
assertBenchHome(process.env.WISP_HOME);

const { LOG_DIR } = await import("../wispd/src/config");
const { acquireHomeOwnership } = await import("../wispd/src/home-lock");
const store = await import("../wispd/src/store");
const storeDatabase = await import("../wispd/src/store-database");
const { putTurnText, TURN_TEXT_PROSE } = await import("../wispd/src/turn-texts");
const search = await import("../wispd/src/store-search");

const ownership = acquireHomeOwnership();
store.initializeStore();
const db = storeDatabase.db;

function transcript(bytes: number): string {
  const lines = [JSON.stringify({ type: "system", subtype: "init", session_id: "bench", model: "bench-model" })];
  let size = 0;
  for (let i = 0; size < bytes; i++) {
    const line = JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: `step ${i} ${text(400)}` }] } });
    lines.push(line);
    size += line.length + 1;
  }
  lines.push(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "done", session_id: "bench" }));
  return `${lines.join("\n")}\n`;
}

function seedTask(id: string, worktree: string | null): void {
  store.createTask({ id, title: `Bench task ${id} ${text(30)}`, repo_path: plan.repo, harness: "claude", model: "opus", slot: store.freeSlot() });
  for (let n = 1; n <= plan.turns; n++) {
    const log = join(LOG_DIR, `${id}-turn${n}.out.log`);
    const turnId = store.createTurn(id, n, text(200 + (n * 97) % 1500), null, log);
    store.finishTurn(turnId, "done", 0, text(200 + (n * 131) % 3000));
    const prose = text(400 + (n * 389) % 12_000);
    putTurnText({ turn_id: turnId, kind: TURN_TEXT_PROSE, task_id: id, text: prose, bytes: prose.length, state: "complete" });
  }
  store.setTaskFields(id, worktree === null
    ? { archived: 1, turn_count: plan.turns }
    : { worktree_path: worktree, branch: `wisp/${id}`, base_commit: plan.base, turn_count: plan.turns });
  store.transition(id, "done", `turn ${plan.turns}`);
}

const seedStarted = performance.now();
db.transaction(() => {
  for (let i = 0; i < plan.archived; i++) seedTask(`arch${i}`, null);
  plan.worktrees.forEach((worktree, i) => seedTask(`live${i}`, worktree));
})();
writeFileSync(join(LOG_DIR, `live0-turn${plan.turns}.out.log`), transcript(plan.transcriptBytes));
const seedMs = performance.now() - seedStarted;

/** Every statement `fn` prepares, in order. */
function statementsOf(fn: () => unknown): string[] {
  const seen: string[] = [];
  const query = db.query;
  db.query = ((sql: string) => {
    seen.push(sql);
    return query.call(db, sql);
  }) as typeof db.query;
  try {
    fn();
  } finally {
    db.query = query;
  }
  return seen.filter((sql) => /^\s*(SELECT|WITH)\b/i.test(sql));
}

/** A full-table (or full-index) walk; a table reached through a key is a SEARCH. */
function scansIn(sql: string): { scans: number; plan: string[] } {
  const rows = db.query(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[];
  const plan = rows.map((row) => row.detail);
  return { scans: plan.filter((detail) => /^SCAN /.test(detail) && detail !== "SCAN CONSTANT ROW").length, plan };
}

function planCase(name: string, fn: () => unknown): Measurement {
  const statements = statementsOf(fn);
  if (statements.length === 0) throw new Error(`${name}: recorded no statements; the function no longer queries through db.query`);
  const plans = statements.map(scansIn);
  return {
    name: `plan.${name}.scans`,
    value: plans.reduce((sum, p) => sum + p.scans, 0),
    unit: "scans",
    detail: plans.map((p) => p.plan.join(" | ")).join(" || "),
  };
}

// searchTasks takes its connection as an argument once search moves off the
// request thread; before that the extra argument is ignored and it uses this
// same connection.
const searchTasks = search.searchTasks as (query: string, database: Database) => { tasks: unknown[] };
const MISS = "zzqxv-no-such-text";

const results: Measurement[] = [
  planCase("runningTurns", () => store.runningTurns()),
  planCase("runningTurnForTask", () => store.runningTurn("live0")),
  planCase("taskList", () => store.listTasksWithLatestTurn(false, false)),
  planCase("search", () => searchTasks(MISS, db)),
  { name: "time.db.searchMissMs", value: median(() => searchTasks(MISS, db)), unit: "ms", informational: true },
  { name: "time.db.seedMs", value: Math.round(seedMs), unit: "ms", informational: true },
];

ownership.release();
console.log(JSON.stringify(results));
