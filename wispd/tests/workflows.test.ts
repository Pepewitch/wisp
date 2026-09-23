import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, TASKS_DIR } from "../src/config";
import { createTask, createTurn, db, finishTurn, getTask, markTaskMessageDelivered, messagesFor, newTaskId, nextQueuedMessage, setTaskFields, transition } from "../src/store";
import { BUILTIN_WORKFLOWS, COMMON_PARAMETERS, RETIRED_WORKFLOWS, validateWorkflowParams } from "../src/workflows/definitions";
import { evaluateScheduledSteer } from "../src/workflows/evaluate";
import { WorkflowRuntime } from "../src/workflows/runtime";
import { changeWorkflowState, createWorkflow, getWorkflow, listWorkflows, reserveWorkflowWake, retireWorkflowTypes, workflow } from "../src/workflows/store";
import { workflowRoute } from "../src/routes/workflows";
import { listTasksRoute } from "../src/routes/tasks";
import { validateDecision, workflowById, type InstalledWorkflow } from "../src/workflows/plugins";
import { workflowDuration, workflowFlags, workflowCommand } from "../src/cli-workflow";
import { parseArgs } from "../src/cli-args";
import type { WorkflowDecision, WorkflowParams } from "../../shared/workflows";

const created: string[] = [];
const base = new Date("2026-01-01T00:00:00Z");
afterEach(() => { for (const id of created.splice(0)) db.run("DELETE FROM tasks WHERE id = ?", [id]); });
// Stands in for any watcher that asks a provider: a real plugin subprocess
// that records what it was sent and answers with whatever the test wrote.
const pluginDir = mkdtempSync(join(tmpdir(), "wisp-workflow-watch-"));
const requestFile = join(pluginDir, "request.json"), decisionFile = join(pluginDir, "decision.json");
const watch: InstalledWorkflow = {
  definition: { id: "sample-watch", version: "1", name: "Sample watch", description: "A synthetic watcher.", parameters: COMMON_PARAMETERS, custom: true },
  command: ["/bin/sh", "-c", `cat > '${requestFile}'; cat '${decisionFile}'`],
};
const lookup = (type: string) => type === watch.definition.id ? watch : workflowById(type);
const decide = (decision: WorkflowDecision) => writeFileSync(decisionFile, JSON.stringify(decision));
const wake = (key: string, checkpoint: Record<string, unknown> = {}): WorkflowDecision =>
  ({ action: "wake", reason: "Deployment failed", key, message: `Fix ${key}`, checkpoint });
function arm(type = "heartbeat", params: WorkflowParams = {}) {
  const id = newTaskId();
  createTask({ id, title: "Workflow fixture", repo_path: "/fixture", harness: "fake", model: null, slot: 0 });
  created.push(id);
  // the plugin runs in the task checkout, so its checkout has to exist
  setTaskFields(id, { worktree_path: type === watch.definition.id ? pluginDir : "/fixture" });
  transition(id, "done");
  const def = lookup(type)!.definition;
  const defaults = type === "heartbeat"
    ? { prompt: "Check the objective" }
    : type === "schedule-steer"
      ? { prompt: "Use the staged rollout", scheduledAt: new Date(base.getTime() + 10 * 60_000).toISOString() }
      : {};
  return createWorkflow(id, def, validateWorkflowParams(def, { ...defaults, ...params }), base);
}
function dispatch(taskId: string, messageId: string): boolean {
  const n = getTask(taskId)!.turn_count + 1;
  const turn = createTurn(taskId, n, "workflow test", null, "/fixture/log", null);
  markTaskMessageDelivered(messageId, "started", n);
  finishTurn(turn, "done", 0, "done");
  setTaskFields(taskId, { turn_count: n });
  return true;
}

test("parameters are typed, bounded, and defaulted", () => {
  expect(BUILTIN_WORKFLOWS.map(item => item.id)).toEqual(["schedule-steer", "heartbeat"]);
  const heartbeat = BUILTIN_WORKFLOWS.find(item => item.id === "heartbeat")!;
  expect(() => validateWorkflowParams(heartbeat, { prompt: "Continue", everyMinutes: 0 })).toThrow();
  expect(() => validateWorkflowParams(heartbeat, { prompt: "Continue", extra: true })).toThrow();
  expect(() => validateWorkflowParams(BUILTIN_WORKFLOWS[0]!, { prompt: null })).toThrow();
  expect(validateWorkflowParams(heartbeat, { prompt: "Continue", allowPush: false, allowMerge: false })).toMatchObject({
    allowPush: false,
    allowMerge: false,
  });
  const item = arm(watch.definition.id);
  expect(item.params.everyMinutes).toBe(5);
  expect(item.params.allowMerge).toBe(false);
  const schedule = BUILTIN_WORKFLOWS.find(item => item.id === "schedule-steer")!;
  expect(validateWorkflowParams(schedule, { prompt: "Ship", scheduledAt: "2026-09-13T14:00:00+07:00" }).scheduledAt)
    .toBe("2026-09-13T07:00:00.000Z");
  expect(() => validateWorkflowParams(schedule, { prompt: "Ship", scheduledAt: "2026-09-13T14:00:00" })).toThrow("UTC offset");
  expect(() => arm("schedule-steer", { scheduledAt: base.toISOString() })).toThrow("future");
});

test("scheduled steer waits for its instant, sends once, and completes", async () => {
  const item = arm("schedule-steer");
  expect(item.nextCheckAt).toBe(new Date(base.getTime() + 10 * 60_000).toISOString());
  expect(item.reason).toContain("Scheduled for");
  expect(evaluateScheduledSteer(item, {}, new Date(base.getTime() + 9 * 60_000)).action).toBe("wait");
  const clock = new Date(base.getTime() + 10 * 60_000);
  const runtime = new WorkflowRuntime(loadConfig(), {}, { now: () => clock, dispatch });
  await runtime.tick();
  expect(messagesFor(item.taskId)).toHaveLength(1);
  expect(messagesFor(item.taskId)[0]?.text).toBe("Use the staged rollout");
  expect(getWorkflow(item.id)?.state).toBe("completed");
  expect(getWorkflow(item.id)?.reason).toBe("Scheduled steer sent");
  await new WorkflowRuntime(loadConfig(), {}, { now: () => clock, dispatch }).tick();
  expect(messagesFor(item.taskId)).toHaveLength(1);
});

test("scheduled steer queues behind a non-live running turn and still completes", async () => {
  const item = arm("schedule-steer");
  transition(item.taskId, "running");
  createTurn(item.taskId, 1, "Current work", null, "/fixture/log", null);
  const clock = new Date(base.getTime() + 10 * 60_000);
  await new WorkflowRuntime(loadConfig(), {}, { now: () => clock }).tick();
  const message = messagesFor(item.taskId)[0]!;
  expect(message).toMatchObject({ status: "queued", workflow_id: null });
  expect(nextQueuedMessage(item.taskId)?.id).toBe(message.id);
  expect(getWorkflow(item.id)?.state).toBe("completed");
  expect(getWorkflow(item.id)?.reason).toBe("Scheduled steer queued for next turn");
});

test("heartbeat is durable, writes its completion footer outside the worktree, and skips missed ticks", async () => {
  const item = arm();
  expect(item.params).toMatchObject({ allowPush: true, allowMerge: true });
  const clock = new Date(base.getTime() + 60 * 60_000);
  const runtime = new WorkflowRuntime(loadConfig(), {}, { now: () => clock, dispatch });
  await runtime.tick();
  expect(messagesFor(item.taskId)).toHaveLength(1);
  expect(nextQueuedMessage(item.taskId)).toBeNull();
  const file = join(TASKS_DIR, item.taskId, "workflows", item.id, "wake-1", "HEARTBEAT.md");
  expect(existsSync(file)).toBe(true);
  expect(readFileSync(file, "utf8")).toContain(`workflow complete ${item.id}`);
  expect(readFileSync(file, "utf8")).toContain("Push permission: authorized for task changes.");
  expect(readFileSync(file, "utf8")).toContain("Merge permission: authorized after rechecking current provider protections.");
  await new WorkflowRuntime(loadConfig(), {}, { now: () => clock, dispatch }).tick();
  expect(messagesFor(item.taskId)).toHaveLength(1);
});

test("heartbeat preserves explicit permission denials from existing instances", async () => {
  const item = arm();
  db.run("UPDATE workflows SET params_json = ? WHERE id = ?", [
    JSON.stringify({ ...item.params, allowPush: false, allowMerge: false }),
    item.id,
  ]);
  await new WorkflowRuntime(loadConfig(), {}, {
    now: () => new Date(base.getTime() + 6 * 60_000),
    dispatch,
  }).tick();
  const file = join(TASKS_DIR, item.taskId, "workflows", item.id, "wake-1", "HEARTBEAT.md");
  expect(readFileSync(file, "utf8")).toContain("Push permission: not authorized by this workflow.");
  expect(readFileSync(file, "utf8")).toContain("Merge permission: not authorized by this workflow.");
});

test("busy heartbeat creates no queued reminders", async () => {
  const item = arm();
  transition(item.taskId, "running");
  const runtime = new WorkflowRuntime(loadConfig(), {}, { now: () => new Date(base.getTime() + 6 * 60_000), dispatch });
  await runtime.tick();
  expect(messagesFor(item.taskId)).toHaveLength(0);
  expect(getWorkflow(item.id)?.reason).toContain("Waiting for task");
});

test("heartbeat recovers settled failed and needs-input tasks", async () => {
  for (const state of ["failed", "needs-input"] as const) {
    const item = arm();
    transition(item.taskId, state);
    const runtime = new WorkflowRuntime(loadConfig(), {}, {
      now: () => new Date(base.getTime() + 6 * 60_000),
      dispatch,
    });
    await runtime.tick();
    expect(messagesFor(item.taskId)).toHaveLength(1);
    expect(getWorkflow(item.id)?.wake_count).toBe(1);
    expect(getWorkflow(item.id)?.reason).toBe("Heartbeat due");
  }
});

test("custom workflows still wait for failed tasks", async () => {
  const item = arm(watch.definition.id);
  decide(wake("attempt-1"));
  transition(item.taskId, "failed");
  const runtime = new WorkflowRuntime(loadConfig(), {}, {
    now: () => new Date(base.getTime() + 6 * 60_000),
    lookup,
    dispatch,
  });
  await runtime.tick();
  expect(messagesFor(item.taskId)).toHaveLength(0);
  expect(getWorkflow(item.id)?.reason).toBe("Waiting for task (failed); no instruction queued");
});

test("default dispatch recovers a failed task and records one synthetic harness turn", async () => {
  const { validateAdapters } = await import("../src/adapters");
  const item = arm();
  const dir = mkdtempSync(join(tmpdir(), "wisp-workflow-runner-"));
  setTaskFields(item.taskId, { worktree_path: dir });
  transition(item.taskId, "failed", "Prior turn failed");
  const adapters = validateAdapters({ fake: { bin: "bash", exec: ["-c", "printf 'Workflow finished\\n'"], parse: { format: "text" } } });
  const runtime = new WorkflowRuntime(loadConfig(), adapters, { now: () => new Date(base.getTime() + 6 * 60_000) });
  await runtime.tick();
  for (let attempt = 0; attempt < 100 && getTask(item.taskId)?.state === "running"; attempt++) await Bun.sleep(20);
  expect(getTask(item.taskId)?.state).toBe("done");
  const messages = messagesFor(item.taskId);
  expect(messages).toHaveLength(1);
  expect(messages[0]?.delivery).toBe("started");
  expect(messages[0]?.workflow_id).toBe(item.id);
});

test("waiting costs no turn; delivered evidence does not repeat across restart", async () => {
  const item = arm(watch.definition.id);
  decide({ action: "wait", reason: "Deployment still building", checkpoint: {} });
  let now = base;
  const run = () => new WorkflowRuntime(loadConfig(), {}, { now: () => now, lookup, dispatch }).tick();
  await run();
  expect(messagesFor(item.taskId)).toHaveLength(0);
  expect(getWorkflow(item.id)?.reason).toBe("Deployment still building");
  decide(wake("attempt-1"));
  now = new Date(base.getTime() + 6 * 60_000);
  await run();
  expect(messagesFor(item.taskId)).toHaveLength(1);
  now = new Date(base.getTime() + 12 * 60_000);
  await run();
  expect(messagesFor(item.taskId)).toHaveLength(1);
  decide(wake("attempt-2"));
  now = new Date(base.getTime() + 18 * 60_000);
  await run();
  expect(messagesFor(item.taskId)).toHaveLength(2);
  expect(messagesFor(item.taskId)[0]?.text).toContain("Leave this workflow active");
});

test("pause racing a provider read cannot deliver; archive and context changes disable automation", async () => {
  const item = arm(watch.definition.id);
  decide(wake("attempt-1"));
  const checking = new WorkflowRuntime(loadConfig(), {}, { now: () => base, lookup, dispatch }).tick();
  // the plugin is still running when the user pauses; its answer lands after
  changeWorkflowState(item.id, "paused", "User paused", base);
  await checking;
  expect(messagesFor(item.taskId)).toHaveLength(0);
  changeWorkflowState(item.id, "active", "Resume", base);
  db.run("UPDATE tasks SET context_n = context_n + 1 WHERE id = ?", [item.taskId]);
  expect(getWorkflow(item.id)?.state).toBe("paused");
  setTaskFields(item.taskId, { archived: 1 });
  expect(getWorkflow(item.id)?.state).toBe("completed");
  expect(changeWorkflowState(item.id, "completed", "Again", base).state).toBe("completed");
});

test("workflow messages never drain on ordinary queue recovery", () => {
  const item = arm();
  const row = getWorkflow(item.id)!;
  const message = reserveWorkflowWake(row, { action: "wake", reason: "Due", key: "once", message: "Check", checkpoint: {} }, "Check", base);
  expect(message).toBeTruthy();
  expect(nextQueuedMessage(item.taskId)).toBeNull();
  expect(nextQueuedMessage(item.taskId, message!)?.id).toBe(message);
  changeWorkflowState(item.id, "paused", "Pause", base);
  expect(messagesFor(item.taskId)[0]?.status).toBe("cancelled");
});

test("restart restores an unacknowledged wake before checking fresh evidence", async () => {
  const item = arm(watch.definition.id), row = getWorkflow(item.id)!;
  const decision = wake("attempt-1", { attempt: 1 });
  reserveWorkflowWake(row, decision, decision.message!, base);
  expect(JSON.parse(getWorkflow(item.id)!.checkpoint_json)).toEqual({ attempt: 1 });
  decide(decision);
  const runtime = new WorkflowRuntime(loadConfig(), {}, {
    now: () => new Date(base.getTime() + 6 * 60_000), lookup, dispatch,
  });
  await runtime.tick();
  // the plugin saw the checkpoint from BEFORE the wake that never reached a turn
  expect(JSON.parse(readFileSync(requestFile, "utf8")).checkpoint).toEqual({});
  const messages = messagesFor(item.taskId);
  expect(messages.map(m => m.status)).toEqual(["cancelled", "delivered"]);
  expect(getWorkflow(item.id)?.wake_count).toBe(1);
});

test("generated instructions cannot be edited and cancellation pauses their workflow", async () => {
  const { taskMessageRoute } = await import("../src/routes/task-messages");
  const item = arm(), row = getWorkflow(item.id)!;
  const id = reserveWorkflowWake(row, { action: "wake", reason: "Due", key: "once", message: "Check", checkpoint: {} }, "Check", base)!;
  const path = `/api/tasks/${item.taskId}/messages/${id}`;
  const edit = await taskMessageRoute(new Request(`http://localhost${path}`, { method: "PATCH", body: JSON.stringify({ message: "Replace" }) }), path, "PATCH");
  expect(edit?.status).toBe(409);
  const cancel = await taskMessageRoute(new Request(`http://localhost${path}`, { method: "DELETE" }), path, "DELETE");
  expect(cancel?.status).toBe(200);
  expect(getWorkflow(item.id)?.state).toBe("paused");
  expect(getWorkflow(item.id)?.wake_count).toBe(0);
});

test("manual stop pauses automation even when no turn remains to stop", async () => {
  const { interruptTurn } = await import("../src/runner");
  const item = arm();
  await expect(interruptTurn(item.taskId)).rejects.toThrow("no running turn");
  expect(getWorkflow(item.id)?.state).toBe("paused");
});

test("expiry and provider errors never invent work", async () => {
  const item = arm(watch.definition.id);
  rmSync(decisionFile, { force: true });
  await new WorkflowRuntime(loadConfig(), {}, { now: () => base, lookup, dispatch }).tick();
  expect(getWorkflow(item.id)?.reason).toBe("Plugin check failed, timed out, or exceeded its output budget");
  expect(getWorkflow(item.id)?.failures).toBe(1);
  expect(messagesFor(item.taskId)).toHaveLength(0);
  decide(wake("attempt-1"));
  await new WorkflowRuntime(loadConfig(), {}, { now: () => new Date(base.getTime() + 25 * 3_600_000), lookup, dispatch }).tick();
  expect(getWorkflow(item.id)?.state).toBe("paused");
  expect(messagesFor(item.taskId)).toHaveLength(0);
});

test("withdrawn built-ins are completed, not left paused forever", () => {
  const retired = arm(), kept = arm();
  db.run("UPDATE workflows SET type = 'pr-review', state = 'paused' WHERE id = ?", [retired.id]);
  retireWorkflowTypes(RETIRED_WORKFLOWS, base);
  expect(getWorkflow(retired.id)).toMatchObject({ state: "completed", reason: "PR review watch was removed from Wisp" });
  expect(getWorkflow(kept.id)?.state).toBe("active");
});

test("workflow API creates, edits with revision checks, and completes idempotently", async () => {
  const item = arm();
  const request = (path: string, method: string, body?: unknown) => workflowRoute(new Request(`http://localhost${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), path);
  expect((await request(`/api/tasks/${item.taskId}/workflows`, "POST", null)).status).toBe(400);
  const createdResponse = await request(`/api/tasks/${item.taskId}/workflows`, "POST", { type: "heartbeat", params: { prompt: "Another objective" } });
  expect(createdResponse.status).toBe(201);
  const row = await createdResponse.json() as { id: string; revision: number };
  expect((await request(`/api/workflows/${row.id}`, "PATCH", { revision: row.revision, params: { everyMinutes: 10 } })).status).toBe(200);
  expect((await request(`/api/workflows/${row.id}`, "PATCH", { revision: row.revision, params: { everyMinutes: 2 } })).status).toBe(400);
  expect((await request(`/api/workflows/${row.id}/complete`, "POST", {})).status).toBe(200);
  expect((await request(`/api/workflows/${row.id}/complete`, "POST", {})).status).toBe(200);
  expect(listWorkflows(item.taskId)).toHaveLength(2);
});

test("task list marks only unfinished workflows as attached", async () => {
  const item = arm();
  const listed = async () => await listTasksRoute(new URL("http://wisp.test/api/tasks")).json() as Array<{
    id: string;
    has_workflow: boolean;
  }>;
  expect((await listed()).find(task => task.id === item.taskId)?.has_workflow).toBe(true);
  changeWorkflowState(item.id, "completed", "Done", base);
  expect((await listed()).find(task => task.id === item.taskId)?.has_workflow).toBe(false);
});

test("CLI flags preserve custom parameters and target the API", async () => {
  const parsed = parseArgs(["start", "tabcde", "heartbeat", "--every", "5m", "--prompt", "Check", "--max-wakeups", "12"]);
  expect(parsed.positional).toEqual(["start", "tabcde", "heartbeat"]);
  expect(workflowFlags(parsed.flags)).toEqual({ prompt: "Check", everyMinutes: 5, maxWakeups: 12 });
  expect(workflowDuration("2h")).toBe(120);
  expect(() => workflowDuration("zero")).toThrow();
  expect(() => workflowFlags({ "quite-for": "30m" })).toThrow("Unknown workflow flag");
  expect(() => workflowFlags({ pr: "https://github.com/example/project/pull/42" })).toThrow("Unknown workflow flag");
  expect(() => workflowFlags({ params: true })).toThrow("--params needs");
  expect(workflowFlags(parseArgs(["start", "tabcde", "schedule-steer", "--at", "2026-09-14T16:00:00Z"]).flags))
    .toEqual({ scheduledAt: "2026-09-14T16:00:00Z" });
  const calls: unknown[] = [];
  const item = arm();
  await workflowCommand(parsed.positional, { ...parsed.flags, json: true }, async (...args) => { calls.push(args); return item; });
  expect(calls).toEqual([["/api/tasks/tabcde/workflows", "POST", { type: "heartbeat", params: { prompt: "Check", everyMinutes: 5, maxWakeups: 12 } }]]);
  // `start` renamed `add`; the old verb stays working, undocumented, so scripts
  // written against the first release do not break
  const alias: unknown[] = [];
  await workflowCommand(["add", "tabcde", "heartbeat"], { json: true }, async (...args) => { alias.push(args); return item; });
  expect(alias).toEqual([["/api/tasks/tabcde/workflows", "POST", { type: "heartbeat", params: {} }]]);
  expect(() => validateDecision({ action: "wake", reason: "Due", checkpoint: {} })).toThrow();
  expect(workflow(getWorkflow(item.id)!).type).toBe("heartbeat");
});
