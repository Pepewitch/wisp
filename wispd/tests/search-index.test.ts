/**
 * The trigram indexes behind search (migration-search-index.ts). What matters
 * is that they change nothing a person sees: every query answers exactly what
 * the scan answered, and the triggers keep the indexes equal to their tables
 * through inserts, updates, upserts and deletes.
 */
import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { taskMessageAttachmentsFingerprint } from "../src/attachments";
import { migrate } from "../src/migrations";
import { trigramAvailable } from "../src/migration-search-index";
import { createTask, createTaskMessage, createTurn, db, finishTurn, freeSlot, newTaskId, newTaskMessageId, transition } from "../src/store";
import { searchTasks } from "../src/store-search";
import { putTurnText, TURN_TEXT_PROSE } from "../src/turn-texts";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function task(title: string): string {
  const id = newTaskId();
  createTask({ id, title, repo_path: "/tmp/repo", harness: "fake", model: null, slot: freeSlot() });
  return id;
}

function turn(taskId: string, n: number, prompt: string, result: string | null, prose?: string): number {
  const turnId = createTurn(taskId, n, prompt, null, `/tmp/logs/${taskId}-${n}.jsonl`);
  if (result !== null) finishTurn(turnId, "done", 0, result);
  if (prose !== undefined) putTurnText({ turn_id: turnId, kind: TURN_TEXT_PROSE, task_id: taskId, text: prose, bytes: prose.length, state: "complete" });
  return turnId;
}

/** The same database with the indexes gone: the scan's answer, to hold the index's to. */
function scanned(): Database {
  const dir = mkdtempSync(join(tmpdir(), "wisp-search-scan-"));
  dirs.push(dir);
  db.query("VACUUM INTO ?").run(join(dir, "copy.db"));
  const copy = new Database(join(dir, "copy.db"));
  copy.exec(UNINDEX);
  return copy;
}

/** Everything migration 34 adds, so a database can stand for one from before it. */
const UNINDEX = `DROP TRIGGER search_turns_insert; DROP TRIGGER search_turns_delete; DROP TRIGGER search_turns_update;
  DROP TRIGGER search_prose_insert; DROP TRIGGER search_prose_delete; DROP TRIGGER search_prose_update;
  DROP TABLE search_turns; DROP TABLE search_prose; DROP VIEW search_prose_rows;`;

function integrity(): void {
  // rank 1 also compares the index with its external content
  db.exec("INSERT INTO search_turns(search_turns, rank) VALUES ('integrity-check', 1)");
  db.exec("INSERT INTO search_prose(search_prose, rank) VALUES ('integrity-check', 1)");
}

describe("search through the trigram index", () => {
  test("this SQLite has the trigram tokenizer, and the test database has the indexes", () => {
    expect(trigramAvailable(db)).toBe(true);
    expect(db.query("SELECT name FROM sqlite_master WHERE name IN ('search_turns', 'search_prose') ORDER BY name").all()).toEqual([
      { name: "search_prose" },
      { name: "search_turns" },
    ]);
  });

  test("answers exactly what the scan answers, query by query", () => {
    const a = task("Index parity: the café run");
    turn(a, 1, "Rename the HTTP router to Gateway", "Renamed 4 files; the GATEWAY is live", "First I'll look at router.ts, then\nupdate the gateway tests");
    turn(a, 2, "100% of the rows? use a_b and c\\d", null, "Quoting \"the gateway\" exactly: 50% done");
    turn(a, 3, "Summarise CAFÉ and naïve résumé", "Done: café, naive, RESUME 🚀 shipped", "Straße and STRASSE differ; 🚀🚀 twice");
    const b = task("Another task about routers");
    turn(b, 1, "router router ROUTER", "one router", "the router again");
    // a result that changes after the turn settled, prose written twice (an upsert), and a deleted task
    const changed = turn(b, 2, "first prompt", "an early answer", "early prose");
    db.run("UPDATE turns SET result = ? WHERE id = ?", ["a later answer about kiwis", changed]);
    putTurnText({ turn_id: changed, kind: TURN_TEXT_PROSE, task_id: b, text: "rewritten prose about kiwis", bytes: 27, state: "complete" });
    const gone = task("Deleted task");
    turn(gone, 1, "a gateway that is gone", "gateway gone", "gone gateway prose");
    db.run("DELETE FROM tasks WHERE id = ?", [gone]);
    createTaskMessage({ id: newTaskMessageId(), taskId: a, text: "steer: check the gateway", attachmentHash: taskMessageAttachmentsFingerprint([]) });
    transition(a, "done", "ok");
    integrity();

    const scan = scanned();
    const queries = [
      "gateway", "GATEWAY", "GaTeWaY", "router", "rou", "ro", "r", "the ",
      "café", "CAFÉ", "naïve", "résumé", "RESUME", "straße", "STRASSE", "🚀", "🚀🚀", "ship",
      "100%", "50% d", "a_b", "c\\d", "\"the gateway\"", "\"", "early", "kiwis", "later answer",
      "gone", "zzqxv-no-such-text", "\nupdate", "then\nupd",
      // the longest query the route takes, nearly every trigram distinct, quotes included
      Array.from({ length: 200 }, (_, i) => String.fromCharCode(33 + ((i * 7) % 94))).join(""),
    ];
    try {
      for (const query of queries) {
        expect({ query, answer: searchTasks(query, db) }).toEqual({ query, answer: searchTasks(query, scan) });
      }
    } finally {
      scan.close();
      // other files' searches share this database
      db.run("DELETE FROM tasks WHERE id IN (?, ?)", [a, b]);
      integrity();
    }
  });

  test("reads turns and prose through the index for three characters or more, and scans below that", () => {
    const statements: string[] = [];
    const query = db.query;
    db.query = ((sql: string) => {
      statements.push(sql);
      return query.call(db, sql);
    }) as typeof db.query;
    try {
      searchTasks("gat", db);
      expect(statements.filter((sql) => / MATCH \?/.test(sql))).toHaveLength(2);
      statements.length = 0;
      searchTasks("ga", db);
      expect(statements.filter((sql) => / MATCH \?/.test(sql))).toHaveLength(0);
    } finally {
      db.query = query;
    }
    const plan = (db.query(`EXPLAIN QUERY PLAN SELECT n.id FROM turns n WHERE n.id IN (SELECT rowid FROM search_turns WHERE search_turns MATCH ?)`).all("\"gat\"") as { detail: string }[]).map((row) => row.detail);
    expect(plan.join(" | ")).toContain("SEARCH n USING INTEGER PRIMARY KEY");
    expect(plan.join(" | ")).toContain("VIRTUAL TABLE INDEX 0:M");
  });
});

describe("the search-index migration", () => {
  test("indexes the turns and prose an existing home already has", () => {
    const dir = mkdtempSync(join(tmpdir(), "wisp-search-index-"));
    dirs.push(dir);
    const home = new Database(join(dir, "wisp.db"), { create: true });
    migrate(home);
    // the shape migration 33 left: no index, rows already written
    home.exec(`${UNINDEX} DELETE FROM schema_migrations WHERE id = 34`);
    home.exec(`INSERT INTO tasks (id, title, repo_path, harness, state, created_at, updated_at) VALUES ('tolder', 'fixture', '/fixture', 'fake', 'done', 'now', 'now')`);
    home.exec(`INSERT INTO turns (task_id, n, prompt, result, status, log_file, started_at) VALUES ('tolder', 1, 'an older prompt', 'an older result', 'done', '/fixture/log', 'now')`);
    const turnId = (home.query("SELECT id FROM turns").get() as { id: number }).id;
    home.query(`INSERT INTO turn_texts (turn_id, kind, task_id, text, bytes, state, indexed_at) VALUES (?, 'prose', 'tolder', 'older prose', 11, 'complete', 'now')`).run(turnId);

    expect(migrate(home).applied).toEqual([34]);
    expect(home.query("SELECT rowid FROM search_turns WHERE search_turns MATCH ?").all("\"RES\"")).toEqual([{ rowid: turnId }]);
    expect(home.query("SELECT rowid FROM search_prose WHERE search_prose MATCH ?").all("\"pro\"")).toEqual([{ rowid: turnId }]);
    expect(searchTasks("older", home).tasks.map((hit) => hit.snippets.map((snippet) => snippet.kind))).toEqual([["prompt", "result", "prose"]]);
    home.close();
  });
});
