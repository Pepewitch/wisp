import { afterEach, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { ADAPTERS_PATH, CONFIG_PATH, type WispConfig } from "../src/config";
import { serve } from "../src/daemon";
import { createTask, createTurn, freeSlot, newTaskId, setTaskFields, transition } from "../src/store";

/**
 * GET /api/tasks/:id/skills (A4) — the harness's own skill list for the
 * palette's Tier 3. Harness CLIs are faked through serve()'s injection; what
 * is pinned here is the CONTRACT: the refusal ladder, the honest-empty answer
 * for a harness with no discovery, and the response shape the palette
 * renders.
 */

const token = "web-test-token";
let server: Awaited<ReturnType<typeof serve>> | null = null;

function writeConfig(): void {
  const cfg: WispConfig = {
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
  return fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } });
}

function skillTask(overrides: Partial<Parameters<typeof createTask>[0]> = {}) {
  const task = createTask({
    id: newTaskId(),
    title: "skills route task",
    repo_path: "/tmp/wisp-skills-repo",
    harness: "claude",
    model: null,
    slot: freeSlot(),
    ...overrides,
  });
  transition(task.id, "done", "finished");
  return task.id;
}

describe("GET /api/tasks/:id/skills (A4)", () => {
  test("claude answers from the task's stored init list — no spawn, no session needed", async () => {
    let rpcOpened = false;
    const base = await startServer({
      skillOpenRpc: () => {
        rpcOpened = true;
        return { call: () => Promise.resolve({}), close: () => {} };
      },
    });
    const id = skillTask();
    setTaskFields(id, { skills_json: JSON.stringify(["code-review", "simplify"]) });

    const res = await api(base, `/api/tasks/${id}/skills`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.skills).toEqual([
      { name: "code-review", description: null },
      { name: "simplify", description: null },
    ]);
    expect(body.invoke).toBe("slash");
    expect(body.partialNote).toBeNull();
    expect(body.cached).toBe(false);
    expect(rpcOpened).toBe(false);

    const again = await (await api(base, `/api/tasks/${id}/skills`)).json();
    expect(again.cached).toBe(true);
  });

  test("before the first turn the answer is honestly partial", async () => {
    const base = await startServer();
    const res = await api(base, `/api/tasks/${skillTask()}/skills`);
    const body = await res.json();
    expect(body.partialNote).toBe("user and project skills only — no session has reported its builtins yet");
  });

  test("the refusal ladder matches the probe route's: archived, creating, running", async () => {
    const base = await startServer();

    const archivedId = skillTask();
    setTaskFields(archivedId, { archived: 1 });
    let res = await api(base, `/api/tasks/${archivedId}/skills`);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("task is archived — archived tasks are read-only");

    const creating = createTask({
      id: newTaskId(),
      title: "still creating",
      repo_path: "/tmp/wisp-skills-repo",
      harness: "claude",
      model: null,
      slot: freeSlot(),
    });
    res = await api(base, `/api/tasks/${creating.id}/skills`);
    expect(res.status).toBe(409);

    const runningId = skillTask();
    transition(runningId, "running", "turn 1");
    createTurn(runningId, 1, "prompt", 99999, "/tmp/skills-test.out.log");
    res = await api(base, `/api/tasks/${runningId}/skills`);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("turn 1 is still running — a read waits for it");

    expect((await api(base, "/api/tasks/nope/skills")).status).toBe(404);
  });

  test("a harness with no discovery strategy gets an honest empty answer, not an error", async () => {
    writeFileSync(
      ADAPTERS_PATH,
      JSON.stringify({ bare: { bin: "true", exec: [], parse: { format: "text" }, attach: null } }),
    );
    const base = await startServer();
    const res = await api(base, `/api/tasks/${skillTask({ harness: "bare" })}/skills`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.skills).toEqual([]);
    expect(body.partialNote).toBe("harness 'bare' declares no skill discovery");
  });

  test("droid's list comes over the injected rpc, filtered by the harness's own flags", async () => {
    const base = await startServer({
      skillOpenRpc: () => ({
        call(method: string) {
          if (method === "droid.load_session") return Promise.resolve({});
          if (method === "droid.list_skills") {
            return Promise.resolve({
              skills: [
                { name: "review", description: "Review code changes", enabled: true, userInvocable: true },
                { name: "tuistory", description: "TUI testing", enabled: true, userInvocable: false },
              ],
            });
          }
          return Promise.reject(new Error(`unexpected ${method}`));
        },
        close: () => {},
      }),
    });
    const id = skillTask({ harness: "droid" });
    setTaskFields(id, { session_id: "s-9" });
    const res = await api(base, `/api/tasks/${id}/skills`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.skills).toEqual([{ name: "review", description: "Review code changes" }]);
    expect(body.invoke).toBe("slash");
  });

  test("codex answers prompt-invoke, no session required, with malformed skills surfaced", async () => {
    const base = await startServer({
      skillOpenRpc: () => ({
        call(method: string) {
          if (method === "initialize") return Promise.resolve({});
          if (method === "skills/list") {
            return Promise.resolve([
              {
                cwd: "/tmp/wisp-skills-repo",
                skills: [{ name: "openai-docs", description: "Codex docs", enabled: true }],
                errors: [{ message: "Missing 'description' in frontmatter", path: "/bad/SKILL.md" }],
              },
            ]);
          }
          return Promise.reject(new Error(`unexpected ${method}`));
        },
        close: () => {},
      }),
    });
    const id = skillTask({ harness: "codex" });
    const res = await api(base, `/api/tasks/${id}/skills`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.invoke).toBe("prompt"); // codex has no headless /name — the palette must not pretend
    expect(body.skills).toEqual([{ name: "openai-docs", description: "Codex docs" }]);
    expect(body.errors).toEqual(["/bad/SKILL.md: Missing 'description' in frontmatter"]);
  });

  test("a session-less droid task is told the truth (409), and nothing is spawned", async () => {
    let opened = 0;
    const base = await startServer({
      skillOpenRpc: () => {
        opened += 1;
        return { call: () => Promise.resolve({}), close: () => {} };
      },
    });
    const id = skillTask({ harness: "droid" }); // no session_id set
    const res = await api(base, `/api/tasks/${id}/skills`);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("no session yet — the first turn creates one");
    expect(opened).toBe(0);
  });
});
