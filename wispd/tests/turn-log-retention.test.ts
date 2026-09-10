import { afterEach, expect, test } from "bun:test";
import { existsSync, lstatSync, readFileSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_PATH, LOG_DIR, loadConfig, turnLogSettings, validateConfig } from "../src/config";
import { createTask, createTurn, db, finishTurn, freeSlot, getTask, newTaskId, setTaskFields, turnForTask } from "../src/store";
import { getTurnText, indexTurnProse, putTurnText } from "../src/turn-texts";
import { retainTurnLogs } from "../src/turn-log-retention";
import { acquireTaskRetention, purgeTask } from "../src/task-retention";
import { acquireTranscriptRead } from "../src/transcript-access";
import { route } from "../src/routes";
import { apiTurn } from "../src/routes/http";
import { searchTasks } from "../src/store-search";
import { HomeLifetime } from "../src/home-lifetime";

const ids: string[] = [];
const cfg = loadConfig();
const now = Date.now();
const day = 86_400_000;
function fixture(options: { archived?: boolean; prose?: "complete" | "partial" | "unavailable" | "none"; age?: number; n?: number; taskId?: string; bytes?: number } = {}) {
  const id = options.taskId ?? newTaskId(), n = options.n ?? 1;
  if (!options.taskId) {
    ids.push(id);
    createTask({ id, title: "Log retention fixture", repo_path: "/synthetic/repo", harness: "fake", model: null, slot: freeSlot() });
  }
  const log = join(LOG_DIR, `${id}-turn${n}.out.log`), err = log.replace(".out.log", ".err.log");
  writeFileSync(log, "x".repeat(options.bytes ?? 10)); writeFileSync(err, "error");
  const stamp = (now - (options.age ?? 120) * day) / 1000;
  utimesSync(log, stamp, stamp); utimesSync(err, stamp, stamp);
  const turnId = createTurn(id, n, "Retained prompt", null, log);
  finishTurn(turnId, "done", 0, "Retained result");
  setTaskFields(id, { archived: Number(options.archived ?? true), turn_count: n });
  if (options.prose !== "none") putTurnText({
    turn_id: turnId, task_id: id, kind: "prose", text: "searchable elderberry", bytes: 21, state: options.prose ?? "complete",
  });
  return { id, turnId, log, err, n };
}
afterEach(async () => {
  for (const id of ids.splice(0)) {
    if (!getTask(id)) continue;
    setTaskFields(id, { archived: 1 });
    await purgeTask(getTask(id)!);
  }
});

test("TTL evicts entire archived turns, preserves metadata/prose and declares legacy eviction", async () => {
  const old = fixture(), recent = fixture({ age: 2, n: 2, taskId: old.id });
  const result = await retainTurnLogs(cfg, now);
  expect(result.evicted).toBe(1); expect(result.reclaimedBytes).toBe(15);
  expect(existsSync(old.log)).toBe(false); expect(existsSync(old.err)).toBe(false);
  expect(existsSync(recent.log)).toBe(true); expect(existsSync(recent.err)).toBe(true);
  const turn = turnForTask(old.id, 1)!;
  expect(apiTurn(turn).capture_state).toBe("evicted");
  expect(turn.capture_mode).toBeNull(); expect(turn.result).toBe("Retained result");
  expect(turn.capture_detail).toContain("Retention age expired");
  expect(getTurnText(old.turnId)?.text).toBe("searchable elderberry");
  await indexTurnProse({ taskId: old.id, turnId: old.turnId, logFile: old.log, result: turn.result, def: undefined });
  expect(getTurnText(old.turnId)?.text).toBe("searchable elderberry");
  expect(searchTasks("elderberry").tasks.some(t => t.id === old.id)).toBe(true);
});

test("no live logs or missing, partial, unavailable prose rows are eligible at any age or quota", async () => {
  const protectedTurns = [fixture({ archived: false }), fixture({ prose: "none" }), fixture({ prose: "partial" }), fixture({ prose: "unavailable" })];
  const before = protectedTurns.map(f => [lstatSync(f.log).mtimeMs, readFileSync(f.log, "utf8")]);
  // Other suites share this scratch ledger. They may have eligible archives;
  // the contract here is that these protected turns remain byte-for-byte intact.
  await retainTurnLogs({ ...cfg, turnLogMaxBytes: 1, turnLogRetentionDays: 1 }, now);
  protectedTurns.forEach((f, i) => {
    expect([lstatSync(f.log).mtimeMs, readFileSync(f.log, "utf8")]).toEqual(before[i]!);
    expect(turnForTask(f.id, f.n)?.capture_state).not.toBe("evicted");
  });
});

test("byte quota evicts oldest whole turns, including stderr, never individual file tails", async () => {
  const oldest = fixture({ age: 3 }), middle = fixture({ age: 2 }), newest = fixture({ age: 1 });
  const result = await retainTurnLogs({ ...cfg, turnLogMaxBytes: 20 }, now);
  expect(result.evicted).toBe(2); expect(result.reclaimedBytes).toBe(30); expect(result.retainedBytes).toBe(15);
  for (const f of [oldest, middle]) { expect(existsSync(f.log)).toBe(false); expect(existsSync(f.err)).toBe(false); }
  expect(existsSync(newest.log)).toBe(true);
});

test("a skipped turn becomes eligible only after the backfill supplies complete prose", async () => {
  const f = fixture({ prose: "none" });
  expect((await retainTurnLogs(cfg, now)).evicted).toBe(0);
  putTurnText({ turn_id: f.turnId, task_id: f.id, kind: "prose", text: "kept", bytes: 4, state: "complete" });
  expect((await retainTurnLogs(cfg, now)).evicted).toBe(1);
  expect(getTurnText(f.turnId)?.text).toBe("kept");
});

test("reader/export leases defer eviction; durable intent resumes on a later pass", async () => {
  const f = fixture(), releaseReader = acquireTranscriptRead(f.turnId);
  expect((await retainTurnLogs(cfg, now)).evicted).toBe(0);
  releaseReader();
  const releaseExport = acquireTaskRetention(f.id)!;
  expect((await retainTurnLogs(cfg, now)).evicted).toBe(0);
  releaseExport();
  db.run("UPDATE turns SET capture_state = 'evicted', capture_detail = 'File removal pending' WHERE id = ?", [f.turnId]);
  unlinkSync(f.log);
  expect((await retainTurnLogs(cfg, now)).evicted).toBe(1);
  expect(existsSync(f.err)).toBe(false);
  expect((await retainTurnLogs(cfg, now)).evicted).toBe(0);
});

test("symlinks, unowned log paths and archived running turns are skipped", async () => {
  const target = fixture({ archived: false }), link = fixture(), unowned = fixture(), running = fixture();
  unlinkSync(link.log); symlinkSync(target.log, link.log);
  db.run("UPDATE turns SET log_file = ? WHERE id = ?", [target.log, unowned.turnId]);
  db.run("UPDATE turns SET status = 'running' WHERE id = ?", [running.turnId]);
  try {
    expect((await retainTurnLogs(cfg, now)).evicted).toBe(0);
    expect(readFileSync(target.log, "utf8")).toBe("xxxxxxxxxx");
  } finally {
    unlinkSync(link.log);
    db.run("UPDATE turns SET log_file = ? WHERE id = ?", [unowned.log, unowned.turnId]);
  }
});

test("a crash after the final unlink still completes its durable eviction checkpoint", async () => {
  const f = fixture();
  db.run("UPDATE turns SET capture_state = 'evicted', capture_detail = 'File removal pending' WHERE id = ?", [f.turnId]);
  unlinkSync(f.log); unlinkSync(f.err);
  expect((await retainTurnLogs(cfg, now)).evicted).toBe(1);
  expect(turnForTask(f.id, f.n)?.capture_detail).not.toContain("File removal pending");
  expect(turnForTask(f.id, f.n)?.captured_bytes).toBe(0);
  expect((await retainTurnLogs(cfg, now)).evicted).toBe(0);
});

test("disabled retention and draining homes delete nothing; config budgets are distinct", async () => {
  const f = fixture();
  expect(turnLogSettings(cfg)).toEqual({ enabled: true, maxBytes: 1024 ** 3, retentionMs: 90 * day });
  await retainTurnLogs({ ...cfg, turnLogRetentionEnabled: false, turnLogMaxBytes: 1 }, now);
  const lifetime = new HomeLifetime(); lifetime.draining = true;
  await lifetime.run(() => retainTurnLogs(cfg, now));
  expect(existsSync(f.log)).toBe(true);
  for (const key of ["turnLogMaxBytes", "turnLogRetentionDays"]) {
    for (const value of [0, -1, NaN, Infinity, 0.1, "10"]) expect(() => validateConfig({ [key]: value })).toThrow();
  }
  expect(() => validateConfig({ turnLogRetentionEnabled: "false" })).toThrow();
  expect(validateConfig({ turnLogMaxBytes: 100, turnTranscriptBytes: 200 })).toEqual({ turnLogMaxBytes: 100, turnTranscriptBytes: 200 });
});

test("HTTP log, activity stream and real wisp log report eviction instead of empty output", async () => {
  const f = fixture();
  await retainTurnLogs(cfg, now);
  const call = (req: Request) => { const url = new URL(req.url); return route(req, url, url.pathname, cfg, {}); };
  const response = await call(new Request(`http://fixture/api/tasks/${f.id}/log?turn=1`));
  expect(await response.json()).toMatchObject({ capture_state: "evicted", notice: expect.stringContaining("Transcript evicted") });
  for (const format of ["activity", "human", "raw"]) {
    const stream = await call(new Request(`http://fixture/api/tasks/${f.id}/log/stream?turn=1&format=${format}`));
    const reader = stream.body!.getReader();
    let text = "";
    try {
      while (!text.includes("event: turn-end")) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error("No turn-end");
        text += new TextDecoder().decode(chunk.value);
      }
      expect(text).toContain("Transcript evicted");
    } finally { await reader.cancel(); }
  }
  const original = readFileSync(CONFIG_PATH);
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: call });
  try {
    writeFileSync(CONFIG_PATH, JSON.stringify({ ...cfg, port: server.port }));
    for (const args of [[], ["1"], ["1", "-f"], ["1", "--raw"], ["--raw"], ["1", "--raw", "-f"]]) {
      const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/index.ts"), "log", f.id, ...args], {
        env: process.env, stdout: "pipe", stderr: "pipe",
      });
      const output = await new Response(child.stdout).text();
      const error = await new Response(child.stderr).text();
      expect({ code: await child.exited, error }).toEqual({ code: 0, error: "" });
      expect(output).toContain("Transcript evicted");
    }
  } finally { server.stop(true); writeFileSync(CONFIG_PATH, original); }
});
