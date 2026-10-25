// The subtask API contract, through the real route handlers: the create
// fields and their shape checks, what the response echoes, the subtasks
// list, the archive's opt-in and refusal body, and the feature flag.
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import type { AdapterDef } from "../src/adapters";
import type { WispConfig } from "../src/config";
import type { ModelProbeCache } from "../src/model-probes";
import { harnessesRoute } from "../src/routes/harnesses";
import { createTaskRoute, taskRoute } from "../src/routes/tasks";
import { hasRunningTurn } from "../src/runner";
import { getTask, turnsFor } from "../src/store";

const cfg = (preview: boolean): WispConfig => ({
  instanceId: "123e4567-e89b-42d3-a456-426614174000", port: 0, host: "127.0.0.1", token: "test", webhooks: [], repos: [],
  stuckMinutes: 10, logMaxBytes: 5_000_000, setupTimeoutMinutes: 10, envAllowlist: {}, harnessDefaults: {}, subtasks: preview,
});
const adapters: Record<string, AdapterDef> = { quick: { bin: "bash", exec: ["-c", "printf done"], parse: { format: "text" }, attach: null } };

async function repo(): Promise<string> {
  const path = realpathSync(mkdtempSync(join(tmpdir(), "wisp-subtasks-api-")));
  for (const args of [["init", "-q"], ["commit", "-q", "--allow-empty", "-m", "init"]]) {
    const proc = Bun.spawn(["git", "-c", "user.name=Api Test", "-c", "user.email=api@example.invalid", ...args], { cwd: path, stdout: "ignore", stderr: "pipe" });
    if ((await proc.exited) !== 0) throw new Error(await new Response(proc.stderr).text());
  }
  return path;
}

const settled = (id: string) => getTask(id)!.state !== "creating" && hasRunningTurn(id) === null && turnsFor(id).every((t) => t.status !== "running");
async function until(pred: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await Bun.sleep(25);
  }
}

const create = (body: Record<string, unknown>, preview = true) =>
  createTaskRoute(new Request("http://wisp.test/api/tasks", { method: "POST", body: JSON.stringify({ prompt: "work", harness: "quick", ...body }) }), cfg(preview), adapters, null);
const call = async (path: string, method = "GET", body?: unknown) =>
  await taskRoute(new Request(`http://wisp.test${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), new URL(`http://wisp.test${path}`), path, method, cfg(true), adapters)!;

async function parentTask(): Promise<string> {
  const response = await create({ repoPath: await repo() });
  const { id } = await response.json() as { id: string };
  await until(() => settled(id));
  return id;
}

describe("the subtask API", () => {
  test("shape checks, and the flag off refusing every subtask field", async () => {
    const parent = await parentTask();
    for (const [body, error] of [
      [{ repoPath: "/x", subtaskKind: "explore" }, "subtaskKind and report need parentTaskId"],
      [{ repoPath: "/x", report: true }, "subtaskKind and report need parentTaskId"],
      [{ parentTaskId: 7 }, "parentTaskId must be a task id, got number"],
      [{ parentTaskId: parent, subtaskKind: "sideways" }, "subtaskKind must be one of review, explore, continue"],
      [{ parentTaskId: parent, report: "yes" }, "report must be a boolean, got string"],
      [{}, "repoPath, prompt, and harness are required"],
    ] as const) {
      const response = await create(body);
      expect({ status: response.status, body: await response.json() }).toEqual({ status: 400, body: { error } });
    }
    const off = await create({ parentTaskId: parent }, false);
    expect({ status: off.status, body: await off.json() }).toEqual({ status: 409, body: { error: "subtasks are not enabled on this daemon" } });
  });

  test("a created subtask echoes its relationship, reporting and base, and is listed under its parent", async () => {
    const parent = await parentTask();
    const response = await create({ parentTaskId: parent, report: true });
    expect(response.status).toBe(201);
    const child = await response.json() as Record<string, unknown>;
    expect(child).toMatchObject({
      parent_task_id: parent, subtask_kind: "explore", report_to_parent: true, base_from: "project", base_sha: null, merge_granted_by: null,
      repo_path: getTask(parent)!.repo_path,
    });
    await until(() => settled(child.id as string));
    const detail = await (await call(`/api/tasks/${child.id}`)).json() as Record<string, unknown>;
    expect(detail).toMatchObject({ base_sha: getTask(child.id as string)!.base_commit, report_to_parent: true });
    const list = await (await call(`/api/tasks/${parent}/subtasks`)).json();
    expect(list).toEqual([expect.objectContaining({
      id: child.id, kind: "explore", reviewer: false, state: "done", archived: false, report_to_parent: true, base_from: "project",
      result: "done", reports: { pending: 1, queued: 0, dropped: 0 },
    })]);
    expect(await (await call(`/api/tasks/${child.id}/subtasks`)).json()).toEqual([]);
  });

  test("archive: a parent's refusal names its subtasks; the opt-in archives them; a bad value is refused", async () => {
    const parent = await parentTask();
    const child = await (await create({ parentTaskId: parent })).json() as { id: string };
    await until(() => settled(child.id));
    expect((await call(`/api/tasks/${parent}/archive`, "POST", { subtasks: "all" })).status).toBe(400);
    const refused = await call(`/api/tasks/${parent}/archive`, "POST", {});
    expect({ status: refused.status, body: await refused.json() }).toEqual({
      status: 409,
      body: {
        error: `task ${parent} has 1 live subtask — archive them with it (subtasks: "archive"), or force them ("force")`,
        refusedSubtasks: [{ id: child.id, title: "work", error: "a live subtask", needs: "subtasks" }],
      },
    });
    const done = await call(`/api/tasks/${parent}/archive`, "POST", { subtasks: "archive" });
    expect({ status: done.status, body: await done.json() }).toEqual({ status: 200, body: expect.objectContaining({ ok: true, subtasks: [child.id] }) });
  });

  test("a review subtask's managed push is refused", async () => {
    const parent = await parentTask();
    const child = await (await create({ parentTaskId: parent, subtaskKind: "review", base: "HEAD" })).json() as { id: string; subtask_kind: string };
    expect(child.subtask_kind).toBe("review");
    await until(() => settled(child.id));
    const push = await call(`/api/tasks/${child.id}/push`, "POST", {});
    expect({ status: push.status, body: await push.json() }).toEqual({ status: 409, body: { error: "a review subtask never pushes: its review covers the parent's pushed head" } });
  });

  test("features.subtasks follows the preview switch", async () => {
    const models = { refresh: async () => {}, refreshIfStale: async () => {}, snapshot: () => ({}) } as unknown as ModelProbeCache;
    const features = async (preview: boolean) => ((await harnessesRoute(new URL("http://wisp.test/api/harnesses"), cfg(preview), adapters, models).json()) as { features: Record<string, boolean> }).features;
    expect((await features(false)).subtasks).toBe(false);
    expect((await features(true)).subtasks).toBe(true);
  });
});
