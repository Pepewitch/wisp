import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { WISP_HOME } from "../src/config";
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
