// `wisp new --subtask --queue` (#495): over its parent's running cap a queued
// subtask is still created, waits as `queued` with its place in line, starts
// when a sibling finishes, and its first turn reports back like any other.
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import type { AdapterDef } from "../src/adapters";
import type { WispConfig } from "../src/config";
import { createTaskRoute, taskRoute } from "../src/routes/tasks";
import { taskMessageRoute } from "../src/routes/task-messages";
import { startNextQueuedMessage } from "../src/runner";
import { assertTaskCapacity, reserveTaskCapacity } from "../src/task-admission";
import { createTask, createTaskMessage, db, freeSlot, getTask, newTaskId, setTaskFields, transition, turnsFor } from "../src/store";

const cfg: WispConfig = {
  instanceId: "123e4567-e89b-42d3-a456-426614174000", port: 0, host: "127.0.0.1", token: "test", webhooks: [], repos: [],
  stuckMinutes: 10, logMaxBytes: 5_000_000, setupTimeoutMinutes: 10, envAllowlist: {}, harnessDefaults: {}, subtasks: true, maxRunningSubtasks: 1,
};
const adapters: Record<string, AdapterDef> = {
  quick: { bin: "bash", exec: ["-c", "printf done"], parse: { format: "text" }, attach: null },
  // holds the parent's one running slot until the test lets it go
  held: { bin: "bash", exec: ["-c", "while [ ! -e \"$WISP_HOLD\" ]; do sleep 0.05; done; printf released"], parse: { format: "text" }, attach: null },
};

async function repo(): Promise<string> {
  const path = realpathSync(mkdtempSync(join(tmpdir(), "wisp-subtask-queue-")));
  for (const args of [["init", "-q"], ["commit", "-q", "--allow-empty", "-m", "init"]]) {
    const proc = Bun.spawn(["git", "-c", "user.name=Queue Test", "-c", "user.email=queue@example.invalid", ...args], { cwd: path, stdout: "ignore", stderr: "pipe" });
    if ((await proc.exited) !== 0) throw new Error(await new Response(proc.stderr).text());
  }
  return path;
}

async function until(pred: () => boolean, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await Bun.sleep(25);
  }
}

const create = (body: Record<string, unknown>) =>
  createTaskRoute(new Request("http://wisp.test/api/tasks", { method: "POST", body: JSON.stringify({ prompt: "work", harness: "quick", ...body }) }), cfg, adapters, null);
const detail = async (id: string) => {
  const path = `/api/tasks/${id}`;
  return await (await taskRoute(new Request(`http://wisp.test${path}`), new URL(`http://wisp.test${path}`), path, "GET", cfg, adapters)!).json() as Record<string, unknown>;
};
const created = async (body: Record<string, unknown>) => {
  const response = await create(body);
  expect(response.status).toBe(201);
  return (await response.json() as { id: string }).id;
};

describe("a queued subtask", () => {
  test("waits for its parent's running cap in order, starts as siblings finish, and reports its first turn", async () => {
    const parent = await created({ repoPath: await repo() });
    await until(() => getTask(parent)!.state === "done");
    const hold = join(mkdtempSync(join(tmpdir(), "wisp-hold-")), "go");
    process.env.WISP_HOLD = hold;
    const busy = await created({ parentTaskId: parent, harness: "held", report: true });
    await until(() => getTask(busy)!.state === "running");

    // without --queue the cap refuses, as before
    const refused = await create({ parentTaskId: parent, report: true });
    expect(refused.status).toBe(429);

    const first = await created({ parentTaskId: parent, report: true, queue: true, prompt: "first in line" });
    const second = await created({ parentTaskId: parent, report: true, queue: true, prompt: "second in line" });
    await until(() => getTask(first)!.state === "queued" && getTask(second)!.state === "queued");
    expect(await detail(first)).toMatchObject({ state: "queued", queue_position: 1, state_detail: `waiting for a subtask slot under ${parent}` });
    expect(await detail(second)).toMatchObject({ queue_position: 2 });
    expect(turnsFor(first)).toEqual([]);

    // the running sibling finishes: the first in line starts, then the second
    await Bun.write(hold, "");
    await until(() => getTask(first)!.state === "done");
    await until(() => getTask(second)!.state === "done");
    expect(turnsFor(first)[0]!.prompt).toContain("first in line");
    expect(turnsFor(first)[0]!.started_at <= turnsFor(second)[0]!.started_at).toBe(true);
    // its first turn, started from the queue, still reports to the parent
    expect(db.query("SELECT event_key FROM subtask_reports WHERE child_task_id = ?").all(first)).toEqual([{ event_key: "turn:1" }]);
    expect(await detail(first)).not.toHaveProperty("queue_position");
    delete process.env.WISP_HOLD;
  }, 40_000);

  test("with a slot free, a queued subtask starts as soon as its setup is done", async () => {
    const parent = await created({ repoPath: await repo() });
    await until(() => getTask(parent)!.state === "done");
    const child = await created({ parentTaskId: parent, report: true, queue: true, prompt: "straight away" });
    await until(() => getTask(child)!.state === "done");
    expect(turnsFor(child)[0]!.prompt).toContain("straight away");
  }, 30_000);

  test("queue is refused for a root task and with attachments, and must be a boolean", async () => {
    for (const [body, error] of [
      [{ repoPath: "/x", queue: true }, "queue needs parentTaskId: a subtask waits for its parent's running cap"],
      [{ parentTaskId: "tnope", queue: "yes" }, "queue must be a boolean, got string"],
      [{ parentTaskId: "tnope", queue: true, attachments: [{ uploadId: "u" }] }, "a queued subtask's first prompt cannot carry attachments; send them once it starts"],
    ] as const) {
      const response = await create(body);
      expect({ status: response.status, body: await response.json() }).toEqual({ status: 400, body: { error } });
    }
  });

  test("a full daemon makes a queued first prompt wait, not fail; it starts once a slot frees", async () => {
    const parent = await created({ repoPath: await repo() });
    await until(() => getTask(parent)!.state === "done");
    const child = queuedChild(parent, "after the daemon frees up");
    const tight: WispConfig = { ...cfg, maxConcurrentTasks: 1 };
    const release = reserveTaskCapacity(`tfill${child}`, tight);
    try {
      expect(startNextQueuedMessage(child, adapters, tight)).toBeNull();
      expect(getTask(child)).toMatchObject({ state: "queued", state_detail: "waiting for a free task slot" });
    } finally {
      release();
    }
    startNextQueuedMessage(child, adapters, tight);
    await until(() => getTask(child)!.state === "done");
  }, 30_000);

  test("cancelling a queued subtask's first prompt leaves it waiting for you, not queued forever", async () => {
    const parent = await created({ repoPath: await repo() });
    await until(() => getTask(parent)!.state === "done");
    const child = queuedChild(parent, "never mind");
    const path = `/api/tasks/${child}/messages/mfirst${child}`;
    const response = await taskMessageRoute(new Request(`http://wisp.test${path}`, { method: "DELETE" }), path, "DELETE")!;
    expect(response.status).toBe(200);
    expect(getTask(child)).toMatchObject({ state: "needs-input", state_detail: "its first prompt was cancelled before it started; send a message to start it" });
  }, 30_000);

  test("a queued subtask's setup holds a global slot only: it never blocks a sibling under the parent's cap", () => {
    const parent = newTaskId();
    createTask({ id: parent, title: "parent", repo_path: "/fixture", harness: "quick", model: null, slot: freeSlot() });
    const sub = (id: string) => createTask({
      id, title: "child", repo_path: "/fixture", harness: "quick", model: null, slot: freeSlot(),
      subtask: { parent_task_id: parent, subtask_kind: "explore", report_to_parent: true, base_from: "project" },
    });
    const settingUp = newTaskId();
    const ready = newTaskId();
    sub(settingUp);
    sub(ready);
    const release = reserveTaskCapacity(settingUp, cfg, { parentId: null });
    try {
      expect(() => assertTaskCapacity(cfg, ready)).not.toThrow();
    } finally {
      release();
    }
  });
});

/** A subtask already set up and queued, its first prompt waiting (as task-launch.ts leaves one). */
function queuedChild(parent: string, prompt: string): string {
  const id = newTaskId();
  createTask({
    id, title: prompt, repo_path: getTask(parent)!.repo_path, harness: "quick", model: null, slot: freeSlot(),
    subtask: { parent_task_id: parent, subtask_kind: "explore", report_to_parent: true, base_from: "project" },
  });
  setTaskFields(id, { worktree_path: getTask(parent)!.worktree_path, branch: `wisp/${id}` });
  createTaskMessage({ id: `mfirst${id}`, taskId: id, text: prompt, attachmentHash: "", reportBack: true });
  transition(id, "queued", `waiting for a subtask slot under ${parent}`);
  return id;
}
