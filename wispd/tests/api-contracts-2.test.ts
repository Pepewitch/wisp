import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_PATH, LOG_DIR, type WispConfig } from "../src/config";
import { serve } from "../src/daemon";
import {
  createTask,
  createTaskMessage,
  createTurn,
  finishTurn,
  freeSlot,
  markTaskMessageDelivered,
  newTaskId,
  setTaskFields,
  setTurnUsage,
  transition,
} from "../src/store";

const token = "web-test-token";
let server: Awaited<ReturnType<typeof serve>> | null = null;

function config(repos: WispConfig["repos"] = []): WispConfig {
  return {
    instanceId: "123e4567-e89b-42d3-a456-426614174000",
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
      "capture_categories",
      "capture_detail",
      "capture_mode",
      "capture_state",
      "captured_bytes",
      // the durable context and requested agent this turn ran under
      "context_n",
      "diagnostic_bytes",
      "diagnostic_detail",
      "diagnostic_evicted_at",
      "diagnostic_first_seq",
      "diagnostic_last_seq",
      "diagnostic_state",
      "ended_at",
      "exit_code",
      "harness",
      "id",
      "interrupt_detail",
      "kill_detail",
      "log_file",
      "model",
      "n",
      "omitted_bytes",
      "omitted_records",
      "pid",
      "pid_start_time",
      "prompt",
      "requested_effort",
      "requested_model",
      "requested_service_tier",
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
    expect(turns[0]).not.toHaveProperty("outcome_json");
    expect(turns[0]).not.toHaveProperty("capture_categories_json");
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
      capture_mode: null,
      capture_state: "legacy",
      captured_bytes: 0,
      omitted_bytes: 0,
      omitted_records: 0,
      capture_categories: null,
      capture_detail: null,
      kill_detail: null,
      diagnostic_state: "unavailable",
      log_file: logFile,
      started_at: expect.any(String),
      ended_at: expect.any(String),
    });
  });

  test("conversation detail returns the same history without Git-owned fields", async () => {
    const base = await startServer();
    const task = makeTask();
    const logFile = join(LOG_DIR, `${task.id}-conversation-turn1.out.log`);
    writeFileSync(logFile, "stdout\n");
    const turnId = createTurn(task.id, 1, "load conversation", null, logFile);
    finishTurn(turnId, "done", 0, "conversation loaded");
    setTaskFields(task.id, { turn_count: 1 });
    transition(task.id, "done", "conversation loaded");

    const response = await api(base, `/api/tasks/${task.id}/conversation`);
    expect(response.status).toBe(200);
    const timing = response.headers.get("server-timing");
    expect(timing).toMatch(/^conversation;dur=/);
    const duration = Number(timing?.slice("conversation;dur=".length));
    expect(Number.isFinite(duration)).toBe(true);
    expect(duration).toBeGreaterThanOrEqual(0);
    const body = await json<Record<string, unknown>>(response);
    expect(body).toMatchObject({
      id: task.id,
      state: "done",
      state_detail: "conversation loaded",
      turn_count: 1,
      latest_turn_has_result: true,
    });
    expect(body).not.toHaveProperty("diffstat");
    expect(body).not.toHaveProperty("worktreeReason");
    expect(body.messages).toEqual([]);
    expect(body.turns).toEqual([
      expect.objectContaining({
        task_id: task.id,
        n: 1,
        prompt: "load conversation",
        result: "conversation loaded",
        status: "done",
      }),
    ]);

    // Compatibility: the existing route retains its Git-aware shape.
    const legacy = await api(base, `/api/tasks/${task.id}`);
    expect(legacy.status).toBe(200);
    expect(await json(legacy)).toMatchObject({
      id: task.id,
      diffstat: null,
      worktreeReason: null,
    });
  });

  test("pages conversation turns and their messages with an exclusive cursor", async () => {
    const base = await startServer();
    const task = makeTask();
    for (let n = 1; n <= 55; n += 1) {
      const turnId = createTurn(task.id, n, `prompt ${n}`, null, `/tmp/turn-${n}.log`);
      finishTurn(turnId, "done", 0, `result ${n}`);
      setTurnUsage(turnId, JSON.stringify({ input_tokens: n, output_tokens: 1 }));
    }
    for (const n of [1, 6, 55]) {
      const message = createTaskMessage({
        id: `message-${n}`,
        taskId: task.id,
        text: `steer ${n}`,
        attachmentHash: "",
      }, false);
      markTaskMessageDelivered(message.id, "steered", n);
    }
    createTaskMessage({
      id: "message-pending",
      taskId: task.id,
      text: "next turn",
      attachmentHash: "",
    }, false);

    const newest = await json<{
      turns: Array<{ n: number }>;
      messages: Array<{ id: string }>;
      has_older_turns: boolean;
      older_turns_before: number | null;
      latest_turn_has_result: boolean;
    }>(await api(base, `/api/tasks/${task.id}/conversation?limit=50`));
    expect(newest.turns.map((turn) => turn.n)).toEqual(Array.from({ length: 50 }, (_, index) => index + 6));
    expect(newest.messages.map((message) => message.id)).toEqual(["message-6", "message-55", "message-pending"]);
    expect(newest.has_older_turns).toBe(true);
    expect(newest.older_turns_before).toBe(6);
    expect(newest.latest_turn_has_result).toBe(true);

    const older = await json<{
      turns: Array<{ n: number }>;
      messages: Array<{ id: string }>;
      has_older_turns: boolean;
      older_turns_before: number | null;
      latest_turn_has_result: boolean;
    }>(await api(base, `/api/tasks/${task.id}/conversation?limit=50&before=6`));
    expect(older.turns.map((turn) => turn.n)).toEqual([1, 2, 3, 4, 5]);
    expect(older.messages.map((message) => message.id)).toEqual(["message-1"]);
    expect(older.has_older_turns).toBe(false);
    expect(older.older_turns_before).toBeNull();
    expect(older.latest_turn_has_result).toBe(true);

    const compatible = await json<Record<string, unknown>>(
      await api(base, `/api/tasks/${task.id}/conversation`),
    );
    expect((compatible.turns as Array<{ n: number }>).map((turn) => turn.n)).toEqual(
      Array.from({ length: 55 }, (_, index) => index + 1),
    );
    expect(compatible).not.toHaveProperty("has_older_turns");
    expect(compatible).not.toHaveProperty("older_turns_before");

    const usage = await json<{
      total: { inputTokens: number; outputTokens: number };
      reporting_turns: number;
      turns: Array<{ id: number; n: number; usage: { inputTokens: number; outputTokens: number } }>;
      has_older_turns: boolean;
    }>(await api(base, `/api/tasks/${task.id}/usage`));
    expect(usage.total).toEqual({ inputTokens: 1_540, outputTokens: 55 });
    expect(usage.reporting_turns).toBe(55);
    expect(usage.turns).toHaveLength(50);
    expect(usage.turns.map((turn) => turn.n)).toEqual(
      Array.from({ length: 50 }, (_, index) => index + 6),
    );
    expect(usage.has_older_turns).toBe(true);
  });

  test("the newest empty page still includes queued messages", async () => {
    const base = await startServer();
    const task = makeTask();
    createTaskMessage({
      id: "message-pending-empty",
      taskId: task.id,
      text: "start the first turn",
      attachmentHash: "",
    }, false);

    const detail = await json<{
      turns: unknown[];
      messages: Array<{ id: string }>;
      has_older_turns: boolean;
    }>(await api(base, `/api/tasks/${task.id}/conversation?limit=50`));
    expect(detail.turns).toEqual([]);
    expect(detail.messages.map((message) => message.id)).toEqual(["message-pending-empty"]);
    expect(detail.has_older_turns).toBe(false);
  });

  test("validates opt-in conversation page parameters", async () => {
    const base = await startServer();
    const task = makeTask();
    await expectError(
      base,
      `/api/tasks/${task.id}/conversation?limit=0`,
      400,
      'limit must be a positive integer, got "0"',
    );
    await expectError(base, `/api/tasks/${task.id}/conversation?limit=101`, 400, "limit must be at most 100");
    await expectError(
      base,
      `/api/tasks/${task.id}/conversation?limit=50&before=nope`,
      400,
      'before must be a positive integer, got "nope"',
    );
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
