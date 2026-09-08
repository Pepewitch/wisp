import { afterEach, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { ADAPTERS_PATH, CONFIG_PATH, type WispConfig } from "../src/config";
import { serve } from "../src/daemon";
import { createTask, createTurn, freeSlot, newTaskId, setTaskFields, transition } from "../src/store";

/**
 * POST /api/tasks/:id/probe (A3) — the out-of-turn read route. The harness
 * CLIs are faked through serve()'s probe injection; what is pinned here is
 * the CONTRACT: the refusal ladder, the named commands, and the response
 * shape the palette renders.
 */

const token = "web-test-token";
let server: Awaited<ReturnType<typeof serve>> | null = null;

function writeConfig(): void {
  const cfg: WispConfig = {
    instanceId: "123e4567-e89b-42d3-a456-426614174000",
    port: 18710,
    host: "127.0.0.1",
    token,
    webhooks: [],
    repos: [],
    stuckMinutes: 10,
    logMaxBytes: 5_000_000,
    setupTimeoutMinutes: 10,
    envAllowlist: {},
    harnessDefaults: {},
  };
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg));
}

const MD_RESULT = '{"type":"result","session_id":"s-1","result":"## Context Usage\\n\\n**Tokens:** 13.3k"}\n';

async function startServer(opts: Parameters<typeof serve>[0] = {}): Promise<string> {
  writeConfig();
  server = await serve({
    port: 0,
    modelProbeSpawn: () => {
      throw new Error("contract probe failed");
    },
    modelProbeTimeoutMs: 100,
    probeSpawnOnce: async () => ({ exitCode: 0, stdout: MD_RESULT, stderr: "" }),
    ...opts,
  });
  return `http://127.0.0.1:${server.port}`;
}

afterEach(async () => {
  if (server) await server.stop(true);
  server = null;
  rmSync(ADAPTERS_PATH, { force: true });
});

async function api(base: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
}

function probeTask(overrides: Partial<Parameters<typeof createTask>[0]> = {}) {
  const task = createTask({
    id: newTaskId(),
    title: "probe route task",
    repo_path: "/tmp/wisp-probe-repo",
    harness: "claude",
    model: null,
    slot: freeSlot(),
    ...overrides,
  });
  setTaskFields(task.id, { session_id: "s-1" });
  transition(task.id, "done", "finished");
  return task.id;
}

describe("POST /api/tasks/:id/probe (A3)", () => {
  test("the happy path: a markdown report, probedAt, not cached — then the repeat click is", async () => {
    const base = await startServer();
    const id = probeTask();
    const res = await api(base, `/api/tasks/${id}/probe`, { command: "context" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.command).toBe("context");
    expect(body.cached).toBe(false);
    expect(typeof body.probedAt).toBe("string");
    expect(body.report).toEqual({ format: "markdown", text: "## Context Usage\n\n**Tokens:** 13.3k" });

    const again = await (await api(base, `/api/tasks/${id}/probe`, { command: "context" })).json();
    expect(again.cached).toBe(true);
    expect(again.probedAt).toBe(body.probedAt);
  });

  test("the refusal ladder: unknown task, missing command, unknown command names what IS available", async () => {
    const base = await startServer();
    expect((await api(base, "/api/tasks/nope/probe", { command: "context" })).status).toBe(404);

    const id = probeTask();
    let res = await api(base, `/api/tasks/${id}/probe`, {});
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "command is required" });

    res = await api(base, `/api/tasks/${id}/probe`, { command: "explode" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "harness 'claude' has no out-of-turn 'explode' read (it has: context, usage)",
    });
  });

  test("creating, running, and archived tasks all refuse with the expected 409s", async () => {
    const base = await startServer();

    const creating = createTask({
      id: newTaskId(),
      title: "still creating",
      repo_path: "/tmp/wisp-probe-repo",
      harness: "claude",
      model: null,
      slot: freeSlot(),
    });
    let res = await api(base, `/api/tasks/${creating.id}/probe`, { command: "context" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("task is still being created");

    const runningId = probeTask();
    transition(runningId, "running", "turn 1");
    createTurn(runningId, 1, "prompt", 99999, "/tmp/probe-test.out.log");
    res = await api(base, `/api/tasks/${runningId}/probe`, { command: "context" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("turn 1 is still running — a read waits for it");

    const archivedId = probeTask();
    setTaskFields(archivedId, { archived: 1 });
    res = await api(base, `/api/tasks/${archivedId}/probe`, { command: "context" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("task is archived — archived tasks are read-only");
  });

  test("a session-less task is told the truth: no session yet (409, nothing spawned)", async () => {
    let spawns = 0;
    const base = await startServer({
      probeSpawnOnce: async () => {
        spawns += 1;
        return { exitCode: 0, stdout: MD_RESULT, stderr: "" };
      },
    });
    const id = probeTask();
    setTaskFields(id, { session_id: null });
    const res = await api(base, `/api/tasks/${id}/probe`, { command: "context" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("no session yet — the first turn creates one");
    expect(spawns).toBe(0);
  });

  test("a harness with no probe strategy gets a named 400, not an empty panel", async () => {
    writeFileSync(
      ADAPTERS_PATH,
      JSON.stringify({ bare: { bin: "true", exec: [], parse: { format: "text" }, attach: null } }),
    );
    const base = await startServer();
    const id = probeTask({ harness: "bare" });
    const res = await api(base, `/api/tasks/${id}/probe`, { command: "context" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("harness 'bare' declares no out-of-turn reads");
  });

  test("a structured read: droid's context breakdown, normalized, with the rpc session closed", async () => {
    const calls: string[] = [];
    let closed = false;
    const base = await startServer({
      probeOpenRpc: () => ({
        call(method: string) {
          calls.push(method);
          if (method === "droid.load_session") return Promise.resolve({ sessionId: "s-1" });
          if (method === "droid.get_context_breakdown") {
            return Promise.resolve({
              modelDisplayName: "Opus 5",
              contextBudget: 250000,
              usedTokens: 11981,
              freeTokens: 238019,
              categories: [{ name: "System prompt", tokens: 1330 }],
              skills: [],
              mcpServers: [{ name: "linear", toolCount: 62, tokens: 371 }],
            });
          }
          return Promise.reject(new Error(`unexpected ${method}`));
        },
        close() {
          closed = true;
        },
      }),
    });
    const id = probeTask({ harness: "droid" });
    const res = await api(base, `/api/tasks/${id}/probe`, { command: "context" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.report).toEqual({
      format: "context",
      context: {
        model: "Opus 5",
        budgetTokens: 250000,
        usedTokens: 11981,
        freeTokens: 238019,
        categories: [{ name: "System prompt", tokens: 1330 }],
        skills: [],
        mcpServers: [{ name: "linear", toolCount: 62, tokens: 371 }],
      },
    });
    expect(calls).toEqual(["droid.load_session", "droid.get_context_breakdown"]);
    expect(closed).toBe(true);
  });

  test("/api/harnesses carries each adapter's probe commands (the palette's Tier 2)", async () => {
    const base = await startServer();
    const res = await fetch(`${base}/api/harnesses`, { headers: { authorization: `Bearer ${token}` } });
    const body = await res.json();
    const byName = Object.fromEntries(body.harnesses.map((h: { name: string }) => [h.name, h]));
    expect(byName.claude.probeCommands).toEqual(["context", "usage"]);
    expect(byName.droid.probeCommands).toEqual(["context"]);
    expect(byName.codex.probeCommands).toEqual(["usage"]);
  });
});
