#!/usr/bin/env bun
/**
 * Prove a compiled binary runs search in its worker, not on the request thread.
 *
 * The worker is a second entry point inside the binary (build-binary.ts). If a
 * build drops it, or a Bun upgrade changes how an embedded entry resolves,
 * search quietly falls back to in-process and every keystroke blocks the
 * daemon again. Nothing else would notice, so this starts the binary on a
 * throwaway home, seeds one synthetic row that makes a search slow, and fails
 * unless a health request is answered while that search is still running.
 *
 *   bun run wispd/scripts/check-binary-search.ts dist/wisp
 */
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

class CheckFailed extends Error {
  constructor(message: string, readonly log = "") {
    super(message);
  }
}

function fail(message: string, log?: string): never {
  throw new CheckFailed(message, log);
}

const binary = process.argv[2];
if (!binary) {
  console.error("usage: check-binary-search.ts <compiled wisp binary>");
  process.exit(2);
}

const home = mkdtempSync(join(tmpdir(), "wisp-binary-search-"));
const port = 20_000 + Math.floor(Math.random() * 20_000);
const logPath = join(home, "daemon.log");
const env = { ...process.env, WISP_HOME: home, WISP_LAUNCH_POLICY: "block" };
const log = (): string => { try { return readFileSync(logPath, "utf8"); } catch { return ""; } };
let daemon: ReturnType<typeof Bun.spawn> | undefined;

try {
  const init = Bun.spawnSync({ cmd: [resolve(binary), "init", "--port", String(port)], env, stdout: "ignore", stderr: "pipe" });
  if (init.exitCode !== 0) fail(`init exited ${init.exitCode}`, init.stderr.toString());
  daemon = Bun.spawn({ cmd: [resolve(binary), "serve"], env, stdout: Bun.file(logPath), stderr: Bun.file(logPath) });
  const base = `http://127.0.0.1:${port}`;
  let up = false;
  for (let attempt = 0; attempt < 150 && !up; attempt++) {
    try { up = (await fetch(`${base}/api/health`)).ok; } catch { await Bun.sleep(100); }
  }
  if (!up) fail("the daemon did not answer /api/health", log());
  const token = (JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as { token: string }).token;
  const auth = { headers: { authorization: `Bearer ${token}` } };

  // A second connection to the daemon's WAL database, for synthetic rows only.
  const db = new Database(join(home, "wisp.db"));
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO tasks (id, title, repo_path, harness, state, created_at, updated_at)
     VALUES ('tbinsearch', 'binary search probe', '/synthetic/repo', 'fake', 'done', ?, ?)`,
    [now, now],
  );
  // LIKE retries the needle at every position of a run of one letter when the
  // needle is that letter repeated and then another: hundreds of milliseconds.
  db.run(
    `INSERT INTO turns (task_id, n, prompt, status, log_file, started_at) VALUES ('tbinsearch', 1, ?, 'done', '/synthetic/turn.log', ?)`,
    ["a".repeat(2 * 1024 * 1024), now],
  );
  db.close();

  const found = await fetch(`${base}/api/search?q=${encodeURIComponent("binary search probe")}`, auth);
  const body = (await found.json()) as { tasks?: { id: string }[] };
  if (found.status !== 200 || !body.tasks?.some((task) => task.id === "tbinsearch")) {
    fail(`search did not find the probe task (${found.status})`, log());
  }

  let searched = false;
  const slow = fetch(`${base}/api/search?q=${"a".repeat(199)}b`, auth).then((response) => {
    searched = true;
    return response.status;
  });
  await Bun.sleep(100);
  const started = performance.now();
  const health = await fetch(`${base}/api/health`);
  const healthMs = performance.now() - started;
  if (!health.ok) fail(`/api/health answered ${health.status} during a search`, log());
  if (searched) fail("/api/health waited for the search to finish: search ran on the request thread", log());
  const status = await slow;
  if (status !== 200) fail(`the slow search answered ${status}`, log());
  if (log().includes("search worker unavailable")) fail("the binary could not start its search worker", log());
  console.log(`check-binary-search: ok (/api/health answered in ${healthMs.toFixed(1)} ms during a search)`);
} catch (error) {
  console.error(`check-binary-search: ${error instanceof Error ? error.message : String(error)}`);
  if (error instanceof CheckFailed && error.log) console.error(error.log);
  process.exitCode = 1;
} finally {
  daemon?.kill();
  await daemon?.exited;
  rmSync(home, { recursive: true, force: true });
}
