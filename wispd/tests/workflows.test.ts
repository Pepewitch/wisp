import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, TASKS_DIR } from "../src/config";
import { createTask, createTurn, db, finishTurn, getTask, markTaskMessageDelivered, messagesFor, newTaskId, nextQueuedMessage, setTaskFields, transition } from "../src/store";
import { BUILTIN_WORKFLOWS, parsePrUrl, validateWorkflowParams } from "../src/workflows/definitions";
import { evaluateCi, evaluateReview } from "../src/workflows/evaluate";
import type { WorkflowPr } from "../src/workflows/github";
import { WorkflowRuntime } from "../src/workflows/runtime";
import { changeWorkflowState, createWorkflow, getWorkflow, listWorkflows, reserveWorkflowWake, updateWorkflow, workflow } from "../src/workflows/store";
import { workflowRoute } from "../src/routes/workflows";
import { validateDecision } from "../src/workflows/plugins";
import { workflowDuration, workflowFlags, workflowCommand } from "../src/cli-workflow";
import { parseArgs } from "../src/cli-args";
import type { WorkflowParams } from "../../shared/workflows";

const created: string[] = [];
const base = new Date("2026-01-01T00:00:00Z");
afterEach(() => { for (const id of created.splice(0)) db.run("DELETE FROM tasks WHERE id = ?", [id]); });
function arm(type = "heartbeat", params: WorkflowParams = {}) {
  const id = newTaskId();
  createTask({ id, title: "Workflow fixture", repo_path: "/fixture", harness: "fake", model: null, slot: 0 });
  created.push(id);
  setTaskFields(id, { worktree_path: "/fixture" });
  transition(id, "done");
  const def = BUILTIN_WORKFLOWS.find(d => d.id === type)!;
  return createWorkflow(id, def, validateWorkflowParams(def, type === "heartbeat" ? { prompt: "Check the objective", ...params } : { prUrl: "https://github.com/example/project/pull/42", ...params }), base);
}
function pr(): WorkflowPr {
  return { url: "https://github.com/example/project/pull/42", head: "a".repeat(40), closed: false, merged: false, viewer: "agent", checks: [], feedback: [] };
}
function feedback(id = "one", author = "reviewer") {
  return { id, author, bot: false, body: "Please fix this nit", url: "https://github.com/example/project/pull/42#discussion", updatedAt: base.toISOString(), fingerprint: `${id}:1` };
}
function dispatch(taskId: string, messageId: string): boolean {
  const n = getTask(taskId)!.turn_count + 1;
  const turn = createTurn(taskId, n, "workflow test", null, "/fixture/log", null);
  markTaskMessageDelivered(messageId, "started", n);
  finishTurn(turn, "done", 0, "done");
  setTaskFields(taskId, { turn_count: n });
  return true;
}

test("parameters are typed, bounded, defaulted, and PR identity is pinned", () => {
  const def = BUILTIN_WORKFLOWS[1]!;
  expect(() => validateWorkflowParams(def, { prUrl: "https://github.com/example/project/pull/42/files" })).toThrow();
  expect(() => validateWorkflowParams(def, { prUrl: "https://github.com/example/project/pull/42", everyMinutes: 0 })).toThrow();
  expect(() => validateWorkflowParams(def, { prUrl: "https://github.com/example/project/pull/42", extra: true })).toThrow();
  expect(() => parsePrUrl("https://github.com.attacker.test/example/project/pull/42")).toThrow();
  expect(() => parsePrUrl("https://user:secret@github.com/example/project/pull/42")).toThrow();
  expect(() => validateWorkflowParams(BUILTIN_WORKFLOWS[0]!, { prompt: null })).toThrow();
  const item = arm("pr-ci");
  expect(item.params.everyMinutes).toBe(5);
  expect(item.params.allowMerge).toBe(false);
  expect(() => updateWorkflow(item.id, { ...item.params, prUrl: "https://github.com/example/project/pull/43" }, item.revision)).toThrow("different PR");
});

test("heartbeat is durable, writes its completion footer outside the worktree, and skips missed ticks", async () => {
  const item = arm();
  const clock = new Date(base.getTime() + 60 * 60_000);
  const runtime = new WorkflowRuntime(loadConfig(), {}, { now: () => clock, dispatch });
  await runtime.tick();
  expect(messagesFor(item.taskId)).toHaveLength(1);
  expect(nextQueuedMessage(item.taskId)).toBeNull();
  const file = join(TASKS_DIR, item.taskId, "workflows", item.id, "wake-1", "HEARTBEAT.md");
  expect(existsSync(file)).toBe(true);
  expect(readFileSync(file, "utf8")).toContain(`workflow complete ${item.id}`);
  await new WorkflowRuntime(loadConfig(), {}, { now: () => clock, dispatch }).tick();
  expect(messagesFor(item.taskId)).toHaveLength(1);
});

test("busy heartbeat creates no queued reminders", async () => {
  const item = arm();
  transition(item.taskId, "running");
  const runtime = new WorkflowRuntime(loadConfig(), {}, { now: () => new Date(base.getTime() + 6 * 60_000), dispatch });
  await runtime.tick();
  expect(messagesFor(item.taskId)).toHaveLength(0);
  expect(getWorkflow(item.id)?.reason).toContain("Waiting for task");
});

test("default dispatch starts and records one synthetic harness turn through the runner", async () => {
  const { validateAdapters } = await import("../src/adapters");
  const item = arm();
  const dir = mkdtempSync(join(tmpdir(), "wisp-workflow-runner-"));
  setTaskFields(item.taskId, { worktree_path: dir });
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

test("CI pending costs no turn; unchanged failures do not repeat across restart", async () => {
  const item = arm("pr-ci");
  const snapshot = pr();
  snapshot.checks = [{ id: "run1", name: "Tests", state: "pending", url: "" }];
  let now = base;
  const run = () => new WorkflowRuntime(loadConfig(), {}, { now: () => now, readPr: async () => snapshot, dispatch }).tick();
  await run();
  expect(messagesFor(item.taskId)).toHaveLength(0);
  snapshot.checks[0]!.state = "failed";
  now = new Date(base.getTime() + 6 * 60_000);
  await run();
  expect(messagesFor(item.taskId)).toHaveLength(1);
  now = new Date(base.getTime() + 12 * 60_000);
  await run();
  expect(messagesFor(item.taskId)).toHaveLength(1);
  snapshot.checks[0]!.id = "run2";
  now = new Date(base.getTime() + 18 * 60_000);
  await run();
  expect(messagesFor(item.taskId)).toHaveLength(2);
  expect(messagesFor(item.taskId)[0]?.text).toContain("Leave this workflow active");
});

test("review comments, edits, selected bots, and quiet completion do not depend on approval status", () => {
  const item = arm("pr-review");
  const snapshot = pr();
  snapshot.feedback = [feedback(), feedback("self", "agent"), { ...feedback("bot", "review-bot"), bot: true }];
  const first = evaluateReview(item, snapshot, {}, base, true, null);
  expect(first.action).toBe("wake");
  expect(first.message).toContain("Please fix this nit");
  expect(first.message).not.toContain('"author":"agent"');
  expect(first.message).not.toContain('"author":"review-bot"');
  const quiet = evaluateReview(item, snapshot, first.checkpoint, new Date(base.getTime() + 31 * 60_000), true, null);
  expect(quiet.action).toBe("complete");
  expect(quiet.reason).toContain("does not mean approval");
  expect(evaluateReview(item, snapshot, first.checkpoint, new Date(base.getTime() + 31 * 60_000), false, null).action).toBe("wait");
  snapshot.feedback[0]!.fingerprint = "one:edited";
  expect(evaluateReview(item, snapshot, first.checkpoint, new Date(base.getTime() + 31 * 60_000), true, null).action).toBe("wake");
  const selected = evaluateReview({ ...item, params: { ...item.params, reviewers: "review-bot" } }, snapshot, {}, base, true, null);
  expect(selected.message).toContain('"author":"review-bot"');
});

test("review fixes and head updates restart the quiet window; pending feedback remains unhandled", () => {
  const item = arm("pr-review"), snapshot = pr();
  snapshot.feedback = [feedback()];
  const pending = evaluateReview(item, snapshot, {}, base, false, null);
  expect(pending.action).toBe("wait");
  const acted = evaluateReview(item, snapshot, pending.checkpoint, base, true, null);
  expect(acted.action).toBe("wake");
  const now = new Date(base.getTime() + 40 * 60_000);
  expect(evaluateReview(item, snapshot, acted.checkpoint, now, true, new Date(base.getTime() + 20 * 60_000).toISOString()).action).toBe("wait");
  snapshot.head = "b".repeat(40);
  expect(evaluateReview(item, snapshot, acted.checkpoint, now, true, null).action).toBe("wait");
});

test("pause racing a provider read cannot deliver; archive and context changes disable automation", async () => {
  const item = arm("pr-ci"), snapshot = pr();
  snapshot.checks = [{ id: "run", name: "Tests", state: "failed", url: "" }];
  const runtime = new WorkflowRuntime(loadConfig(), {}, {
    now: () => base, dispatch,
    readPr: async () => { changeWorkflowState(item.id, "paused", "User paused", base); return snapshot; },
  });
  await runtime.tick();
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

test("restart restores unacknowledged review feedback before checking fresh evidence", async () => {
  const item = arm("pr-review"), snapshot = pr();
  snapshot.feedback = [feedback()];
  const row = getWorkflow(item.id)!;
  const decision = evaluateReview(item, snapshot, {}, base, true, null);
  reserveWorkflowWake(row, decision, decision.message!, base);
  expect(JSON.parse(getWorkflow(item.id)!.checkpoint_json).handled.one).toBe("one:1");
  const runtime = new WorkflowRuntime(loadConfig(), {}, {
    now: () => new Date(base.getTime() + 3 * 60_000), readPr: async () => snapshot, dispatch,
  });
  await runtime.tick();
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

test("quiet completion is rechecked after a user starts work during the provider request", async () => {
  const item = arm("pr-review");
  const snapshot = pr();
  db.run("UPDATE workflows SET checkpoint_json = ? WHERE id = ?", [JSON.stringify({ head: snapshot.head, quietSince: base.toISOString(), handled: {}, observed: {} }), item.id]);
  const runtime = new WorkflowRuntime(loadConfig(), {}, {
    now: () => new Date(base.getTime() + 31 * 60_000),
    readPr: async () => { transition(item.taskId, "running"); return snapshot; }, dispatch,
  });
  await runtime.tick();
  expect(getWorkflow(item.id)?.state).toBe("active");
  expect(getWorkflow(item.id)?.reason).toContain("busy");
});

test("budget, expiry, unknown CI, and provider errors never invent work", async () => {
  const item = arm("pr-ci"), snapshot = pr();
  expect(evaluateCi(item, snapshot, {}).action).toBe("wait");
  snapshot.checks = [{ id: "unknown", name: "Unknown", state: "unknown", url: "" }];
  expect(evaluateCi(item, snapshot, {}).action).toBe("wait");
  await new WorkflowRuntime(loadConfig(), {}, { now: () => base, readPr: async () => { throw new Error("Offline"); }, dispatch }).tick();
  expect(getWorkflow(item.id)?.reason).toBe("Offline");
  expect(messagesFor(item.taskId)).toHaveLength(0);
  await new WorkflowRuntime(loadConfig(), {}, { now: () => new Date(base.getTime() + 25 * 3_600_000), dispatch }).tick();
  expect(getWorkflow(item.id)?.state).toBe("paused");
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

test("CLI flags preserve custom parameters and target the API", async () => {
  const parsed = parseArgs(["start", "tabcde", "heartbeat", "--every", "5m", "--prompt", "Check", "--max-wakeups", "12"]);
  expect(parsed.positional).toEqual(["start", "tabcde", "heartbeat"]);
  expect(workflowFlags(parsed.flags)).toEqual({ prompt: "Check", everyMinutes: 5, maxWakeups: 12 });
  expect(workflowDuration("2h")).toBe(120);
  expect(() => workflowDuration("zero")).toThrow();
  expect(() => workflowFlags({ "quite-for": "30m" })).toThrow("Unknown workflow flag");
  expect(() => workflowFlags({ params: true })).toThrow("--params needs");
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
