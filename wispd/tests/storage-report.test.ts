import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { storageReport, formatStorageReport } from "../src/storage-report";
import { archivedBefore, DAY_MS } from "../src/storage-scan";
import { readStorageLedger } from "../src/storage-ledger";

function snapshot(root: string): unknown[] {
  const stat = lstatSync(root);
  return [root, stat.mode, stat.mtimeMs, stat.ctimeMs,
    stat.isDirectory() ? readdirSync(root).sort().map(name => snapshot(join(root, name)))
      : stat.isFile() ? readFileSync(root).toString("base64") : "symlink"];
}
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "wisp-storage-"));
  const db = new Database(join(home, "wisp.db"));
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE tasks (id TEXT, state TEXT, archived INTEGER, updated_at TEXT, worktree_path TEXT, mode TEXT);
    CREATE TABLE turns (id INTEGER, task_id TEXT, log_file TEXT);`);
  const file = (path: string, contents: string) => {
    const full = join(home, path);
    mkdirSync(join(full, ".."), { recursive: true }); writeFileSync(full, contents); return full;
  };
  const now = Date.parse("2026-09-10T00:00:00Z");
  for (const [id, state, archived, bytes] of [["alive", "done", 0, 10], ["closed", "done", 1, 20]] as const) {
    const worktree = join(home, "worktrees", `fixture-${id}`);
    file(`worktrees/fixture-${id}/node_modules/file`, "w".repeat(bytes));
    const log = file(`logs/${id}-turn1.out.log`, "l".repeat(bytes));
    utimesSync(log, (now - 10 * DAY_MS) / 1000, (now - 10 * DAY_MS) / 1000);
    db.run("INSERT INTO tasks VALUES (?, ?, ?, ?, ?, 'worktree')", [id, state, archived, "2026-07-01T00:00:00.000Z", worktree]);
    db.run("INSERT INTO turns VALUES (?, ?, ?)", [bytes, id, log]);
  }
  file("tasks/closed/attachment", "12345");
  file("diagnostics/turn-20-000001.jsonl", "123");
  file("worktrees/fixture-missing/dependency", "1234567");
  symlinkSync(join(home, "worktrees"), join(home, "loop"));
  return { home, db, now };
}

test("report reads committed WAL and changes no files, permissions, or timestamps", async () => {
  const { home, db, now } = fixture();
  try {
    const before = snapshot(home);
    const report = await storageReport(home, "30d", now);
    expect(snapshot(home)).toEqual(before);
    expect(report.logs).toEqual({ live: 10, archived: 20, unknown: 0, bytesPerDay: 3 });
    expect(report.done).toEqual({ tasks: 1, bytes: 10 });
    expect(report.purge.tasks).toBe(1);
    expect(report.purge.bytes).toBe(28);
    expect(report.worktrees.filter(w => w.orphan).map(w => w.state).sort()).toEqual(["archived", "missing"]);
    expect(report.total).toBe(report.directories.reduce((n, e) => n + e.bytes, 0));
    expect(formatStorageReport(report)).toContain("Orphan worktrees: 2");
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/index.ts"), "doctor", "--storage"], {
      env: { ...process.env, WISP_HOME: home }, stdout: "pipe", stderr: "pipe",
    });
    const output = await new Response(child.stdout).text();
    expect(await child.exited).toBe(0);
    expect(output).toContain("read-only");
    expect(snapshot(home)).toEqual(before);
  } finally { db.close(); }
});

test("report never initializes a missing home, including the real CLI entrypoint", async () => {
  const home = join(mkdtempSync(join(tmpdir(), "wisp-storage-empty-")), "absent");
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/index.ts"), "doctor", "--storage"], {
    env: { ...process.env, WISP_HOME: home }, stdout: "pipe", stderr: "pipe",
  });
  expect(await child.exited).toBe(0);
  expect(existsSync(home)).toBe(false);
  expect((await storageReport(home)).total).toBe(0);
});

test("in-memory ledger ignores uncommitted WAL frames and reads checkpointed databases", async () => {
  const { home, db } = fixture();
  try {
    db.exec("PRAGMA cache_size=1; BEGIN; INSERT INTO tasks VALUES ('pending', 'done', 1, '', NULL, NULL)");
    const copy = await readStorageLedger(join(home, "wisp.db"));
    expect(copy!.query("SELECT count(*) AS n FROM tasks").get()).toEqual({ n: 2 }); copy!.close();
    db.exec("ROLLBACK; PRAGMA wal_checkpoint(TRUNCATE)");
    const checkpointed = await readStorageLedger(join(home, "wisp.db"));
    expect(checkpointed!.query("SELECT count(*) AS n FROM tasks").get()).toEqual({ n: 2 }); checkpointed!.close();
  } finally { db.close(); }
});

test("cutoffs reject invalid dates, missing values and unbounded ages", () => {
  for (const value of [true, "0d", "-1d", "2026-02-30", "30", "999999999999999999d"]) expect(() => archivedBefore(value)).toThrow();
  expect(archivedBefore("2026-09-01")).toBe("2026-09-01T00:00:00.000Z");
});
