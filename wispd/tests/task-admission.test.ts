import { expect, test } from "bun:test";
import { assertTaskCapacity, reserveTaskCapacity, TaskCapacityError } from "../src/task-admission";
import { loadConfig, validateConfig } from "../src/config";
import { createTask, createTurn, finishTurn, freeSlot, newTaskId, runningTurns, setTaskFields, transition } from "../src/store";

function task() {
  const id = newTaskId();
  createTask({ id, title: "Capacity fixture", repo_path: "/fixture", harness: "fake", model: null, slot: freeSlot() });
  return id;
}

test("setup reserves a slot atomically and release lets a later task start", () => {
  const cfg = { ...loadConfig(), maxConcurrentTasks: new Set(runningTurns().map(t => t.task_id)).size + 1 };
  const id = task(), release = reserveTaskCapacity(id, cfg);
  try {
    expect(() => assertTaskCapacity(cfg)).toThrow(TaskCapacityError);
    expect(() => assertTaskCapacity(cfg, id)).not.toThrow();
  } finally { release(); }
  expect(() => assertTaskCapacity(cfg)).not.toThrow();
});

test("active tasks consume slots; steering and a thousand prior turns do not consume new ones", () => {
  const baseline = new Set(runningTurns().map(t => t.task_id)).size;
  const id = task(), cfg = { ...loadConfig(), maxConcurrentTasks: baseline + 1 };
  setTaskFields(id, { turn_count: 1000 });
  const turn = createTurn(id, 1001, "fixture", null, "/fixture/log", null);
  try {
    expect(() => assertTaskCapacity(cfg)).toThrow(/Finish or stop another task/);
    expect(() => assertTaskCapacity(cfg, id)).not.toThrow();
  } finally { finishTurn(turn, "done", 0, "fixture complete"); transition(id, "done"); }
  expect(() => assertTaskCapacity(cfg, id)).not.toThrow();
});

test("concurrency configuration accepts a high ceiling but rejects ambiguous limits", () => {
  expect(validateConfig({ maxConcurrentTasks: 100 })).toEqual({ maxConcurrentTasks: 100 });
  for (const value of [0, -1, 1.5, "100", null]) expect(() => validateConfig({ maxConcurrentTasks: value })).toThrow(/positive integer/);
});

test("send refuses a new workload at capacity without persisting the message, while steering is still queued safely", async () => {
  const { submitTaskMessage } = await import("../src/runner");
  const { getTask, messagesFor } = await import("../src/store");
  const { validateAdapters } = await import("../src/adapters");
  const def = validateAdapters({ fake: { bin: "true", exec: [], parse: { format: "text" } } }).fake!;
  const active = task(), idle = task();
  transition(active, "done"); transition(idle, "done");
  setTaskFields(active, { worktree_path: "/fixture" }); setTaskFields(idle, { worktree_path: "/fixture" });
  const cfg = { ...loadConfig(), maxConcurrentTasks: new Set(runningTurns().map(t => t.task_id)).size + 1 };
  const turn = createTurn(active, 1, "fixture", null, "/fixture/log", null);
  try {
    await expect(submitTaskMessage(getTask(idle)!, "keep this draft", def, cfg)).rejects.toThrow(TaskCapacityError);
    expect(messagesFor(idle)).toHaveLength(0);
    const reply = await submitTaskMessage(getTask(active)!, "normal steering", def, cfg);
    expect(reply.disposition).toBe("queued-next");
    expect(messagesFor(active)).toHaveLength(1);
  } finally { finishTurn(turn, "done", 0, "fixture"); }
});
