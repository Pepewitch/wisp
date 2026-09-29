import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import type { AdapterDef } from "../src/adapters";
import type { WispConfig } from "../src/config";
import { subscribe } from "../src/events";
import { STOPPING } from "../src/interrupt-state";
import { turnInput } from "../src/live-input";
import { route } from "../src/routes";
import { sendTaskBodyError } from "../src/routes/send-agent";
import { hasRunningTurn, sendQueuedMessageNow, startNextQueuedMessage, startTurn, submitTaskMessage } from "../src/runner";
import { createTask, createTaskMessage, db, freeSlot, getTask, messagesFor, newTaskId, setTaskFields, transition, turnsFor } from "../src/store";
import { validateWorkflowParams } from "../src/workflows/definitions";
import { workflowById } from "../src/workflows/plugins";
import { createWorkflow, getWorkflow } from "../src/workflows/store";

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

function bashAdapter(script: string): AdapterDef {
  return { bin: "bash", exec: ["-c", script], parse: { format: "text" }, attach: null };
}

/** A stream-json harness: reads its prompt, then each line it is steered, until stdin closes. */
function liveAdapter(script: string): AdapterDef {
  return {
    bin: "bash",
    exec: ["-c", script],
    liveInput: "claude-stream-json",
    parse: { format: "json", resultType: "result", result: "result", session: "session_id" },
    attach: null,
  };
}

const RESULT = `printf '%s\\n' '{"type":"result","result":"done","session_id":"session-live"}'`;

function makeTask() {
  const task = createTask({
    id: newTaskId(),
    title: "send delivery test",
    repo_path: "/tmp/repo",
    harness: "fake",
    model: null,
    slot: freeSlot(),
  });
  setTaskFields(task.id, { worktree_path: mkdtempSync(join(tmpdir(), "wisp-delivery-")) });
  return getTask(task.id)!;
}

async function until(pred: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await Bun.sleep(50);
  }
}

const prompts = (taskId: string) => turnsFor(taskId).map((turn) => [turn.prompt, turn.status]);

describe("a message held for the next turn", () => {
  test("is never steered, and a later ordinary message steers past it", async () => {
    // the next turn has nothing steered into it, so it stops waiting on its own
    const def = liveAdapter(["IFS= read -r first", "IFS= read -r -t 2 second", RESULT].join("; "));
    const task = makeTask();
    startTurn(task, "original", def, cfg);
    await until(() => hasRunningTurn(task.id) !== null);
    expect(turnInput(task.id)?.mode).toBe("steer");

    const held = await submitTaskMessage(getTask(task.id)!, "later", def, cfg, [], undefined, { fake: def }, undefined, "hold");
    expect(held.disposition).toBe("queued-next");
    expect(held.message).toMatchObject({ status: "queued", deferred: 1 });

    const steered = await submitTaskMessage(getTask(task.id)!, "correction", def, cfg, [], undefined, { fake: def });
    expect(steered.disposition).toBe("steered");

    await until(() => turnsFor(task.id)[1]?.status === "done");
    expect(turnsFor(task.id).map((turn) => turn.prompt)).toEqual(["original", "later"]);
    expect(messagesFor(task.id).map((message) => [message.text, message.delivery, message.turn_n])).toEqual([
      ["later", "started", 2],
      ["correction", "steered", 1],
    ]);
  }, 20_000);

  test("waits behind a message queued after it without the hold", async () => {
    const def = bashAdapter('sleep 0.3; printf "ok\\n"');
    const task = makeTask();
    startTurn(task, "first", def, cfg);
    await until(() => hasRunningTurn(task.id) !== null);
    expect(turnInput(task.id)?.mode).toBe("interrupt");

    await submitTaskMessage(getTask(task.id)!, "held", def, cfg, [], undefined, { fake: def }, undefined, "hold");
    await submitTaskMessage(getTask(task.id)!, "ordinary", def, cfg, [], undefined, { fake: def });

    await until(() => turnsFor(task.id).length === 3 && turnsFor(task.id)[2]?.status === "done");
    expect(turnsFor(task.id).map((turn) => turn.prompt)).toEqual(["first", "ordinary", "held"]);
    expect(turnInput(task.id)).toBeNull();
  }, 20_000);
});

describe("a message sent now", () => {
  test("stops a turn that has no live input, then starts in its place", async () => {
    const def = bashAdapter("sleep 30");
    const task = makeTask();
    startTurn(task, "long turn", def, cfg);
    await until(() => hasRunningTurn(task.id) !== null);

    const result = await submitTaskMessage(
      getTask(task.id)!, "new direction", bashAdapter('printf "ok\\n"'), cfg, [], undefined,
      { fake: bashAdapter('printf "ok\\n"') }, undefined, "now",
    );

    expect(result).toMatchObject({ disposition: "started", interrupted: true });
    await until(() => turnsFor(task.id)[1]?.status === "done");
    expect(prompts(task.id)).toEqual([["long turn", "interrupted"], ["new direction", "done"]]);
  }, 20_000);

  test("steers into a live turn without stopping it", async () => {
    const def = liveAdapter(["IFS= read -r first", "IFS= read -r second", RESULT].join("; "));
    const task = makeTask();
    startTurn(task, "original", def, cfg);
    await until(() => hasRunningTurn(task.id) !== null);

    const result = await submitTaskMessage(getTask(task.id)!, "correction", def, cfg, [], undefined, { fake: def }, undefined, "now");

    expect(result.disposition).toBe("steered");
    expect(result.interrupted).toBeUndefined();
    await until(() => turnsFor(task.id)[0]?.status === "done");
    expect(prompts(task.id)).toEqual([["original", "done"]]);
  }, 20_000);

  test("lets a turn that already answered finish, then starts next", async () => {
    // the answer is out, so the live channel closes; the process is still exiting
    const def = liveAdapter(["IFS= read -r first", RESULT, "sleep 1"].join("; "));
    const task = makeTask();
    startTurn(task, "original", def, cfg);
    await until(() => hasRunningTurn(task.id) !== null && turnInput(task.id)?.mode === "wait");

    const result = await submitTaskMessage(getTask(task.id)!, "follow-up", def, cfg, [], undefined, { fake: def }, undefined, "now");

    expect(result.disposition).toBe("queued-next");
    expect(result.interrupted).toBeUndefined();
    await until(() => turnsFor(task.id)[1]?.status === "done");
    expect(prompts(task.id)).toEqual([["original", "done"], ["follow-up", "done"]]);
  }, 20_000);

  test("send-now lifts a queued message's hold and delivers it", async () => {
    const def = bashAdapter("sleep 30");
    const task = makeTask();
    startTurn(task, "long turn", def, cfg);
    await until(() => hasRunningTurn(task.id) !== null);
    const quick = bashAdapter('printf "ok\\n"');
    const held = await submitTaskMessage(getTask(task.id)!, "held", quick, cfg, [], undefined, { fake: quick }, undefined, "hold");
    expect(held.disposition).toBe("queued-next");

    const result = await sendQueuedMessageNow(task.id, held.message.id, { fake: quick }, cfg);

    expect(result).toMatchObject({ disposition: "started", interrupted: true });
    expect(result?.message.deferred).toBe(0);
    await until(() => turnsFor(task.id)[1]?.status === "done");
    expect(prompts(task.id)).toEqual([["long turn", "interrupted"], ["held", "done"]]);
    expect(await sendQueuedMessageNow(task.id, held.message.id, { fake: quick }, cfg)).toBeNull();
  }, 20_000);

  test("behind an older queued message, keeps its place and lets the turn run", async () => {
    const def = bashAdapter('sleep 0.5; printf "ok\\n"');
    const task = makeTask();
    startTurn(task, "first", def, cfg);
    await until(() => hasRunningTurn(task.id) !== null);
    createTaskMessage({ id: `older-${task.id}`, taskId: task.id, text: "older", attachmentHash: "" });

    const result = await submitTaskMessage(getTask(task.id)!, "newer", def, cfg, [], undefined, { fake: def }, undefined, "now");

    expect(result.disposition).toBe("queued-next");
    expect(result.interrupted).toBeUndefined();
    await until(() => turnsFor(task.id).length === 3 && turnsFor(task.id)[2]?.status === "done");
    expect(prompts(task.id)).toEqual([["first", "done"], ["older", "done"], ["newer", "done"]]);
  }, 20_000);

  test("stops a workflow's turn without pausing the workflow, and runs next", async () => {
    const def = bashAdapter("sleep 30");
    const task = makeTask();
    const heartbeat = workflowById("heartbeat")!.definition;
    const flow = createWorkflow(task.id, heartbeat, validateWorkflowParams(heartbeat, { prompt: "Check the objective" }));
    const round = `round-${task.id}`;
    createTaskMessage({ id: round, taskId: task.id, text: "workflow round", attachmentHash: "", origin: "workflow" });
    db.run("UPDATE task_messages SET workflow_id = ? WHERE id = ?", [flow.id, round]);
    expect(startNextQueuedMessage(task.id, { fake: def }, cfg, round)?.delivery).toBe("started");
    await until(() => hasRunningTurn(task.id) !== null);

    const quick = bashAdapter('printf "ok\\n"');
    const result = await submitTaskMessage(getTask(task.id)!, "new direction", quick, cfg, [], undefined, { fake: quick }, undefined, "now");

    expect(result).toMatchObject({ disposition: "started", interrupted: true });
    await until(() => turnsFor(task.id)[1]?.status === "done");
    expect(prompts(task.id)).toEqual([["workflow round", "interrupted"], ["new direction", "done"]]);
    expect(getWorkflow(flow.id)?.state).toBe("active");
  }, 20_000);

  test("while it stops the turn, another send is refused without talk of a Stop", async () => {
    // the turn takes a second to exit once asked
    const def = bashAdapter("trap 'sleep 1; exit 0' TERM; sleep 30 & wait");
    const task = makeTask();
    startTurn(task, "long turn", def, cfg);
    await until(() => hasRunningTurn(task.id) !== null);
    const quick = bashAdapter('printf "ok\\n"');

    const first = submitTaskMessage(getTask(task.id)!, "first", quick, cfg, [], undefined, { fake: quick }, undefined, "now");
    await until(() => getTask(task.id)?.state_detail === STOPPING);
    const second = submitTaskMessage(getTask(task.id)!, "second", quick, cfg, [], undefined, { fake: quick }, undefined, "now");

    await expect(second).rejects.toThrow("The running turn is stopping so an earlier message can start; try again in a moment.");
    expect(await first).toMatchObject({ interrupted: true });
  }, 20_000);
});

test("a turn that has answered tells clients it now waits", async () => {
  const def = liveAdapter(["IFS= read -r first", RESULT, "sleep 1"].join("; "));
  const task = makeTask();
  const modes: (string | undefined)[] = [];
  const unsubscribe = subscribe((event) => {
    if (event.type === "task" && event.taskId === task.id) modes.push(turnInput(task.id)?.mode);
  });
  try {
    startTurn(task, "original", def, cfg);
    await until(() => turnInput(task.id)?.mode === "wait");
    expect(modes).toContain("wait");
  } finally {
    unsubscribe();
  }
  await until(() => turnsFor(task.id)[0]?.status === "done");
}, 20_000);

test("send validates when", () => {
  expect(sendTaskBodyError({ message: "x", when: "now" })).toBeNull();
  expect(sendTaskBodyError({ message: "x", when: "next-turn" })).toBeNull();
  expect(sendTaskBodyError({ message: "x", when: "later" })?.status).toBe(400);
  expect(sendTaskBodyError({ message: "x", when: 1 })?.status).toBe(400);
});

describe("over the API", () => {
  const call = async (path: string, adapters: Record<string, AdapterDef>, init: RequestInit = {}) => {
    const url = new URL(`http://127.0.0.1${path}`);
    const response = await route(new Request(url, init), url, url.pathname, cfg, adapters);
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };

  test("advertises the feature, so a client can tell an older daemon apart", async () => {
    const { body } = await call("/api/harnesses", {});
    expect((body.features as Record<string, unknown>).steerDelivery).toBe(true);
  });

  test("a held send reports the hold and the running turn's input", async () => {
    const def = bashAdapter("sleep 1");
    const task = makeTask();
    startTurn(task, "long turn", def, cfg);
    await until(() => hasRunningTurn(task.id) !== null);

    const sent = await call(`/api/tasks/${task.id}/send`, { fake: def }, {
      method: "POST",
      body: JSON.stringify({ message: "later", when: "next-turn" }),
    });

    expect(sent.status).toBe(200);
    expect(sent.body).toMatchObject({
      disposition: "queued-next",
      message: { text: "later", deferred: true },
      turn_input: { mode: "interrupt", harness: "fake", model: null, fast: false },
    });
    expect(sent.body.interrupted).toBeUndefined();
    expect(turnsFor(task.id)).toHaveLength(1);
    await until(() => turnsFor(task.id)[1]?.status === "done");
  }, 20_000);

  test("send-now refuses what it cannot send, by name", async () => {
    const task = makeTask();
    createTaskMessage({ id: "workflow-generated", taskId: task.id, text: "fix ci", attachmentHash: "" });
    db.run("UPDATE task_messages SET workflow_id = 'wflow' WHERE id = 'workflow-generated'");
    createTaskMessage({ id: "already-cancelled", taskId: task.id, text: "never mind", attachmentHash: "" });
    db.run("UPDATE task_messages SET status = 'cancelled' WHERE id = 'already-cancelled'");

    const post = (id: string) => call(`/api/tasks/${task.id}/messages/${id}/send-now`, {}, { method: "POST" });
    expect(await post("already-cancelled")).toEqual({ status: 409, body: { error: "task is still being created" } });
    transition(task.id, "done");
    expect((await post("workflow-generated")).status).toBe(409);
    expect(await post("already-cancelled")).toEqual({ status: 409, body: { error: "only queued messages can be sent now" } });
    expect((await post("no-such-message")).status).toBe(404);
    expect((await call(`/api/tasks/${task.id}/messages/already-cancelled/send-now`, {})).status).toBe(405);
  });
});
