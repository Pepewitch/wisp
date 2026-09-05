import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_PATH, LOG_DIR, type WispConfig } from "../src/config";
import { serve } from "../src/daemon";
import { createTask, createTurn, finishTurn, freeSlot, newTaskId, setTaskFields, transition } from "../src/store";

const token = "web-test-token";
let server: Awaited<ReturnType<typeof serve>> | null = null;

function config(repos: WispConfig["repos"] = []): WispConfig {
  return {
    port: 18710,
    host: "127.0.0.1",
    token,
    webhooks: [],
    repos,
    stuckMinutes: 10,
    logMaxBytes: 5_000_000,
    setupTimeoutMinutes: 10,
    envAllowlist: {},
    harnessDefaults: {},
  };
}

function writeConfig(repos: WispConfig["repos"] = []): void {
  writeFileSync(CONFIG_PATH, JSON.stringify(config(repos)));
}

async function startServer(repos: WispConfig["repos"] = []): Promise<string> {
  writeConfig(repos);
  server = await serve({
    port: 0,
    modelProbeSpawn: () => {
      throw new Error("contract probe failed");
    },
    modelProbeTimeoutMs: 100,
  });
  return `http://127.0.0.1:${server.port}`;
}

afterEach(async () => {
  if (server) await server.stop(true);
  server = null;
});

async function api(base: string, path: string, method = "GET", body?: unknown): Promise<Response> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  return fetch(`${base}${path}`, init);
}

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

async function expectError(base: string, path: string, status: number, message: string): Promise<void> {
  const res = await api(base, path);
  expect(res.status).toBe(status);
  expect(await json<{ error: string }>(res)).toEqual({ error: message });
}

function makeTask(overrides: Partial<Parameters<typeof createTask>[0]> = {}) {
  return createTask({
    id: newTaskId(),
    title: "daemon API contract task",
    repo_path: "/tmp/wisp-contract-repo",
    harness: "claude",
    model: null,
    slot: freeSlot(),
    ...overrides,
  });
}

describe("daemon API contracts, batch 2", () => {
  test("slices task logs by tail, beginning, and positioned offset", async () => {
    const base = await startServer();
    const task = makeTask();
    const logFile = join(LOG_DIR, `${task.id}-turn1.out.log`);
    const out = "o".repeat(300_000);
    const err = "e".repeat(20_000);
    writeFileSync(logFile, out);
    writeFileSync(logFile.replace(/\.out\.log$/, ".err.log"), err);
    const turnId = createTurn(task.id, 1, "slice the log", null, logFile);
    finishTurn(turnId, "done", 0, "finished");
    setTaskFields(task.id, { turn_count: 1 });
    transition(task.id, "done", "finished");

    const defaultLog = await api(base, `/api/tasks/${task.id}/log`);
    expect(defaultLog.status).toBe(200);
    expect(await json(defaultLog)).toEqual({
      turn: 1,
      status: "done",
      harness: "claude",
      size: 0,
      // The current daemon pins default/error tails at 16 KiB and marks truncation with an ellipsis.
      out: `…${out.slice(-16_384)}`,
      err: `…${err.slice(-16_384)}`,
    });

    const fromBeginning = await api(base, `/api/tasks/${task.id}/log?offset=0`);
    expect(fromBeginning.status).toBe(200);
    expect(await json(fromBeginning)).toEqual({
      turn: 1,
      status: "done",
      harness: "claude",
      // Positioned reads expose the next poll offset, capped with the slice.
      size: 262_144,
      out: out.slice(0, 262_144),
      err: `…${err.slice(-16_384)}`,
    });

    const offset = 12_345;
    const positioned = await api(base, `/api/tasks/${task.id}/log?offset=${offset}`);
    expect(positioned.status).toBe(200);
    expect(await json(positioned)).toEqual({
      turn: 1,
      status: "done",
      harness: "claude",
      size: offset + 262_144,
      out: out.slice(offset, offset + 262_144),
      err: `…${err.slice(-16_384)}`,
    });

    await expectError(base, `/api/tasks/${task.id}/log?turn=999`, 404, "no turn 999");
    await expectError(base, "/api/tasks/tnope9/log", 404, "no such task: tnope9");
  });

  test("task detail includes the API task fields, current turn row shape, and null diffstat", async () => {
    const base = await startServer();
    const task = makeTask();
    const logFile = join(LOG_DIR, `${task.id}-turn1.out.log`);
    writeFileSync(logFile, "stdout\n");
    const turnId = createTurn(task.id, 1, "inspect detail", null, logFile);
    finishTurn(turnId, "done", 0, "finished");
    setTaskFields(task.id, { turn_count: 1 });
    transition(task.id, "done", "finished");

    const detail = await api(base, `/api/tasks/${task.id}`);
    expect(detail.status).toBe(200);
    const body = await json<Record<string, unknown>>(detail);
    for (const field of [
      "id",
      "state",
      "state_detail",
      "seq",
      "harness",
      "model",
      "branch",
      "worktree_path",
      "archived",
      "turn_count",
      "turns",
      "diffstat",
      "worktreeReason",
    ]) {
      expect(body).toHaveProperty(field);
    }
    expect(body).toMatchObject({
      id: task.id,
      state: "done",
      state_detail: "finished",
      harness: "claude",
      model: null,
      branch: null,
      worktree_path: null,
      archived: false,
      turn_count: 1,
      diffstat: null,
    });
    expect(typeof body.seq).toBe("number");
    expect(Array.isArray(body.turns)).toBe(true);

    const turns = body.turns as Array<Record<string, unknown>>;
    expect(turns).toHaveLength(1);
    expect(Object.keys(turns[0]!).sort()).toEqual([
      // A1a: the parsed manifest is served, [] for a turn that carried none
      "attachments",
      "ended_at",
      "exit_code",
      "id",
      "interrupt_detail",
      "log_file",
      "model",
      "n",
      "pid",
      "pid_start_time",
      "prompt",
      "result",
      "started_at",
      "status",
      "task_id",
      // Theme B: the normalized usage summary, null when the harness reported none
      "usage",
    ]);
    // the storage columns are internal encodings and must never reach a client
    expect(turns[0]).not.toHaveProperty("attachments_json");
    expect(turns[0]).not.toHaveProperty("usage_json");
    expect(turns[0]!.attachments).toEqual([]);
    expect(turns[0]).toMatchObject({
      id: expect.any(Number),
      task_id: task.id,
      n: 1,
      prompt: "inspect detail",
      result: "finished",
      status: "done",
      pid: null,
      pid_start_time: null,
      interrupt_detail: null,
      model: null,
      exit_code: 0,
      usage: null,
      log_file: logFile,
      started_at: expect.any(String),
      ended_at: expect.any(String),
    });
  });

  test("archived task detail remains readable and marks archived true", async () => {
    const base = await startServer();
    const task = makeTask();
    setTaskFields(task.id, { archived: 1 });

    const detail = await api(base, `/api/tasks/${task.id}`);
    expect(detail.status).toBe(200);
    expect(await json(detail)).toMatchObject({
      id: task.id,
      archived: true,
      turns: [],
      diffstat: null,
    });
  });
});
