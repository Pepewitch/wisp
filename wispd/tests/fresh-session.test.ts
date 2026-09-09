import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import type { AdapterDef } from "../src/adapters";
import type { WispConfig } from "../src/config";
import { route } from "../src/daemon";
import {
  createTask,
  createTurn,
  finishTurn,
  freeSlot,
  getTask,
  newTaskId,
  setTaskFields,
  transition,
  turnsFor,
} from "../src/store";

/**
 * POST /api/tasks/:id/fresh-session (S3, audit item 5): clears the stored
 * harness session id — a FIELD UPDATE, not a transition (the freeze stands).
 * Named 409s while running/creating/archived; the response is the updated
 * task row; the NEXT turn's argv carries no resume flag (buildArgv only
 * appends resume when a session exists — so "none" is the whole mechanism).
 */
const cfg: WispConfig = {
  instanceId: "123e4567-e89b-42d3-a456-426614174000",
  port: 0,
  host: "127.0.0.1",
  token: "test",
  webhooks: [],
  repos: [],
  stuckMinutes: 10,
  logMaxBytes: 5_000_000,
  setupTimeoutMinutes: 10,
  envAllowlist: {},
  harnessDefaults: {},
};

/** A bash harness WITH a resume template, so argv assertions can spot it. */
const bashResume: AdapterDef = {
  bin: "bash",
  exec: ["-c", 'printf "%s\\n" "$0" "$@"'], // one argv element per line
  resume: ["--resume", "{session}"],
  model: ["--model", "{model}"],
  parse: { format: "text" },
  attach: null,
};
const adapters = { bashresume: bashResume, bashother: { ...bashResume } };

function call(path: string, body?: unknown): Promise<Response> {
  const url = new URL(`http://wisp.test${path}`);
  return Promise.resolve(
    route(
      new Request(url, {
        method: "POST",
        ...(body === undefined
          ? {}
          : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
      }),
      url,
      url.pathname,
      cfg,
      adapters,
    ),
  );
}

async function errorOf(res: Response): Promise<string> {
  return ((await res.json()) as { error: string }).error;
}

/** A done task with a real worktree dir and a stored harness session. */
function readyTask(sessionId: string | null = "sess-1"): string {
  const task = createTask({
    id: newTaskId(),
    title: "fresh probe",
    repo_path: "/tmp/repo",
    harness: "bashresume",
    model: null,
    slot: freeSlot(),
  });
  setTaskFields(task.id, { worktree_path: mkdtempSync(join(tmpdir(), "wisp-fresh-wt-")), session_id: sessionId });
  transition(task.id, "done", "setup done");
  return task.id;
}

async function untilSettled(taskId: string, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    const t = turnsFor(taskId).at(-1);
    if (t && t.status !== "running") return;
    if (Date.now() > deadline) throw new Error("turn never settled");
    await Bun.sleep(50);
  }
}

describe("POST /api/tasks/:id/fresh-session (S3)", () => {
  test("clears session_id, responds with the updated row, and touches NO state-machine field", async () => {
    const id = readyTask("sess-1");
    const before = getTask(id)!;

    const res = await call(`/api/tasks/${id}/fresh-session`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { session_id: string | null; state: string };
    expect(body.session_id).toBeNull();
    expect(body.state).toBe("done");

    const after = getTask(id)!;
    expect(after.session_id).toBeNull();
    expect(after.state).toBe(before.state); // a field update, not a transition
    expect(after.seq).toBe(before.seq); // seq/notify untouched (the freeze)
  });

  test("an already-clear session is an idempotent 200, not an error", async () => {
    const id = readyTask(null);
    const res = await call(`/api/tasks/${id}/fresh-session`);
    expect(res.status).toBe(200);
    expect(getTask(id)!.session_id).toBeNull();
  });

  test("409 while a turn is running, while creating, and when archived", async () => {
    const running = readyTask();
    createTurn(running, 1, "prompt", null, join(tmpdir(), "fresh-running.log"));
    const runningRes = await call(`/api/tasks/${running}/fresh-session`);
    expect(runningRes.status).toBe(409);
    expect(await errorOf(runningRes)).toBe("turn 1 is still running");
    expect(getTask(running)!.session_id).toBe("sess-1"); // untouched

    const creating = createTask({
      id: newTaskId(),
      title: "creating",
      repo_path: "/tmp/repo",
      harness: "bashresume",
      model: null,
      slot: freeSlot(),
    }); // state stays 'creating'
    const creatingRes = await call(`/api/tasks/${creating.id}/fresh-session`);
    expect(creatingRes.status).toBe(409);
    expect(await errorOf(creatingRes)).toBe("task is still being created");

    const archived = readyTask();
    setTaskFields(archived, { archived: 1 });
    const archivedRes = await call(`/api/tasks/${archived}/fresh-session`);
    expect(archivedRes.status).toBe(409);
    expect(await errorOf(archivedRes)).toBe("task is archived — archived tasks are read-only");
  });

  test("the next turn starts a fresh session: no resume argv lands", async () => {
    const id = readyTask("sess-1");

    // control: with the session intact, the resume argv lands
    expect((await call(`/api/tasks/${id}/send`, { message: "first" })).status).toBe(200);
    await untilSettled(id);
    expect(readFileSync(turnsFor(id)[0]!.log_file, "utf8")).toContain("--resume\nsess-1\n");

    // after /fresh-session, turn 2's argv carries no resume flag
    expect((await call(`/api/tasks/${id}/fresh-session`)).status).toBe(200);
    expect((await call(`/api/tasks/${id}/send`, { message: "second" })).status).toBe(200);
    await untilSettled(id);
    const log2 = readFileSync(turnsFor(id)[1]!.log_file, "utf8");
    expect(log2).not.toContain("--resume");
    expect(log2).not.toContain("sess-1");
    expect(log2).toContain("second");
  }, 15_000);
});

describe("agent switching on send", () => {
  test("same-harness model changes preserve the provider session without confirmation", async () => {
    const id = readyTask("sess-1");
    const res = await call(`/api/tasks/${id}/send`, {
      message: "use the other model",
      harness: "bashresume",
      model: "model-b",
      clientMessageId: "same-harness-model",
    });
    expect(res.status).toBe(200);
    await untilSettled(id);

    const task = getTask(id)!;
    const turn = turnsFor(id)[0]!;
    expect(task).toMatchObject({ harness: "bashresume", model: "model-b", context_n: 1 });
    expect(turn).toMatchObject({
      context_n: 1,
      harness: "bashresume",
      requested_model: "model-b",
    });
    const log = readFileSync(turn.log_file, "utf8");
    expect(log).toContain("--resume\nsess-1\n");
    expect(log).toContain("--model\nmodel-b\n");
  });

  test("cross-harness changes require confirmation and start a durable fresh context", async () => {
    const id = readyTask("sess-1");
    let res = await call(`/api/tasks/${id}/send`, {
      message: "switch harness",
      harness: "bashother",
      model: "other-model",
      clientMessageId: "cross-harness-model",
    });
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toBe("changing harness requires startFreshContext: true");
    expect(getTask(id)).toMatchObject({ harness: "bashresume", context_n: 1, session_id: "sess-1" });

    res = await call(`/api/tasks/${id}/send`, {
      message: "switch harness",
      harness: "bashother",
      model: "other-model",
      startFreshContext: true,
      clientMessageId: "cross-harness-model",
    });
    expect(res.status).toBe(200);
    await untilSettled(id);

    const task = getTask(id)!;
    const turn = turnsFor(id)[0]!;
    expect(task).toMatchObject({ harness: "bashother", model: "other-model", context_n: 2 });
    expect(turn).toMatchObject({
      context_n: 2,
      harness: "bashother",
      requested_model: "other-model",
    });
    expect(readFileSync(turn.log_file, "utf8")).not.toContain("sess-1");
  });

  test("a confirmed switch during a running turn is queued with its target context", async () => {
    const id = readyTask("sess-1");
    const turnId = createTurn(id, 1, "still running", null, join(tmpdir(), "agent-switch-running.log"));

    const res = await call(`/api/tasks/${id}/send`, {
      message: "use the new harness next",
      harness: "bashother",
      model: "other-model",
      startFreshContext: true,
      clientMessageId: "queued-agent-switch",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      disposition: string;
      message: { context_n: number; harness: string; model: string };
    };
    expect(body.disposition).toBe("queued-next");
    expect(body.message).toMatchObject({
      context_n: 2,
      harness: "bashother",
      model: "other-model",
    });
    expect(getTask(id)).toMatchObject({ context_n: 2, harness: "bashother" });
    finishTurn(turnId, "interrupted", null, null);
  });
});
