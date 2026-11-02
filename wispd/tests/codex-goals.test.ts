import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import type { AdapterDef } from "../src/adapters";
import type { WispConfig } from "../src/config";
import { lingerTiming } from "../src/live-input";
import { processGroupAlive, signalProcessGroup } from "../src/process-tree";
import { startTurn, submitTaskMessage } from "../src/runner";
import { createTask, freeSlot, getTask, newTaskId, setTaskFields, turnsFor } from "../src/store";

/**
 * Codex Goals (#491): a thread with an active goal goes on by itself after a
 * turn ends — the app-server starts the next turn about a tenth of a second
 * later (live-probed on 0.164.0). Wisp keeps the app-server open for it and
 * records each such turn, and lets it go once the goal is no longer active
 * or no continuation comes.
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

const started: string[] = [];
const timing = { ...lingerTiming };

afterEach(() => {
  Object.assign(lingerTiming, timing);
  for (const taskId of started.splice(0)) {
    for (const turn of turnsFor(taskId)) if (turn.pid && processGroupAlive(turn.pid)) signalProcessGroup(turn.pid, "SIGKILL");
  }
});

async function until(pred: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await Bun.sleep(50);
  }
}

/**
 * A fake app-server. MODE=continue: the first turn leaves the goal active and
 * the server starts turn-auto by itself, which completes the goal. MODE=stall:
 * the goal stays active and nothing continues. Every turn/start Wisp sends
 * gets its own turn id. It exits when stdin closes.
 */
const FAKE = `#!/usr/bin/env bun
import { createInterface } from "node:readline";
const MODE = process.env.FAKE_MODE;
const THREAD = "goal-thread";
const out = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const notify = (method, params) => out({ jsonrpc: "2.0", method, params });
const goal = (status, turnId) => notify("thread/goal/updated", { threadId: THREAD, turnId, goal: { threadId: THREAD, objective: "two steps", status, tokenBudget: null, tokensUsed: 1, timeUsedSeconds: 1, createdAt: 1, updatedAt: 1 } });
const answer = (turnId, text) => notify("item/completed", { threadId: THREAD, turnId, item: { type: "agentMessage", id: "m-" + turnId, text, phase: "final_answer" } });
const complete = (turnId) => notify("turn/completed", { threadId: THREAD, turn: { id: turnId, status: "completed", error: null } });
let starts = 0;
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  const request = JSON.parse(line);
  if (request.method === "initialize") out({ jsonrpc: "2.0", id: request.id, result: {} });
  else if (request.method === "thread/start" || request.method === "thread/resume") out({ jsonrpc: "2.0", id: request.id, result: { thread: { id: THREAD }, model: "fake" } });
  else if (request.method === "turn/start") {
    starts += 1;
    const turnId = "turn-" + starts;
    out({ jsonrpc: "2.0", id: request.id, result: { turn: { id: turnId } } });
    notify("turn/started", { threadId: THREAD, turn: { id: turnId, status: "inProgress" } });
    if (starts > 1) { goal("complete", turnId); answer(turnId, "DONE " + turnId); complete(turnId); continue; }
    goal("active", turnId);
    answer(turnId, "step 1 done");
    complete(turnId);
    if (MODE === "continue") {
      await Bun.sleep(100);
      notify("turn/started", { threadId: THREAD, turn: { id: "turn-auto", status: "inProgress" } });
      goal("complete", "turn-auto");
      answer("turn-auto", "DONE turn-auto");
      complete("turn-auto");
    }
  }
}
`;

function fakeCodex(mode: "continue" | "stall"): { def: AdapterDef; taskId: string } {
  const dir = mkdtempSync(join(tmpdir(), "wisp-codex-goals-"));
  writeFileSync(join(dir, "fake.js"), FAKE.replace(/^#!.*\n/, ""));
  const bin = join(dir, "fake-codex");
  writeFileSync(bin, `#!/bin/sh\nFAKE_MODE=${mode} exec bun ${join(dir, "fake.js")} "$@"\n`);
  chmodSync(bin, 0o755);
  const def: AdapterDef = {
    bin,
    exec: ["exec", "--dangerously-bypass-approvals-and-sandbox"],
    liveInput: "codex-app-server",
    parse: { format: "json", strategy: "codex-jsonl" },
    attach: null,
  };
  const task = createTask({ id: newTaskId(), title: "codex goals", repo_path: "/tmp/repo", harness: "fake", model: null, slot: freeSlot() });
  setTaskFields(task.id, { worktree_path: mkdtempSync(join(tmpdir(), "wisp-codex-goals-wt-")) });
  started.push(task.id);
  return { def, taskId: task.id };
}

describe("Codex Goals", () => {
  test("the goal's own next turn is recorded as a follow-up turn, and the process goes once the goal is complete", async () => {
    const { def, taskId } = fakeCodex("continue");
    startTurn(getTask(taskId)!, "work on the goal", def, cfg);
    await until(() => turnsFor(taskId)[1]?.status === "done");
    const [first, second] = turnsFor(taskId);
    expect(first).toMatchObject({ status: "done", result: "step 1 done" });
    expect(second).toMatchObject({ status: "done", result: "DONE turn-auto", origin: "background" });
    expect(second!.prompt).toContain("Codex goal continued");
    expect(getTask(taskId)!.state).toBe("done");
    // the goal is complete: the app-server's input closes and it exits
    await until(() => !processGroupAlive(first!.pid!));
    expect(turnsFor(taskId)).toHaveLength(2);
  }, 20_000);

  test("an active goal that does not continue lets the process go after the wait", async () => {
    Object.assign(lingerTiming, { quietMs: 300, followOnMs: 100 });
    const { def, taskId } = fakeCodex("stall");
    startTurn(getTask(taskId)!, "work on the goal", def, cfg);
    await until(() => turnsFor(taskId)[0]?.status === "done");
    const first = turnsFor(taskId)[0]!;
    await until(() => !processGroupAlive(first.pid!));
    expect(turnsFor(taskId)).toHaveLength(1);
  }, 20_000);

  test("a message sent while it waits on the goal starts a new turn on the same thread", async () => {
    Object.assign(lingerTiming, { quietMs: 5_000 });
    const { def, taskId } = fakeCodex("stall");
    startTurn(getTask(taskId)!, "work on the goal", def, cfg);
    await until(() => turnsFor(taskId)[0]?.status === "done");
    const pid = turnsFor(taskId)[0]!.pid!;
    await submitTaskMessage(getTask(taskId)!, "next step please", def, cfg, [], undefined, { fake: def });
    await until(() => turnsFor(taskId)[1]?.status === "done");
    expect(turnsFor(taskId)[1]).toMatchObject({ prompt: "next step please", result: "DONE turn-2" });
    // the same app-server took it: no second process was spawned
    expect(turnsFor(taskId)[1]!.pid).toBe(pid);
  }, 20_000);
});
