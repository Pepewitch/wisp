// What `wisp wait`, `send`, `result` and `show` read: the task row or the
// pages they need rather than the full detail, against this daemon and
// against an older one that ignores `view=` and has no paged conversation.
import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ApiSubtask, ApiTurn } from "../../shared/api/task";
import { CONFIG_PATH } from "../src/config";
import { serve } from "../src/daemon";
import { createTask, createTurn, finishTurn, freeSlot, newTaskId, transition } from "../src/store";

const token = "cli-slim-reads-token";
const entry = join(import.meta.dir, "..", "src", "index.ts");
let stop: (() => Promise<void>) | null = null;

function writeConfig(port: number): void {
  writeFileSync(CONFIG_PATH, JSON.stringify({
    port, host: "127.0.0.1", token, webhooks: [], repos: [], stuckMinutes: 10, logMaxBytes: 5_000_000,
    setupTimeoutMinutes: 10, envAllowlist: {}, harnessDefaults: {},
  }));
}

afterEach(async () => {
  await stop?.();
  stop = null;
});

async function startDaemon(): Promise<void> {
  writeConfig(18710);
  const server = await serve({ port: 0, modelProbeSpawn: () => { throw new Error("probe disabled in tests"); }, modelProbeTimeoutMs: 100 });
  writeConfig(server.port!);
  stop = () => server.stop(true);
}

/** A stand-in daemon answering from `answer`, recording every path it was asked. */
function startStub(answer: (path: string) => unknown): string[] {
  const asked: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname + url.search;
      asked.push(path);
      const body = answer(path);
      return body === undefined ? Response.json({ error: "not found" }, { status: 404 }) : Response.json(body);
    },
  });
  writeConfig(server.port!);
  stop = async () => void server.stop(true);
  return asked;
}

async function run(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const env = { ...process.env };
  delete env.WISP_TASK_ID;
  delete env.WISP_AGENT_TURN;
  const proc = Bun.spawn({ cmd: ["bun", entry, ...args], env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, exitCode };
}

const turn = (n: number, result: string | null): ApiTurn => ({ n, prompt: `prompt ${n}`, result, status: "done", failure_detail: null }) as ApiTurn;
const row = { id: "tslim1", state: "done", state_detail: "finished", harness: "claude", background: { state: "none", groups: 0, details: [] } };

describe("GET /api/tasks/:id?view=summary", () => {
  test("is the task row alone; any other view is a 400", async () => {
    await startDaemon();
    const task = createTask({ id: newTaskId(), title: "summary", repo_path: "/tmp/repo", harness: "claude", model: null, slot: freeSlot() });
    finishTurn(createTurn(task.id, 1, "go", null, "/tmp/summary.log"), "done", 0, "ok");
    transition(task.id, "done", "finished");
    const port = (JSON.parse(await Bun.file(CONFIG_PATH).text()) as { port: number }).port;
    const get = (query: string) => fetch(`http://127.0.0.1:${port}/api/tasks/${task.id}${query}`, { headers: { authorization: `Bearer ${token}` } });

    const summary = (await (await get("?view=summary")).json()) as Record<string, unknown>;
    const detail = (await (await get("")).json()) as Record<string, unknown>;
    expect(summary).toMatchObject({ id: task.id, state: "done", state_detail: "finished", harness: "claude", background: { state: "none" } });
    for (const key of ["turns", "messages", "diffstat", "worktreeReason", "pending_question_id"]) expect(summary).not.toHaveProperty(key);
    // every field of the summary is in the full detail, the answer an older daemon gives
    for (const key of Object.keys(summary)) expect(detail).toHaveProperty(key);

    const bad = await get("?view=full");
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "view must be summary, got 'full'" });
  });
});

describe("wisp wait and wisp send read the task row", () => {
  test("wait asks for the summary, and an older daemon's full detail answers it the same", async () => {
    for (const older of [false, true]) {
      const asked = startStub((path) => path.startsWith("/api/tasks/tslim1") ? (older ? { ...row, turns: [turn(1, "ok")], messages: [], diffstat: null } : row) : undefined);
      const result = await run(["wait", "tslim1"]);
      expect({ older, exitCode: result.exitCode, stdout: result.stdout }).toEqual({ older, exitCode: 0, stdout: "tslim1  done — finished\n" });
      expect(asked).toEqual(["/api/tasks/tslim1?view=summary"]);
      await stop!();
      stop = null;
    }
  });

  test("send reads only the summary to check a model against the task's harness", async () => {
    const asked = startStub((path) => {
      if (path === "/api/tasks/tslim1?view=summary") return row;
      if (path === "/api/harnesses") return { harnesses: [{ name: "claude", hasModel: true, hasEffort: true, models: [{ id: "opus" }] }] };
      if (path === "/api/tasks/tslim1/send") return { ...row, disposition: "queued-next", messageId: "m1", turn: null };
      return undefined;
    });
    await run(["send", "tslim1", "--model", "opus", "carry on"]);
    expect(asked[0]).toBe("/api/tasks/tslim1?view=summary");
    expect(asked).not.toContain("/api/tasks/tslim1");
  });
});

describe("wisp result reads pages, not the full detail", () => {
  /** 150 turns; only turn 40 and turn 140 have a result, so the newest answer is two pages back from 150. */
  const turns = Array.from({ length: 150 }, (_, i) => turn(i + 1, i + 1 === 40 ? "the old answer" : i + 1 === 140 ? "the answer" : null));
  const page = (before: number | null, limit: number) => {
    const upTo = before === null ? turns.length : Math.min(turns.length, before - 1);
    const slice = turns.slice(Math.max(0, upTo - limit), upTo);
    const hasOlder = upTo - limit > 0;
    return { ...row, turns: slice, messages: [], has_older_turns: hasOlder, older_turns_before: hasOlder ? slice[0]!.n : null };
  };
  const paged = (path: string) => {
    const match = /^\/api\/tasks\/tslim1\/conversation\?limit=(\d+)(?:&before=(\d+))?$/.exec(path);
    return match ? page(match[2] ? Number(match[2]) : null, Number(match[1])) : undefined;
  };
  const full = (path: string) => (path === "/api/tasks/tslim1" ? { ...row, turns, messages: [], diffstat: null } : undefined);

  test("the newest turn with a result, found two pages back; the same answer from older daemons", async () => {
    const expected = "── you (turn 140) ──\nprompt 140\n── agent ──\nthe answer\n";
    const daemons: [string, (path: string) => unknown, string[]][] = [
      ["paged", paged, ["/api/tasks/tslim1/conversation?limit=10", "/api/tasks/tslim1/conversation?limit=100&before=141"]],
      // a daemon whose conversation route ignores limit and answers every turn
      ["unpaged", (path) => (path.startsWith("/api/tasks/tslim1/conversation") ? { ...row, turns, messages: [] } : undefined), ["/api/tasks/tslim1/conversation?limit=10"]],
      // a daemon from before the conversation route
      ["no conversation route", full, ["/api/tasks/tslim1/conversation?limit=10", "/api/tasks/tslim1"]],
    ];
    for (const [name, answer, requests] of daemons) {
      const asked = startStub(answer);
      const result = await run(["result", "tslim1"]);
      expect({ name, stdout: result.stdout, exitCode: result.exitCode }).toEqual({ name, stdout: expected, exitCode: 0 });
      expect({ name, asked }).toEqual({ name, asked: requests });
      await stop!();
      stop = null;
    }
  });

  test("a named turn is one turn's page; one that does not exist is 'no turns yet', as before", async () => {
    const asked = startStub((path) => paged(path) ?? full(path));
    const named = await run(["result", "tslim1", "40"]);
    expect(named.stdout).toBe("── you (turn 40) ──\nprompt 40\n── agent ──\nthe old answer\n");
    expect(asked).toEqual(["/api/tasks/tslim1/conversation?limit=1&before=41"]);
    const missing = await run(["result", "tslim1", "151"]);
    expect({ exitCode: missing.exitCode, stderr: missing.stderr }).toEqual({ exitCode: 1, stderr: "no turns yet\n" });
    const bogus = await run(["result", "tslim1", "1.5"]);
    expect({ exitCode: bogus.exitCode, stderr: bogus.stderr }).toEqual({ exitCode: 1, stderr: "no turns yet\n" });
  });

  test("against this daemon: the newest turn's answer, and the newest turn when none has one", async () => {
    await startDaemon();
    const task = createTask({ id: newTaskId(), title: "result", repo_path: "/tmp/repo", harness: "claude", model: null, slot: freeSlot() });
    for (let n = 1; n <= 12; n++) finishTurn(createTurn(task.id, n, `ask ${n}`, null, `/tmp/result-${n}.log`), "done", 0, n === 2 ? "answered at 2" : null);
    expect((await run(["result", task.id])).stdout).toBe("── you (turn 2) ──\nask 2\n── agent ──\nanswered at 2\n");
    const quiet = createTask({ id: newTaskId(), title: "quiet", repo_path: "/tmp/repo", harness: "claude", model: null, slot: freeSlot() });
    createTurn(quiet.id, 1, "still going", null, "/tmp/result-quiet.log");
    expect((await run(["result", quiet.id])).stdout).toBe("── you (turn 1) ──\nstill going\n── agent ──\n(turn 1 is running, no result text)\n");
    const missing = await run(["result", "tnope9"]);
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain("no such task: tnope9");
  });
});

describe("wisp show lists a parent's unarchived subtasks", () => {
  const child = (id: string, archived: boolean): ApiSubtask => ({ id, title: `child ${id}`, kind: "explore", reviewer: false, state: "done", archived } as ApiSubtask);
  const answer = (path: string) => {
    if (path === "/api/tasks/tparent") return { ...row, id: "tparent", parent_task_id: null, subtask_kind: null, turns: [], messages: [], diffstat: null, worktreeReason: null, worktree_path: null, branch: null, session_id: null, effort: null, fast: false, model: null };
    if (path === "/api/tasks/tparent/subtasks") return [child("tlive1", false), child("tgone1", true), child("tlive2", false), child("tgone2", true), child("tgone3", true)];
    return undefined;
  };

  test("archived children are counted, and --all lists them", async () => {
    startStub(answer);
    const shown = await run(["show", "tparent"]);
    expect(shown.stdout).toContain("subtasks:\n  tlive1  done  explore  child tlive1\n  tlive2  done  explore  child tlive2\n  … and 3 archived (");
    expect(shown.stdout).toContain("show tparent --all lists them)");
    expect(shown.stdout).not.toContain("tgone1");
    const all = await run(["show", "tparent", "--all"]);
    expect(all.stdout).toContain(
      "subtasks:\n  tlive1  done  explore  child tlive1\n  tgone1  archived  explore  child tgone1\n  tlive2  done  explore  child tlive2\n" +
        "  tgone2  archived  explore  child tgone2\n  tgone3  archived  explore  child tgone3\n",
    );
    expect(all.stdout).not.toContain("… and");
  });
});
