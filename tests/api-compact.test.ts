import { afterEach, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { ADAPTERS_PATH, CONFIG_PATH, type WispConfig } from "../src/config";
import { serve } from "../src/daemon";
import { createTask, createTurn, freeSlot, getTask, newTaskId, setTaskFields, transition } from "../src/store";

/**
 * POST /api/tasks/:id/compact (A5) — the out-of-turn ACTION route. The
 * harness CLIs are faked through serve()'s compact injection; what is pinned
 * here is the CONTRACT: the refusal ladder, the session_id replacement, the
 * response shape the palette renders, and Q7's fallback (a failure names
 * what failed; the palette offers /fresh).
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

/** The scripted droid peer: load_session, then compact_session minting s-2. */
function droidRpc(state: { calls: string[]; closed: boolean }) {
  return () => ({
    call(method: string) {
      state.calls.push(method);
      if (method === "droid.load_session") return Promise.resolve({ sessionId: "s-1" });
      if (method === "droid.compact_session") return Promise.resolve({ newSessionId: "s-2", removedCount: 3 });
      return Promise.reject(new Error(`unexpected ${method}`));
    },
    close() {
      state.closed = true;
    },
  });
}

async function startServer(opts: Parameters<typeof serve>[0] = {}): Promise<string> {
  writeConfig();
  server = await serve({
    port: 0,
    modelProbeSpawn: () => {
      throw new Error("contract probe failed");
    },
    modelProbeTimeoutMs: 100,
    ...opts,
  });
  return `http://127.0.0.1:${server.port}`;
}

afterEach(async () => {
  if (server) await server.stop(true);
  server = null;
  rmSync(ADAPTERS_PATH, { force: true });
});

async function api(base: string, path: string): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: "{}",
  });
}

function compactTask(overrides: Partial<Parameters<typeof createTask>[0]> = {}) {
  const task = createTask({
    id: newTaskId(),
    title: "compact route task",
    repo_path: "/tmp/wisp-compact-repo",
    harness: "droid",
    model: null,
    slot: freeSlot(),
    ...overrides,
  });
  setTaskFields(task.id, { session_id: "s-1" });
  transition(task.id, "done", "finished");
  return task.id;
}

describe("POST /api/tasks/:id/compact (A5)", () => {
  test("droid end to end: removedCount, the session id REPLACED, the channel closed — and a second click compacts again", async () => {
    const state = { calls: [] as string[], closed: false };
    const base = await startServer({ compactOpenRpc: droidRpc(state) });
    const id = compactTask();
    const res = await api(base, `/api/tasks/${id}/compact`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, removedCount: 3, sessionReplaced: true, note: null });
    expect(getTask(id)!.session_id).toBe("s-2"); // a field update, no schema change (SP1)
    expect(state.calls).toEqual(["droid.load_session", "droid.compact_session"]);
    expect(state.closed).toBe(true);

    // an action is not a read: the second click runs a second compaction
    const again = await api(base, `/api/tasks/${id}/compact`);
    expect(again.status).toBe(200);
    expect(state.calls).toEqual(["droid.load_session", "droid.compact_session", "droid.load_session", "droid.compact_session"]);
  });

  test("the refusal ladder: unknown task, archived, creating, running — all named 409s", async () => {
    const base = await startServer();
    expect((await api(base, "/api/tasks/nope/compact")).status).toBe(404);

    const archivedId = compactTask();
    setTaskFields(archivedId, { archived: 1 });
    let res = await api(base, `/api/tasks/${archivedId}/compact`);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("task is archived — archived tasks are read-only");

    const creating = createTask({
      id: newTaskId(),
      title: "still creating",
      repo_path: "/tmp/wisp-compact-repo",
      harness: "droid",
      model: null,
      slot: freeSlot(),
    });
    res = await api(base, `/api/tasks/${creating.id}/compact`);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("task is still being created");

    const runningId = compactTask();
    transition(runningId, "running", "turn 1");
    createTurn(runningId, 1, "prompt", 99999, "/tmp/compact-test.out.log");
    res = await api(base, `/api/tasks/${runningId}/compact`);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("turn 1 is still running — compaction waits for it");
  });

  test("a session-less task is told the truth: 409, nothing spawned", async () => {
    let opens = 0;
    const base = await startServer({
      compactOpenRpc: () => {
        opens += 1;
        return { call: () => Promise.resolve({}), close() {} };
      },
    });
    const id = compactTask();
    setTaskFields(id, { session_id: null });
    const res = await api(base, `/api/tasks/${id}/compact`);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("no session yet — compaction needs a session to compact; run a turn first");
    expect(opens).toBe(0);
  });

  test("claude's compact is a prompt, not an action — the route says so rather than faking one", async () => {
    let opens = 0;
    const base = await startServer({
      compactOpenRpc: () => {
        opens += 1;
        return { call: () => Promise.resolve({}), close() {} };
      },
    });
    const id = compactTask({ harness: "claude" });
    const res = await api(base, `/api/tasks/${id}/compact`);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(
      "harness 'claude' compacts as an ordinary turn — send /compact as a prompt",
    );
    expect(opens).toBe(0);
  });

  test("a harness with no compaction at all gets a named 400", async () => {
    writeFileSync(
      ADAPTERS_PATH,
      JSON.stringify({ bare: { bin: "true", exec: [], parse: { format: "text" }, attach: null } }),
    );
    const base = await startServer();
    const id = compactTask({ harness: "bare" });
    const res = await api(base, `/api/tasks/${id}/compact`);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("harness 'bare' declares no compaction");
  });

  test("codex: the ack is not completion — the route answers after turn/completed, note naming the turn", async () => {
    const calls: string[] = [];
    let waiter: ((params: unknown) => void) | null = null;
    const base = await startServer({
      compactOpenRpc: () => ({
        call(method: string) {
          calls.push(method);
          return Promise.resolve({});
        },
        onNotification(method: string) {
          calls.push(`wait:${method}`);
          return new Promise((resolve) => {
            waiter = resolve;
          });
        },
        close() {},
      }),
    });
    const id = compactTask({ harness: "codex" });
    setTaskFields(id, { session_id: "t-1" });
    const pending = api(base, `/api/tasks/${id}/compact`);
    // the request is still in flight: the ack came back but the turn hasn't completed
    await new Promise((r) => setTimeout(r, 30));
    expect(calls).toEqual(["initialize", "thread/resume", "wait:turn/completed", "thread/compact/start"]);
    waiter!({ threadId: "t-1", turn: { status: "completed" } });
    const res = await pending;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      removedCount: null,
      sessionReplaced: false,
      note: "codex recorded it as a turn in its own thread",
    });
    expect(getTask(id)!.session_id).toBe("t-1"); // same thread, less context
  });

  test("a harness failure is the named reason (Q7's fallback: the palette adds the /fresh offer)", async () => {
    const base = await startServer({
      compactOpenRpc: () => ({
        call(method: string) {
          if (method === "droid.compact_session") {
            return Promise.reject(new Error("the harness rejected the probe: session not resumable"));
          }
          return Promise.resolve({});
        },
        close() {},
      }),
    });
    const id = compactTask();
    const res = await api(base, `/api/tasks/${id}/compact`);
    expect(res.status).toBe(500); // a raw Error is not a ProbeError — the daemon's catch names it
    expect(String((await res.json()).error)).toContain("session not resumable");
  });

  test("/api/harnesses carries each adapter's compaction kind (the palette's entry)", async () => {
    const base = await startServer();
    const res = await fetch(`${base}/api/harnesses`, { headers: { authorization: `Bearer ${token}` } });
    const body = await res.json();
    const byName = Object.fromEntries(body.harnesses.map((h: { name: string }) => [h.name, h]));
    expect(byName.claude.compact).toEqual({ kind: "prompt", prompt: "/compact" });
    expect(byName.droid.compact).toEqual({ kind: "action", recordsTurn: false });
    expect(byName.codex.compact).toEqual({ kind: "action", recordsTurn: true });
  });
});
