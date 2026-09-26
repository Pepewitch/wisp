import { afterEach, describe, expect, test } from "bun:test";
import { BUILTIN_ADAPTERS, type AdapterDef } from "../src/adapters";
import { emit, subscribe, type WispEvent } from "../src/events";
import type { HarnessLimitsCache, HarnessLimitsEntry } from "../src/harness-limits";
import { LimitsTurnRefresh, type LimitsTurnRefreshOptions } from "../src/harness-limits-refresh";
import { createTask, createTurn, finishTurn, freeSlot, newTaskId } from "../src/store";

const adapters: Record<string, AdapterDef> = {
  claude: BUILTIN_ADAPTERS.claude!,
  codex: BUILTIN_ADAPTERS.codex!,
  cursor: BUILTIN_ADAPTERS.cursor!,
};

/** A cache stand-in that records which harness was read now, and whether a client is watching. */
function fakeCache(watching = true) {
  const reads: string[] = [];
  const cache = {
    askedWithin: () => watching,
    readNow: (name: string) => {
      reads.push(name);
      return Promise.resolve({ name, status: "ok" } as HarnessLimitsEntry);
    },
  } as unknown as HarnessLimitsCache;
  return { cache, reads };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let running: LimitsTurnRefresh[] = [];
afterEach(async () => {
  await Promise.all(running.map((r) => r.stop()));
  running = [];
});

function start(cache: HarnessLimitsCache, options: LimitsTurnRefreshOptions = {}) {
  const harnessOf: Record<string, string> = { tc: "claude", tx: "codex", tu: "cursor" };
  const refresh = new LimitsTurnRefresh(cache, {}, adapters, {
    settleMs: 10,
    minGapMs: 60,
    harnessOfTurn: (taskId) => harnessOf[taskId] ?? null,
    ...options,
  });
  refresh.start();
  running.push(refresh);
  return refresh;
}

function limitEvents(): { events: string[]; stop: () => void } {
  const events: string[] = [];
  const stop = subscribe((e: WispEvent) => {
    if (e.type === "harness-limits") events.push(e.harness);
  });
  return { events, stop };
}

describe("re-reading limits when a turn ends", () => {
  test("reads only the finished turn's harness, then tells clients", async () => {
    const { cache, reads } = fakeCache();
    const told = limitEvents();
    start(cache);
    emit({ type: "turn", taskId: "tc", n: 1, status: "done" });
    expect(reads).toEqual([]); // settles first
    await sleep(30);
    expect(reads).toEqual(["claude"]);
    expect(told.events).toEqual(["claude"]);
    told.stop();
  });

  test("a failed or interrupted turn counts; a starting one and other events do not", async () => {
    const { cache, reads } = fakeCache();
    start(cache, { minGapMs: 0 });
    emit({ type: "turn", taskId: "tc", n: 1, status: "running" });
    emit({ type: "task", taskId: "tc", state: "done", stateDetail: null, seq: 2 });
    await sleep(30);
    expect(reads).toEqual([]);
    emit({ type: "turn", taskId: "tc", n: 1, status: "failed" });
    emit({ type: "turn", taskId: "tx", n: 1, status: "interrupted" });
    await sleep(30);
    expect(reads.sort()).toEqual(["claude", "codex"]);
  });

  test("turns ending together share one read, and a later one waits out the gap", async () => {
    const { cache, reads } = fakeCache();
    // a stopped clock: the third turn ends at the instant of the first read, a whole gap before the next may start
    start(cache, { minGapMs: 100, now: () => 0 });
    emit({ type: "turn", taskId: "tc", n: 1, status: "done" });
    emit({ type: "turn", taskId: "tc", n: 2, status: "done" });
    await sleep(30);
    expect(reads).toEqual(["claude"]);
    emit({ type: "turn", taskId: "tc", n: 3, status: "done" });
    await sleep(30);
    expect(reads).toEqual(["claude"]); // inside the gap: deferred, not dropped
    await sleep(120);
    expect(reads).toEqual(["claude", "claude"]);
  });

  test("nothing is read with no client watching, or for a harness with no limits read", async () => {
    const idle = fakeCache(false);
    start(idle.cache);
    emit({ type: "turn", taskId: "tc", n: 1, status: "done" });
    const watched = fakeCache();
    start(watched.cache);
    emit({ type: "turn", taskId: "tu", n: 1, status: "done" });
    emit({ type: "turn", taskId: "unknown", n: 1, status: "done" });
    await sleep(30);
    expect(idle.reads).toEqual([]);
    expect(watched.reads).toEqual([]);
  });

  test("a stopped refresher cancels what it scheduled", async () => {
    const { cache, reads } = fakeCache();
    const refresh = start(cache);
    emit({ type: "turn", taskId: "tc", n: 1, status: "done" });
    await refresh.stop();
    await sleep(30);
    expect(reads).toEqual([]);
  });

  test("the harness is the turn's own, from the store", async () => {
    const { cache, reads } = fakeCache();
    start(cache, { harnessOfTurn: undefined });
    const task = createTask({
      id: newTaskId(),
      title: "limits refresh task",
      repo_path: "/tmp/wisp-limits-refresh-repo",
      harness: "claude",
      model: null,
      slot: freeSlot(),
    });
    const turnId = createTurn(task.id, 1, "switch agents", null, "/tmp/wisp-limits-refresh.log", null, null, null, {
      context_n: 1,
      harness: "codex",
      model: null,
      effort: null,
      fast: false,
    });
    finishTurn(turnId, "done", 0, "finished");
    await sleep(30);
    expect(reads).toEqual(["codex"]);
  });
});
