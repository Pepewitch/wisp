import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdirSync, readdirSync, readlinkSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { DB_PATH, WISP_HOME } from "../src/config";
import { SearchRunner, SearchUnavailable } from "../src/search-runner";
import { createTask, createTurn, db, freeSlot, newTaskId } from "../src/store";
import { searchTasks } from "../src/store-search";

// LIKE retries the needle at every position of a run of one letter when the
// needle is that letter repeated and then another: one 2 MB row makes a search
// that takes hundreds of milliseconds, standing in for a long history.
const SLOW = `${"a".repeat(199)}b`;
let slowTask = "";
const runners: SearchRunner[] = [];
const fixtures = join(WISP_HOME, "search-runner-fixtures");

function runner(options: ConstructorParameters<typeof SearchRunner>[0] = {}): SearchRunner {
  const made = new SearchRunner(options);
  runners.push(made);
  return made;
}

/** Quiet a test that provokes the runner's own error lines. */
async function quietly<T>(run: () => Promise<T>): Promise<T> {
  const original = console.error;
  console.error = () => {};
  try {
    return await run();
  } finally {
    console.error = original;
  }
}

beforeAll(() => {
  slowTask = newTaskId();
  createTask({ id: slowTask, title: "runner fixture runner-needle", repo_path: "/synthetic/repo", harness: "fake", model: null, slot: freeSlot() });
  createTurn(slowTask, 1, "a".repeat(2 * 1024 * 1024), null, "/synthetic/logs/runner.out.log");
  mkdirSync(fixtures, { recursive: true });
});

afterEach(() => {
  for (const made of runners.splice(0)) made.stop();
});

afterAll(() => {
  db.run("DELETE FROM turns WHERE task_id = ?", [slowTask]);
  db.run("DELETE FROM tasks WHERE id = ?", [slowTask]);
});

test("a search past its deadline is answered, and the next search gets a fresh worker", async () => {
  const search = runner({ timeoutMs: 50 });
  const late = await quietly(() => search.search(SLOW).catch((error: unknown) => error));
  expect(late).toBeInstanceOf(SearchUnavailable);
  expect((late as SearchUnavailable).status).toBe(503);
  expect((late as Error).message).toContain("longer than 0.05 s");

  expect(await search.search("runner-needle")).toEqual(searchTasks("runner-needle", db));
});

test("a search whose client left is dropped if queued, and released if running", async () => {
  const search = runner();
  const running = new AbortController();
  const queued = new AbortController();
  const first = search.search(SLOW, running.signal).catch((error: unknown) => error);
  const second = search.search("runner-needle", queued.signal).catch((error: unknown) => error);

  queued.abort();
  expect(await second).toBeInstanceOf(SearchUnavailable);
  // Let the first reach the worker and start its scan.
  await Bun.sleep(100);
  const abortedAt = performance.now();
  running.abort();
  expect(await first).toBeInstanceOf(SearchUnavailable);
  // Answered at once, not after the scan the worker is still finishing.
  expect(performance.now() - abortedAt).toBeLessThan(50);

  // The worker comes back once the cancelled scan reaches its checkpoint.
  expect(await search.search("runner-needle")).toEqual(searchTasks("runner-needle", db));
  const already = new AbortController();
  already.abort();
  expect(await search.search("runner-needle", already.signal).catch((error: unknown) => error)).toBeInstanceOf(SearchUnavailable);
});

test("a worker that dies fails only the search it was running; the next search starts another", async () => {
  const entry = join(fixtures, "crashing-worker.ts");
  writeFileSync(entry, `
self.onmessage = (event) => {
  const message = event.data;
  if (message.type === "open") return postMessage({ type: "ready" });
  if (message.type === "close") return self.close();
  if (message.query === "crash") throw new Error("synthetic worker crash");
  postMessage({ type: "result", id: message.id, response: { query: message.query, tasks: [], truncated: false } });
};
`);
  const search = runner({ entry });
  const crashed = await quietly(() => search.search("crash").catch((error: unknown) => error));
  expect(crashed).toBeInstanceOf(SearchUnavailable);
  expect((crashed as SearchUnavailable).status).toBe(500);

  expect(await search.search("fine")).toEqual({ query: "fine", tasks: [], truncated: false });
});

test("a cancelled search keeps its deadline, so a scan that never ends cannot hold the queue", async () => {
  // A worker that never answers a "hang" query stands in for a runaway scan.
  const entry = join(fixtures, "hanging-worker.ts");
  writeFileSync(entry, `
self.onmessage = (event) => {
  const message = event.data;
  if (message.type === "open") return postMessage({ type: "ready" });
  if (message.type === "close") return self.close();
  if (message.query === "hang") return;
  postMessage({ type: "result", id: message.id, response: { query: message.query, tasks: [], truncated: false } });
};
`);
  const search = runner({ entry, timeoutMs: 50 });
  const client = new AbortController();
  const hung = search.search("hang", client.signal).catch((error: unknown) => error);
  await Bun.sleep(10);
  client.abort();
  expect(await hung).toBeInstanceOf(SearchUnavailable);
  // Without the deadline this waits forever behind the hung worker.
  expect(await search.search("fine")).toEqual({ query: "fine", tasks: [], truncated: false });
});

/** This process's open handles on the database file and its WAL and shared-memory files. */
function databaseHandles(): number {
  // lsof and /proc report the resolved path (macOS temp dirs sit behind a symlink).
  const path = realpathSync(DB_PATH);
  if (process.platform === "linux") {
    return readdirSync("/proc/self/fd").filter((fd) => {
      try {
        return readlinkSync(`/proc/self/fd/${fd}`).startsWith(path);
      } catch {
        return false;
      }
    }).length;
  }
  const listing = Bun.spawnSync({ cmd: ["lsof", "-n", "-P", "-Fn", "-p", String(process.pid)] }).stdout.toString();
  return listing.split("\n").filter((line) => line.startsWith("n") && line.slice(1).startsWith(path)).length;
}

test("replaced workers close their database, so handles do not grow with each replacement", async () => {
  const search = runner({ timeoutMs: 50 });
  const before = databaseHandles();
  // SQLite keeps one closed descriptor per database file for reuse while
  // another connection in this process still has it open: one spare, not one
  // per worker.
  const limit = before + 1;
  const settled = async (): Promise<number> => {
    const until = Date.now() + 4000;
    let count = databaseHandles();
    while (count > limit && Date.now() < until) {
      await Bun.sleep(100);
      count = databaseHandles();
    }
    return count;
  };
  const counts: number[] = [];
  for (let round = 0; round < 3; round++) {
    expect(await search.search(SLOW).catch((error: unknown) => error)).toBeInstanceOf(SearchUnavailable);
    // The retired worker closes once its scan returns.
    counts.push(await settled());
  }
  for (const count of counts) expect(count).toBeLessThanOrEqual(limit);
}, 30_000);

test("a worker that cannot start leaves search answering in-process", async () => {
  const errors: unknown[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { errors.push(args[0]); };
  try {
    const search = runner({ entry: join(fixtures, "no-such-worker.ts") });
    expect(await search.search("runner-needle")).toEqual(searchTasks("runner-needle", db));
    expect(errors).toEqual([expect.stringContaining("search worker unavailable")]);
  } finally {
    console.error = original;
  }
});
