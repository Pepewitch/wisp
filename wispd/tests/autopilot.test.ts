import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import type { PrSnapshot } from "../src/autopilot/github";
import { isTaskMerging } from "../src/autopilot/merging";
import { publishedWork } from "../src/autopilot/published";
import { AFTER_MERGE_MS, choosePull, SEND_DELAY_MS, WAITING_ON_YOU_MS } from "../src/autopilot/runtime";
import {
  autopilotArchiveWarning, autopilotRow, autopilotStatus, autopilotTurnNotes, checkpointOf, reserveRound, resumeAutopilot, sendPendingFix, setAutopilot,
  skipPendingFix, withdrawQueuedRound, writeAutopilotCheckpoint,
} from "../src/autopilot/store";
import { taskMessageRoute } from "../src/routes/task-messages";
import { formatAutopilot, prCommand } from "../src/cli-pr";
import { autopilotRoute } from "../src/routes/autopilot";
import { createTaskRoute, listTasksRoute } from "../src/routes/tasks";
import { interruptTurn, startNextQueuedMessage } from "../src/runner";
import { workflowRoute } from "../src/routes/workflows";
import { db, getTask, setTaskFields, transition } from "../src/store";
import { taskPreamble } from "../src/turn-input";
import type { Task } from "../src/types";
import { pauseTaskWorkflows } from "../src/workflows/store";
import { HEAD, START, forgetTasks, doneTask, snapshot, pull, fakeGitHub, runtime, seed, pass, until, capture, queue } from "./autopilot-harness";

afterEach(forgetTasks);

describe("arming", () => {
  test("toggling on arms one row, toggling again changes nothing, toggling off stands down", () => {
    const task = doneTask();
    expect(autopilotStatus(task.id)).toMatchObject({ autoMerge: false, state: "off" });
    expect(setAutopilot(task.id, { autoMerge: true })).toMatchObject({ autoMerge: true, state: "waiting", reason: "Waiting for a PR" });
    const row = autopilotRow(task.id)!;
    setAutopilot(task.id, { autoMerge: true });
    expect(autopilotRow(task.id)!.id).toBe(row.id);
    expect(autopilotRow(task.id)!.revision).toBe(row.revision);
    expect(setAutopilot(task.id, { autoMerge: false })).toMatchObject({ autoMerge: false, state: "off" });
    expect(autopilotRow(task.id)).toBeNull();
  });

  test("auto-fix arms on its own, the row stands down only when both are off, and a local task gets neither", () => {
    const task = doneTask();
    expect(setAutopilot(task.id, { autoFix: true })).toMatchObject({ autoMerge: false, autoFix: true, state: "waiting" });
    expect(setAutopilot(task.id, { autoMerge: true })).toMatchObject({ autoMerge: true, autoFix: true });
    expect(setAutopilot(task.id, { autoFix: false })).toMatchObject({ autoMerge: true, autoFix: false });
    expect(setAutopilot(task.id, { autoMerge: false })).toMatchObject({ state: "off" });
    const local = doneTask({ mode: "local" });
    expect(() => setAutopilot(local.id, { autoMerge: true })).toThrow("own branch");
    expect(() => setAutopilot(local.id, { autoFix: true })).toThrow("own branch");
  });

  test("autopilot is not a workflow to the rest of the daemon", async () => {
    const task = doneTask();
    setAutopilot(task.id, { autoMerge: true });
    const list = await workflowRoute(new Request("http://wisp.test/x"), `/api/tasks/${task.id}/workflows`);
    expect(await list.json()).toEqual([]);
    const row = autopilotRow(task.id)!;
    const path = `/api/workflows/${row.id}/pause`;
    expect((await workflowRoute(new Request(`http://wisp.test${path}`, { method: "POST", body: "{}" }), path)).status).toBe(409);
    const listed = (await listTasksRoute(new URL("http://wisp.test/api/tasks")).json()) as Array<{ id: string; has_workflow: boolean; autopilot: unknown }>;
    const entry = listed.find((t) => t.id === task.id)!;
    // the workflow ring would hide a needs-input or failed fill for a PR's lifetime
    expect(entry.has_workflow).toBe(false);
    expect(entry.autopilot).toMatchObject({ autoMerge: true, state: "waiting" });
  });
});

describe("the loop", () => {
  test("binds to the task's PR, waits out a fresh head, then squash-merges exactly that head", async () => {
    const task = doneTask();
    const clock = { now: START };
    const { state, github } = fakeGitHub();
    const rt = runtime(github, clock);
    setAutopilot(task.id, { autoMerge: true });
    await pass(rt, task.id, clock);
    // a gate reason is about the PR, so a client may show it in place of CI and review
    expect(autopilotStatus(task.id)).toMatchObject({ pr: 7, state: "waiting", reason: "Waiting for checks to start", about: "pr" });
    expect(state.merges).toHaveLength(0);
    clock.now += 3 * 60_000;
    await pass(rt, task.id, clock);
    expect(state.merges).toEqual([{ number: 7, method: "SQUASH", head: HEAD }]);
    // the switch stays on for the task's next PR, and remembers the merge
    expect(autopilotStatus(task.id)).toMatchObject({
      state: "waiting", reason: "#7 merged by Wisp · Waiting for the task's next PR", pr: null, autoMerge: true,
      lastMerged: { pr: 7, byWisp: true },
    });
    // the agent hears once that its branch is finished, and never again; the standing note stays
    const merged = autopilotTurnNotes(task.id);
    expect(merged.notes[0]).toBe("PR #7 was merged by Wisp. Its branch is finished: start any further change on a new branch from origin/main.");
    expect(merged.notes[1]).toContain("Auto-merge is on for this task");
    // not spent until a turn really starts with it
    expect(autopilotTurnNotes(task.id).notes).toHaveLength(2);
    merged.delivered();
    expect(autopilotTurnNotes(task.id).notes).toHaveLength(1);
    expect(autopilotTurnNotes(task.id).notes[0]).toContain("Auto-merge is on for this task");
  });

  test("after a merge it stays on for the task's next PR, and never adopts the merged one or an older one", async () => {
    const task = doneTask();
    const clock = { now: START };
    const opened = (number: number, ms: number) => pull({ number, createdAt: new Date(Date.parse(task.created_at) + ms).toISOString() });
    const { state, github } = fakeGitHub({ pulls: [opened(7, 60_000)] });
    const rt = runtime(github, clock);
    setAutopilot(task.id, { autoMerge: true, autoFix: true });
    await pass(rt, task.id, clock);
    // what belongs to #7 must not follow the task to its next PR
    const row = autopilotRow(task.id)!;
    writeAutopilotCheckpoint(row, { ...checkpointOf(row), rounds: 2, delivered: { "thread:PRRT_7": "t" } }, new Date(clock.now));
    clock.now += 3 * 60_000;
    await pass(rt, task.id, clock);
    expect(state.merges.map((merge) => merge.number)).toEqual([7]);
    // done for now (the sidebar's violet rail), and still on for the next PR
    expect(autopilotStatus(task.id)).toMatchObject({ pr: null, autoMerge: true, autoFix: true, fixRounds: 0, lastMerged: { pr: 7, byWisp: true }, done: true });
    expect(checkpointOf(autopilotRow(task.id)!)).not.toHaveProperty("delivered");
    // GitHub's open list lags the merge: #7 is still in it, and must not be adopted again
    await pass(rt, task.id, clock);
    expect(autopilotStatus(task.id)).toMatchObject({ pr: null, reason: "#7 merged by Wisp · Waiting for the task's next PR", lastMerged: { pr: 7, byWisp: true } });
    // with no next PR: two more quick looks (GitHub's list can lag a new PR), then it waits for a turn
    expect(Date.parse(autopilotRow(task.id)!.next_check_at) - clock.now).toBe(WAITING_ON_YOU_MS);
    await pass(rt, task.id, clock);
    await pass(rt, task.id, clock);
    expect(Date.parse(autopilotRow(task.id)!.next_check_at) - clock.now).toBe(AFTER_MERGE_MS);
    // an open PR numbered below the merged one is stale or abandoned: never adopted
    state.pulls = [opened(7, 60_000), opened(6, 30_000)];
    await pass(rt, task.id, clock);
    expect(autopilotStatus(task.id).reason).toBe("#7 merged by Wisp · Waiting for this task's own PR (#6 is older than #7, which merged)");
    // the task's next change is
    state.pulls = [opened(6, 30_000), opened(9, 120_000)];
    state.pr = snapshot({ number: 9, head: "d".repeat(40) });
    await pass(rt, task.id, clock);
    expect(autopilotStatus(task.id)).toMatchObject({ pr: 9, lastMerged: { pr: 7 }, done: false });
    clock.now += 3 * 60_000;
    await pass(rt, task.id, clock);
    expect(state.merges.map((merge) => merge.number)).toEqual([7, 9]);
    expect(autopilotStatus(task.id)).toMatchObject({ lastMerged: { pr: 9, byWisp: true }, autoMerge: true });
  });

  test("a PR stacked on the merged one is its next, opened before the merge or not, and the agent is told to go on there", async () => {
    const task = doneTask();
    const clock = { now: START };
    const opened = (number: number, ms: number, base = "main") => pull({ number, baseRefName: base, createdAt: new Date(Date.parse(task.created_at) + ms).toISOString() });
    const { state, github } = fakeGitHub({ pulls: [opened(7, 60_000), opened(8, 90_000, "wisp/parent")] });
    const rt = runtime(github, clock);
    setAutopilot(task.id, { autoMerge: true });
    await pass(rt, task.id, clock);
    clock.now += 3 * 60_000;
    await pass(rt, task.id, clock);
    expect(state.merges.map((merge) => merge.number)).toEqual([7]);
    // GitHub retargets the child onto main once the parent merges
    state.pulls = [opened(8, 90_000)];
    state.pr = snapshot({ number: 8, head: "e".repeat(40) });
    await pass(rt, task.id, clock);
    expect(autopilotStatus(task.id)).toMatchObject({ pr: 8 });
    expect(autopilotTurnNotes(task.id).notes[0]).toBe("PR #7 was merged by Wisp. This task's current PR is #8: continue on its branch.");
  });

  test("switched off while a look reads a PR that merged: it stays off, and still remembers whose merge it was", async () => {
    const task = doneTask();
    const clock = { now: START + 10 * 60_000 };
    const { state, github } = fakeGitHub({ pr: snapshot({ state: "MERGED" }) });
    const rt = runtime(github, clock);
    setAutopilot(task.id, { autoMerge: true, autoFix: true });
    seed(task.id, clock, { mergeAttempt: { head: HEAD, at: new Date(clock.now).toISOString() } });
    state.onSnapshot = () => { setAutopilot(task.id, { autoMerge: false, autoFix: false }); state.onSnapshot = null; };
    await pass(rt, task.id, clock);
    expect(autopilotRow(task.id)).toBeNull();
    expect(autopilotStatus(task.id)).toMatchObject({ state: "off", autoMerge: false, lastMerged: { pr: 7, byWisp: true } });
    // and the next turn still hears, once, that the merged branch is finished
    const notes = autopilotTurnNotes(task.id);
    expect(notes.notes).toEqual(["PR #7 was merged by Wisp. Its branch is finished: start any further change on a new branch from origin/main."]);
    notes.delivered();
    expect(autopilotTurnNotes(task.id).notes).toEqual([]);
  });

  test("switched off while gh merges: the merge that lands is still recorded as Wisp's", async () => {
    const task = doneTask();
    const clock = { now: START + 10 * 60_000 };
    const { state, github } = fakeGitHub();
    state.onMerge = () => { setAutopilot(task.id, { autoMerge: false }); };
    const rt = runtime(github, clock);
    setAutopilot(task.id, { autoMerge: true });
    seed(task.id, clock);
    await pass(rt, task.id, clock);
    expect(state.merges).toHaveLength(1);
    expect(autopilotRow(task.id)).toBeNull();
    expect(autopilotStatus(task.id)).toMatchObject({ state: "off", lastMerged: { pr: 7, byWisp: true } });
    expect(autopilotTurnNotes(task.id).notes[0]).toContain("PR #7 was merged by Wisp. Its branch is finished");
    // switched on again, the new row still knows the merge: the next PR must be numbered above it
    setAutopilot(task.id, { autoMerge: true });
    expect(autopilotStatus(task.id)).toMatchObject({ autoMerge: true, lastMerged: { pr: 7, byWisp: true } });
    state.pulls = [pull({ number: 6 })];
    await pass(rt, task.id, clock);
    expect(autopilotStatus(task.id)).toMatchObject({ pr: null, reason: "#7 merged by Wisp · Waiting for this task's own PR (#6 is older than #7, which merged)" });
  });

  test("held by a Stop with a merge under way, it still notices the merge landed", async () => {
    const task = doneTask();
    const clock = { now: START + 10 * 60_000 };
    const { state, github } = fakeGitHub({ pr: snapshot({ state: "MERGED" }) });
    const rt = runtime(github, clock);
    setAutopilot(task.id, { autoMerge: true });
    seed(task.id, clock, { stopHold: { turnCount: 5 }, mergeAttempt: { head: HEAD, at: new Date(clock.now).toISOString() } });
    await pass(rt, task.id, clock);
    expect(state.merges).toHaveLength(0);
    expect(autopilotStatus(task.id)).toMatchObject({ lastMerged: { pr: 7, byWisp: true } });
    // the hold is still the task's
    expect(checkpointOf(autopilotRow(task.id)!).stopHold).toEqual({ turnCount: 5 });
  });

  test("a Stop that lands while gh merges survives a lagging read-back", async () => {
    const task = doneTask();
    const clock = { now: START + 10 * 60_000 };
    const { state, github } = fakeGitHub();
    github.merge = async (input) => { state.merges.push({ number: input.number, method: input.method, head: input.head }); pauseTaskWorkflows(task.id); return { ok: true, detail: "" }; };
    const rt = runtime(github, clock);
    setAutopilot(task.id, { autoMerge: true });
    seed(task.id, clock);
    await pass(rt, task.id, clock);
    // the "Confirming the merge" save did not write the pre-merge checkpoint over the hold
    expect(checkpointOf(autopilotRow(task.id)!)).toMatchObject({ stopHold: { turnCount: 0 }, mergeAttempt: { head: HEAD } });
    // released, it records the merge as Wisp's
    resumeAutopilot(task.id);
    state.pr = snapshot({ state: "MERGED" });
    await pass(rt, task.id, clock);
    expect(autopilotStatus(task.id)).toMatchObject({ lastMerged: { pr: 7, byWisp: true } });
  });

  test("auto-fix alone is done for now once CI is green and the PR has been quiet fifteen minutes", async () => {
    const task = doneTask();
    const clock = { now: START + 10 * 60_000 };
    const { state, github } = fakeGitHub();
    const rt = runtime(github, clock);
    setAutopilot(task.id, { autoFix: true });
    // quiet counts from when the PR went green: the first green look starts it
    seed(task.id, clock);
    await pass(rt, task.id, clock);
    expect(autopilotStatus(task.id)).toMatchObject({ reason: "Nothing to fix", done: false });
    clock.now += 12 * 60_000;
    await pass(rt, task.id, clock);
    expect(autopilotStatus(task.id)).toMatchObject({ reason: "Nothing to fix", done: false });
    // it looks again exactly when the quiet completes, not on the five-minute cadence
    expect(Date.parse(autopilotRow(task.id)!.next_check_at) - clock.now).toBe(3 * 60_000);
    clock.now += 3 * 60_000;
    await pass(rt, task.id, clock);
    expect(autopilotStatus(task.id)).toMatchObject({ reason: "Nothing to fix · no new review for 15 min", done: true });
    // a new comment is new activity: not done until it too has gone quiet
    state.pr = { ...state.pr, comments: [{ id: "IC_1", author: "reader", association: "NONE", bot: false, body: "hm", createdAt: new Date(clock.now - 60_000).toISOString(), editedAt: null, url: "", hidden: false }] };
    await pass(rt, task.id, clock);
    expect(autopilotStatus(task.id)).toMatchObject({ reason: "Nothing to fix", done: false });
    // and needing a person is never done
    state.pr = snapshot({ checks: [{ name: "deploy", status: "WAITING", conclusion: null, required: true, url: "" }] });
    state.required = ["deploy"];
    clock.now += 30 * 60_000;
    await pass(rt, task.id, clock);
    expect(autopilotStatus(task.id)).toMatchObject({ state: "needs-you", done: false });
  });

  test("done is never stale: a red that is main's, a running turn, a resume or a toggle is not done", async () => {
    const task = doneTask();
    const clock = { now: START + 10 * 60_000 };
    const red = { name: "test", status: "COMPLETED", conclusion: "FAILURE", required: true, url: "" };
    const { state, github } = fakeGitHub({ pr: snapshot({ checks: [red], baseChecks: [red] }) });
    const rt = runtime(github, clock);
    setAutopilot(task.id, { autoFix: true });
    seed(task.id, clock);
    clock.now += 30 * 60_000;
    await pass(rt, task.id, clock);
    await pass(rt, task.id, clock);
    // red on main too is not this PR's to fix, but it is not green either
    expect(autopilotStatus(task.id)).toMatchObject({ reason: "test is red on main too", done: false });
    state.pr = snapshot();
    await pass(rt, task.id, clock);
    clock.now += 16 * 60_000;
    await pass(rt, task.id, clock);
    expect(autopilotStatus(task.id).done).toBe(true);
    // a turn running is work again
    transition(task.id, "running");
    expect(autopilotStatus(task.id).done).toBe(false);
    transition(task.id, "done");
    expect(autopilotStatus(task.id).done).toBe(true);
    // a changed switch is looked at afresh
    setAutopilot(task.id, { autoMerge: true });
    expect(autopilotStatus(task.id).done).toBe(false);
  });

  test("a row armed after a merge on another row is not done: nothing merged here yet", async () => {
    const task = doneTask();
    const clock = { now: START };
    const { github } = fakeGitHub();
    const rt = runtime(github, clock);
    setAutopilot(task.id, { autoMerge: true });
    await pass(rt, task.id, clock);
    clock.now += 3 * 60_000;
    await pass(rt, task.id, clock);
    expect(autopilotStatus(task.id)).toMatchObject({ lastMerged: { pr: 7 }, done: true });
    setAutopilot(task.id, { autoMerge: false });
    setAutopilot(task.id, { autoFix: true });
    await pass(rt, task.id, clock);
    expect(autopilotStatus(task.id)).toMatchObject({ lastMerged: { pr: 7 }, pr: null, done: false });
  });

  test("closing a PR still switches both off: that is how its owner abandons an approach", async () => {
    const task = doneTask();
    const clock = { now: START };
    const { state, github } = fakeGitHub();
    const rt = runtime(github, clock);
    setAutopilot(task.id, { autoMerge: true, autoFix: true });
    seed(task.id, clock);
    state.pr = snapshot({ state: "CLOSED" });
    await pass(rt, task.id, clock);
    expect(autopilotStatus(task.id)).toMatchObject({ autoMerge: false, autoFix: false, state: "off", reason: "Auto-merge off — #7 was closed" });
  });

  test("with no open PR it waits; the oldest PR onto the base wins over a stacked child", async () => {
    const task = doneTask();
    const clock = { now: START };
    const { state, github } = fakeGitHub({ pulls: [] });
    const rt = runtime(github, clock);
    setAutopilot(task.id, { autoMerge: true });
    await pass(rt, task.id, clock);
    expect(autopilotStatus(task.id)).toMatchObject({ pr: null, reason: "Waiting for a PR" });
    const later = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();
    state.pulls = [
      pull({ number: 9, headRefName: "wisp/child", baseRefName: "wisp/fixture", createdAt: later(1) }),
      pull({ number: 8, headRefName: "wisp/fixture", baseRefName: "main", createdAt: later(2) }),
    ];
    await pass(rt, task.id, clock);
    expect(autopilotStatus(task.id).pr).toBe(8);
  });

  test("a busy task is never merged, and settling brings its check forward", async () => {
    const task = doneTask();
    const clock = { now: START + 10 * 60_000 };
    const { state, github } = fakeGitHub();
    const rt = runtime(github, clock);
    setAutopilot(task.id, { autoMerge: true });
    seed(task.id, clock);
    transition(task.id, "running");
    await pass(rt, task.id, clock);
    expect(state.merges).toHaveLength(0);
    // a reason about the task must never stand in for the PR's own facts
    expect(autopilotStatus(task.id)).toMatchObject({ reason: "Waiting for the task to finish", about: "task" });
    transition(task.id, "needs-input");
    await pass(rt, task.id, clock);
    expect(autopilotStatus(task.id).reason).toBe("Waiting for your answer");
    expect(state.merges).toHaveLength(0);
  });

  test("Stop holds it until the owner's next turn has finished, then it carries on by itself", async () => {
    const task = doneTask();
    const clock = { now: START + 10 * 60_000 };
    const { state, github } = fakeGitHub();
    const rt = runtime(github, clock);
    setAutopilot(task.id, { autoMerge: true });
    seed(task.id, clock);
    pauseTaskWorkflows(task.id);
    expect(autopilotStatus(task.id)).toMatchObject({ state: "held", autoMerge: true });
    // stopping only a background process leaves the task done — still held
    await pass(rt, task.id, clock);
    expect(state.merges).toHaveLength(0);
    expect(autopilotStatus(task.id).state).toBe("held");
    setTaskFields(task.id, { turn_count: task.turn_count + 1 });
    await pass(rt, task.id, clock);
    expect(state.merges).toHaveLength(1);
  });

  test("Continue now releases a Stop hold early", async () => {
    const task = doneTask();
    setAutopilot(task.id, { autoMerge: true });
    pauseTaskWorkflows(task.id);
    expect(autopilotStatus(task.id).state).toBe("held");
    expect(resumeAutopilot(task.id)).toMatchObject({ state: "waiting", about: "task" });
    expect(checkpointOf(autopilotRow(task.id)!).stopHold).toBeUndefined();
  });

  test("an agent or context change does not switch it off: it follows the task", async () => {
    const task = doneTask();
    const clock = { now: START };
    const { github } = fakeGitHub();
    const rt = runtime(github, clock);
    setAutopilot(task.id, { autoMerge: true });
    db.run("UPDATE tasks SET context_n = context_n + 1 WHERE id = ?", [task.id]);
    expect(autopilotRow(task.id)!.state).toBe("paused");
    expect(autopilotStatus(task.id)).toMatchObject({ state: "waiting", reason: "Following the task's agent change", about: "task" });
    await rt.tick();
    expect(autopilotRow(task.id)!.state).toBe("active");
  });

  test("archiving asks first only while it is watching a PR", () => {
    const task = doneTask();
    expect(autopilotArchiveWarning(task.id)).toBeNull();
    // armed with no PR yet: nothing to stop
    setAutopilot(task.id, { autoMerge: true });
    expect(autopilotArchiveWarning(task.id)).toBeNull();
    writeAutopilotCheckpoint(autopilotRow(task.id)!, { pr: 7 }, new Date());
    expect(autopilotArchiveWarning(task.id)).toBe("Auto-merge is on for PR #7 — archiving switches it off. Archive anyway to stop it, or force-archive.");
    // once it has nothing left to do, archive does not ask
    setAutopilot(task.id, { autoMerge: false });
    expect(autopilotArchiveWarning(task.id)).toBeNull();
  });

  test("archive stands it down through the existing trigger", () => {
    const task = doneTask();
    setAutopilot(task.id, { autoMerge: true });
    setTaskFields(task.id, { archived: 1 });
    expect(autopilotRow(task.id)).toBeNull();
    expect(autopilotStatus(task.id).autoMerge).toBe(false);
  });

  test("a closed PR turns auto-merge off rather than moving on to another", async () => {
    const task = doneTask();
    const clock = { now: START };
    const { state, github } = fakeGitHub();
    const rt = runtime(github, clock);
    setAutopilot(task.id, { autoMerge: true });
    state.pr = snapshot({ state: "CLOSED" });
    await pass(rt, task.id, clock);
    expect(autopilotStatus(task.id)).toMatchObject({ state: "off", reason: "Auto-merge off — #7 was closed" });
  });

  test("a merge that lands before a crash is still recorded as Wisp's", async () => {
    const task = doneTask();
    const clock = { now: START };
    const { state, github } = fakeGitHub({ pr: snapshot({ state: "MERGED" }) });
    const rt = runtime(github, clock);
    setAutopilot(task.id, { autoMerge: true });
    writeAutopilotCheckpoint(autopilotRow(task.id)!, { pr: 7, mergeAttempt: { head: HEAD, at: new Date(START).toISOString() } }, new Date(clock.now));
    await pass(rt, task.id, clock);
    expect(state.merges).toHaveLength(0);
    expect(autopilotStatus(task.id)).toMatchObject({ state: "waiting", lastMerged: { pr: 7, byWisp: true }, reason: "#7 merged by Wisp · Waiting for the task's next PR" });
  });

  test("merge failures retry, then pause for Resume; GitHub's own auto-merge also pauses", async () => {
    const task = doneTask();
    const clock = { now: START + 10 * 60_000 };
    const { state, github } = fakeGitHub();
    const rt = runtime(github, clock);
    setAutopilot(task.id, { autoMerge: true });
    seed(task.id, clock);
    state.mergeResult = { ok: false, detail: "Base branch was modified" };
    for (let attempt = 1; attempt <= 3; attempt++) await pass(rt, task.id, clock);
    expect(state.merges).toHaveLength(3);
    expect(autopilotStatus(task.id)).toMatchObject({ state: "paused", reason: "Merge failed: Base branch was modified" });
    await pass(rt, task.id, clock);
    expect(state.merges).toHaveLength(3);
    resumeAutopilot(task.id);
    state.pr = snapshot({ providerAutoMerge: true });
    await pass(rt, task.id, clock);
    expect(autopilotStatus(task.id)).toMatchObject({ state: "paused", reason: expect.stringContaining("GitHub auto-merge was turned on") });
  });

  test("turning it off while GitHub is being asked wins over the answer", async () => {
    const task = doneTask();
    const clock = { now: START + 10 * 60_000 };
    const { state, github } = fakeGitHub();
    const rt = runtime(github, clock);
    setAutopilot(task.id, { autoMerge: true });
    seed(task.id, clock);
    state.onSnapshot = () => { setAutopilot(task.id, { autoMerge: false }); };
    await pass(rt, task.id, clock);
    expect(state.merges).toHaveLength(0);
  });

  test("no new turn can start while the merge runs, and the queue drains when it ends", async () => {
    const task = doneTask();
    const clock = { now: START + 10 * 60_000 };
    const { state, github } = fakeGitHub();
    const rt = runtime(github, clock);
    setAutopilot(task.id, { autoMerge: true });
    seed(task.id, clock);
    let during = false;
    let said = "";
    state.onMerge = () => { during = isTaskMerging(task.id); said = autopilotStatus(task.id).reason; };
    await pass(rt, task.id, clock);
    expect(during).toBe(true);
    // while gh runs, the status says what is happening, not the last wait
    expect(said).toBe("Merging #7 (squash)");
    expect(isTaskMerging(task.id)).toBe(false);
  });
});

describe("binding and the edges of a merge", () => {
  test("only a PR this task could have opened is adopted", () => {
    const task = doneTask();
    const bases = new Set(["main"]);
    const later = new Date(Date.parse(task.created_at) + 60_000).toISOString();
    const before = new Date(Date.parse(task.created_at) - 60_000).toISOString();
    // someone else's PR the worktree checked out, and the owner's older PR, are never adopted
    expect(choosePull([pull({ number: 3, author: "colleague", createdAt: later })], task, "owner", bases)).toBeNull();
    expect(choosePull([pull({ number: 4, createdAt: before })], task, "owner", bases)).toBeNull();
    expect(choosePull([pull({ number: 5, isCrossRepository: true, createdAt: later })], task, "owner", bases)).toBeNull();
    expect(choosePull([pull({ number: 6, createdAt: later })], task, "", bases)).toBeNull();
    // the task's own branch name wins over an older PR from another checkout
    const own = pull({ number: 8, headRefName: task.branch!, createdAt: new Date(Date.parse(later) + 60_000).toISOString() });
    expect(choosePull([pull({ number: 7, headRefName: "wisp/other", createdAt: later }), own], task, "owner", bases)?.number).toBe(8);
  });

  test("a gh merge whose read-back lags is confirmed on the next look, not counted as a failure", async () => {
    const task = doneTask();
    const clock = { now: START + 10 * 60_000 };
    const { state, github } = fakeGitHub();
    github.merge = async (input) => { state.merges.push({ number: input.number, method: input.method, head: input.head }); return { ok: true, detail: "" }; };
    const rt = runtime(github, clock);
    setAutopilot(task.id, { autoMerge: true });
    seed(task.id, clock);
    await pass(rt, task.id, clock);
    expect(autopilotStatus(task.id)).toMatchObject({ state: "merging", reason: "Confirming the merge" });
    expect(checkpointOf(autopilotRow(task.id)!).mergeAttempt?.head).toBe(HEAD);
    state.pr = snapshot({ state: "MERGED" });
    await pass(rt, task.id, clock);
    expect(autopilotStatus(task.id)).toMatchObject({ state: "waiting", lastMerged: { pr: 7, byWisp: true }, reason: "#7 merged by Wisp · Waiting for the task's next PR" });
  });

  test("a paused row still notices that its PR was merged", async () => {
    const task = doneTask();
    const clock = { now: START };
    const { state, github } = fakeGitHub();
    const rt = runtime(github, clock);
    setAutopilot(task.id, { autoMerge: true });
    seed(task.id, clock);
    db.run("UPDATE workflows SET state = 'paused', reason = 'Merge failed: x' WHERE task_id = ? AND type = 'pr-autopilot'", [task.id]);
    state.pr = snapshot({ state: "MERGED" });
    await pass(rt, task.id, clock);
    // someone else merged it: not Wisp's, and the pause was about that PR, so it is active again
    expect(autopilotStatus(task.id)).toMatchObject({ state: "waiting", reason: "#7 merged · Waiting for the task's next PR", lastMerged: { pr: 7, byWisp: false } });
    expect(autopilotRow(task.id)!.state).toBe("active");
  });

  test("marking a draft ready restarts the wait for its checks", async () => {
    const task = doneTask();
    const clock = { now: START + 10 * 60_000 };
    const { state, github } = fakeGitHub({ pr: snapshot({ isDraft: true }) });
    const rt = runtime(github, clock);
    setAutopilot(task.id, { autoMerge: true });
    seed(task.id, clock);
    await pass(rt, task.id, clock);
    expect(autopilotStatus(task.id).reason).toContain("Draft");
    state.pr = snapshot({ isDraft: false });
    await pass(rt, task.id, clock);
    expect(state.merges).toHaveLength(0);
    expect(autopilotStatus(task.id).reason).toBe("Waiting for checks to start");
    clock.now += 3 * 60_000;
    await pass(rt, task.id, clock);
    expect(state.merges).toHaveLength(1);
  });

  test("a task settling brings its check forward through the event bus", async () => {
    const task = doneTask();
    const clock = { now: START };
    const { github } = fakeGitHub({ pulls: [] });
    const rt = runtime(github, clock);
    setAutopilot(task.id, { autoMerge: true });
    db.run("UPDATE workflows SET next_check_at = '9999-01-01T00:00:00.000Z' WHERE task_id = ? AND type = 'pr-autopilot'", [task.id]);
    rt.start();
    try {
      transition(task.id, "running");
      transition(task.id, "done");
      await until(() => autopilotRow(task.id)!.check_count > 0, "the settle kick");
    } finally {
      await rt.stop();
    }
  });

  test("a PR that exists but is not the task's own is named, not hidden behind \"waiting for a PR\"", async () => {
    const task = doneTask();
    const clock = { now: START };
    const { github } = fakeGitHub({ pulls: [pull({ number: 11, author: "ci-bot" })] });
    const rt = runtime(github, clock);
    setAutopilot(task.id, { autoMerge: true });
    await pass(rt, task.id, clock);
    expect(autopilotStatus(task.id)).toMatchObject({ pr: null, reason: "Waiting for this task's own PR (#11 was opened by @ci-bot, not @owner)" });
  });

  test("a turn after Stop that FAILS does not release the hold", async () => {
    const task = doneTask();
    const clock = { now: START + 10 * 60_000 };
    const { state, github } = fakeGitHub();
    const rt = runtime(github, clock);
    setAutopilot(task.id, { autoMerge: true });
    seed(task.id, clock);
    pauseTaskWorkflows(task.id);
    setTaskFields(task.id, { turn_count: task.turn_count + 1 });
    transition(task.id, "failed", "exited 1");
    await pass(rt, task.id, clock);
    expect(autopilotStatus(task.id).state).toBe("held");
    expect(state.merges).toHaveLength(0);
  });

  test("while a merge is being confirmed, a turn is told not to push — and only then", async () => {
    const task = doneTask();
    const clock = { now: START + 10 * 60_000 };
    setAutopilot(task.id, { autoMerge: true });
    seed(task.id, clock, { mergeAttempt: { head: HEAD, at: new Date(START).toISOString() }, state: "merging" });
    expect(autopilotTurnNotes(task.id).notes[0]).toContain("Do not push to its branch");
    // the merge queue ejected it and a check failed: the agent must be free to push the fix
    const { state, github } = fakeGitHub({ pr: snapshot({ checks: [{ name: "test", status: "COMPLETED", conclusion: "FAILURE", required: true, url: "" }] }) });
    const rt = runtime(github, clock);
    await pass(rt, task.id, clock);
    await pass(rt, task.id, clock);
    expect(autopilotStatus(task.id)).toMatchObject({ state: "needs-you", reason: "test failed" });
    expect(checkpointOf(autopilotRow(task.id)!).mergeAttempt).toBeUndefined();
    expect(autopilotTurnNotes(task.id).notes[0]).toContain("push the branch");
    expect(state.merges).toHaveLength(0);
  });

  test("GitHub's own auto-merge turning on during the merge pauses without telling turns not to push", async () => {
    const task = doneTask();
    const clock = { now: START + 10 * 60_000 };
    const { state, github } = fakeGitHub();
    const rt = runtime(github, clock);
    setAutopilot(task.id, { autoMerge: true });
    seed(task.id, clock);
    state.mergeResult = { ok: false, detail: "auto-merge enabled" };
    state.onMerge = () => { state.pr = snapshot({ providerAutoMerge: true }); };
    await pass(rt, task.id, clock);
    expect(autopilotStatus(task.id)).toMatchObject({ state: "paused", reason: expect.stringContaining("GitHub auto-merge was turned on") });
    expect(autopilotTurnNotes(task.id).notes[0]).not.toContain("Do not push");
  });

  test("Stop holds it even when there was no turn left to stop", async () => {
    const task = doneTask();
    setAutopilot(task.id, { autoMerge: true });
    await interruptTurn(task.id).catch(() => undefined);
    expect(autopilotStatus(task.id).state).toBe("held");
  });
});

describe("what the agent is told", () => {
  test("a turn queued during the merge waits for it, then hears the branch is finished", async () => {
    const { dir, file, adapters } = capture();
    const task = doneTask({ harness: "capture" });
    setTaskFields(task.id, { worktree_path: dir, turn_count: 1 });
    const clock = { now: START + 10 * 60_000 };
    const { state, github } = fakeGitHub();
    const rt = runtime(github, clock, adapters);
    setAutopilot(task.id, { autoMerge: true });
    seed(task.id, clock);
    let refused: unknown = "not asked";
    state.onMerge = () => {
      queue(task.id, "also fix the typo");
      refused = startNextQueuedMessage(task.id, adapters, loadConfig());
    };
    await pass(rt, task.id, clock);
    expect(refused).toBeNull();
    await until(() => existsSync(file), "the queued turn");
    const prompt = readFileSync(file, "utf8");
    expect(prompt).toContain("PR #7 was merged by Wisp. Its branch is finished");
    // the switch stayed on: the next change gets the same standing note
    expect(prompt).toContain("Auto-merge is on for this task");
    expect(prompt.endsWith("also fix the typo")).toBe(true);
    await until(() => getTask(task.id)?.state === "done", "the turn to settle");
  });

  test("a later turn's slash command is left alone; the note waits for a plain turn", async () => {
    const { dir, file, adapters } = capture();
    const task = doneTask({ harness: "capture" });
    setTaskFields(task.id, { worktree_path: dir, turn_count: 1 });
    setAutopilot(task.id, { autoMerge: true });
    queue(task.id, "/compact");
    expect(startNextQueuedMessage(task.id, adapters, loadConfig())).not.toBeNull();
    await until(() => existsSync(file), "the command turn");
    expect(readFileSync(file, "utf8")).toBe("/compact");
    await until(() => getTask(task.id)?.state === "done", "the turn to settle");
  });

  test("while auto-merge is on, every turn says a push is wanted and the merge is Wisp's", () => {
    const task = doneTask();
    expect(autopilotTurnNotes(task.id).notes).toEqual([]);
    setAutopilot(task.id, { autoMerge: true });
    const [note] = autopilotTurnNotes(task.id).notes;
    expect(note).toContain("push the branch, and open a pull request");
    expect(note).toContain("Wisp merges this task's pull request");
    expect(note).toContain("Other pull requests are unaffected");
    const preamble = taskPreamble(task, [note!]);
    expect(preamble.indexOf(note!)).toBeLessThan(preamble.indexOf("Task:"));
  });
});

describe("the published-work check", () => {
  function repo() {
    const dir = mkdtempSync(join(tmpdir(), "wisp-autopilot-git-"));
    const git = (...args: string[]) => {
      const result = Bun.spawnSync(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args], { cwd: dir });
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      return result.stdout.toString().trim();
    };
    git("init", "-q", "-b", "wisp/fixture");
    writeFileSync(join(dir, "a.txt"), "one\n");
    git("add", ".");
    git("commit", "-q", "-m", "one");
    return { dir, git, head: git("rev-parse", "HEAD") };
  }
  const task = (dir: string): Task => ({ ...doneTask(), repo_path: dir, worktree_path: dir });
  const signal = new AbortController().signal;

  test("the PR head matching the branch, with only untracked files around, is published", async () => {
    const { dir, head } = repo();
    writeFileSync(join(dir, "codedb.snapshot"), "an index some tool dropped here");
    expect(await publishedWork(task(dir), "wisp/fixture", head, signal)).toEqual({ ok: true });
  });

  test("a local commit the PR lacks, or a tracked edit, blocks the merge", async () => {
    const { dir, git, head } = repo();
    writeFileSync(join(dir, "a.txt"), "two\n");
    expect(await publishedWork(task(dir), "wisp/fixture", head, signal)).toEqual({ ok: false, reason: "Worktree has uncommitted changes" });
    git("commit", "-q", "-am", "two");
    expect(await publishedWork(task(dir), "wisp/fixture", head, signal)).toEqual({ ok: false, reason: "Worktree has commits the PR does not" });
  });

  test("a PR ahead of the local branch is fine; a head nobody can find is not verifiable", async () => {
    const { dir, git, head } = repo();
    writeFileSync(join(dir, "a.txt"), "two\n");
    git("commit", "-q", "-am", "two");
    const ahead = git("rev-parse", "HEAD");
    git("reset", "-q", "--hard", head);
    expect(await publishedWork(task(dir), "wisp/fixture", ahead, signal)).toEqual({ ok: true });
    expect(await publishedWork(task(dir), "wisp/fixture", "d".repeat(40), signal)).toEqual({ ok: false, reason: "Can't verify the worktree" });
  });

  test("a PR head only the remote has is fetched, then checked", async () => {
    const origin = repo();
    const clone = mkdtempSync(join(tmpdir(), "wisp-autopilot-clone-"));
    const cloned = Bun.spawnSync(["git", "clone", "-q", origin.dir, clone]);
    expect(cloned.exitCode, cloned.stderr.toString()).toBe(0);
    // "Update branch", or a suggestion committed on GitHub: the remote moved on
    writeFileSync(join(origin.dir, "a.txt"), "remote only\n");
    origin.git("commit", "-q", "-am", "remote only");
    const remoteHead = origin.git("rev-parse", "HEAD");
    expect(Bun.spawnSync(["git", "cat-file", "-e", remoteHead], { cwd: clone }).exitCode).not.toBe(0);
    expect(await publishedWork(task(clone), "wisp/fixture", remoteHead, signal)).toEqual({ ok: true });
  });

  test("a worktree that moved on to unrelated work has not unpublished the PR", async () => {
    const { dir, git, head } = repo();
    git("checkout", "-q", "--orphan", "wisp/second");
    git("rm", "-q", "-rf", ".");
    writeFileSync(join(dir, "b.txt"), "unrelated\n");
    git("add", ".");
    git("commit", "-q", "-m", "unrelated");
    writeFileSync(join(dir, "b.txt"), "dirty on another line of work\n");
    expect(await publishedWork(task(dir), "wisp/fixture", head, signal)).toEqual({ ok: true });
  });

  test("work built on the PR under another name, or on a detached HEAD, is caught", async () => {
    const { dir, git, head } = repo();
    // renamed: the PR's branch name is gone locally, the extra commit is not
    git("branch", "-m", "wisp/renamed");
    writeFileSync(join(dir, "a.txt"), "two\n");
    git("commit", "-q", "-am", "two");
    expect(await publishedWork(task(dir), "wisp/fixture", head, signal)).toEqual({ ok: false, reason: "Branch wisp/renamed has unpushed commits built on the PR" });
    // detached, with an extra commit and nothing else pointing at it
    const second = repo();
    second.git("checkout", "-q", "--detach");
    writeFileSync(join(second.dir, "a.txt"), "two\n");
    second.git("commit", "-q", "-am", "two");
    expect(await publishedWork(task(second.dir), "wisp/fixture", second.head, signal)).toEqual({ ok: false, reason: "Worktree has commits the PR does not" });
    // an unpushed branch built on the PR, while HEAD sits back on the PR itself
    const third = repo();
    third.git("checkout", "-q", "-b", "wisp/extra");
    writeFileSync(join(third.dir, "a.txt"), "two\n");
    third.git("commit", "-q", "-am", "two");
    third.git("checkout", "-q", "wisp/fixture");
    expect(await publishedWork(task(third.dir), "wisp/fixture", third.head, signal)).toEqual({ ok: false, reason: "Branch wisp/extra has unpushed commits built on the PR" });
  });

  test("a stacked child that was pushed for its own PR does not hold its parent back", async () => {
    const { dir, git, head } = repo();
    git("checkout", "-q", "-b", "wisp/child");
    writeFileSync(join(dir, "a.txt"), "child\n");
    git("commit", "-q", "-am", "child");
    // what `git push` leaves behind: a remote-tracking ref at the child's tip
    git("update-ref", "refs/remotes/origin/wisp/child", "HEAD");
    expect(await publishedWork(task(dir), "wisp/fixture", head, signal)).toEqual({ ok: true });
  });

  test("a rebase in progress on the PR's line is not something to merge under", async () => {
    const { dir, git, head } = repo();
    const gitDir = git("rev-parse", "--git-dir");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(dir, gitDir, "rebase-merge"));
    expect(await publishedWork(task(dir), "wisp/fixture", head, signal)).toEqual({ ok: false, reason: "Worktree has a rebase or merge in progress" });
  });
});

describe("API and CLI", () => {
  const call = (taskId: string, method: string, body?: unknown, suffix = "") => {
    const path = `/api/tasks/${taskId}/autopilot${suffix}`;
    return autopilotRoute(new Request(`http://wisp.test${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), path);
  };

  test("a create request says what to arm, and a bad one is refused before any task exists", async () => {
    const create = (body: Record<string, unknown>) => createTaskRoute(new Request("http://wisp.test/api/tasks", {
      method: "POST", body: JSON.stringify({ repoPath: "/tmp/nowhere", prompt: "p", harness: "fake", ...body }),
    }), loadConfig(), {});
    expect((await create({ autopilot: "yes" })).status).toBe(400);
    expect((await create({ autopilot: { autoMerge: "on" } })).status).toBe(400);
    const local = await create({ mode: "local", autopilot: { autoMerge: true } });
    expect(local.status).toBe(400);
    expect(await local.text()).toContain("need a worktree task");
  });

  test("the route validates, toggles, and resumes", async () => {
    const task = doneTask();
    expect((await call(task.id, "PUT", { autoMerge: "yes" })).status).toBe(400);
    expect((await call(task.id, "PUT", { whatever: true })).status).toBe(400);
    expect((await call(task.id, "POST", {}, "/resume")).status).toBe(409);
    expect(await (await call(task.id, "PUT", { autoMerge: true })).json()).toMatchObject({ autoMerge: true });
    expect(await (await call(task.id, "GET")).json()).toMatchObject({ autoMerge: true, state: "waiting" });
    expect((await call("tnope1", "GET")).status).toBe(404);
  });

  test("wisp pr prints one line and drives the same route", async () => {
    expect(formatAutopilot({ autoMerge: true, autoFix: false, pr: 7, state: "waiting", reason: "Waiting for checks (2 running)", updatedAt: null }))
      .toBe("auto-merge: on · PR #7 · waiting · Waiting for checks (2 running)");
    expect(formatAutopilot({ autoMerge: false, autoFix: false, pr: 7, state: "merged", reason: "Merged by Wisp", updatedAt: null }))
      .toBe("auto-merge: done · PR #7 · Merged by Wisp");
    // off names both switches, and a plain switch-off adds nothing
    expect(formatAutopilot({ autoMerge: false, autoFix: false, pr: null, state: "off", reason: "Auto-merge off", updatedAt: null } as never))
      .toBe("auto-merge and auto-fix: off");
    expect(formatAutopilot({ autoMerge: false, autoFix: false, pr: 7, state: "off", reason: "Auto-merge off — #7 was closed", updatedAt: null } as never))
      .toBe("auto-merge and auto-fix: off · PR #7 · Auto-merge off — #7 was closed");
    const calls: unknown[] = [];
    const api = async (...args: unknown[]) => { calls.push(args); return { autoMerge: true, autoFix: false, pr: null, state: "waiting", reason: "Waiting for a PR", updatedAt: null }; };
    await prCommand(["tabcde", "merge", "on"], { json: true }, api);
    await prCommand(["tabcde", "resume"], { json: true }, api);
    expect(calls).toEqual([["/api/tasks/tabcde/autopilot", "PUT", { autoMerge: true }], ["/api/tasks/tabcde/autopilot/resume", "POST", {}]]);
    await expect(prCommand(["tabcde", "merge", "maybe"], {}, api)).rejects.toThrow("usage");
  });
});

describe("auto-fix", () => {
  const RED = { name: "test", status: "COMPLETED", conclusion: "FAILURE", required: true, url: "https://ci/test", checkRunId: 11, run: { id: 5, event: "pull_request" }, deployment: false };
  const redPr = (over: Partial<PrSnapshot> = {}) => snapshot({ checks: [RED], ...over });
  const longAgo = new Date(START).toISOString();

  function fixTask() {
    const { dir, file, adapters } = capture();
    const task = doneTask({ harness: "capture" });
    setTaskFields(task.id, { worktree_path: dir, turn_count: 1 });
    return { task, file, adapters };
  }

  test("a red required check waits out a short delay, then reaches the agent with its log — once", async () => {
    const { task, file, adapters } = fixTask();
    const clock = { now: START + 10 * 60_000 };
    const { state, github } = fakeGitHub({ pr: redPr() });
    const rt = runtime(github, clock, adapters);
    setAutopilot(task.id, { autoFix: true });
    seed(task.id, clock);
    await pass(rt, task.id, clock);
    expect(autopilotStatus(task.id)).toMatchObject({ state: "waiting", reason: "Auto-fix will send: test failing", pendingFix: { summary: "test failing" }, about: "pr" });
    expect(existsSync(file)).toBe(false);
    clock.now += SEND_DELAY_MS + 1000;
    await pass(rt, task.id, clock);
    await until(() => existsSync(file), "the fix round");
    const prompt = readFileSync(file, "utf8");
    expect(prompt.split("\n")).toContain(`[Wisp auto-fix · PR #7 · round 1 of 3 · head ${HEAD.slice(0, 7)}]`);
    // the standing note travels with every turn while auto-fix is on: how to sign GitHub posts
    expect(prompt).toContain(`End every comment, review or reply you post on GitHub with: — capture via Wisp <!-- wisp:task=${task.id} -->`);
    const evidence = readFileSync(prompt.match(/Read (\S+PR-FEEDBACK\.md)/)![1]!, "utf8");
    expect(evidence).toContain("- test (required) — FAILURE — https://ci/test");
    expect(evidence).toContain("(fail) retry never stops");
    expect(autopilotStatus(task.id).fixRounds).toBe(1);
    expect(state.merges).toHaveLength(0);
    await until(() => getTask(task.id)?.state === "done", "the round to settle");
    // the agent did not push: the same evidence is never sent twice
    await pass(rt, task.id, clock);
    expect(autopilotStatus(task.id)).toMatchObject({ state: "needs-you", reason: "Still test failing after round 1, with no new push" });
  });

  test("Send now skips the delay", async () => {
    const { task, file, adapters } = fixTask();
    const clock = { now: START + 10 * 60_000 };
    const { github } = fakeGitHub({ pr: redPr() });
    const rt = runtime(github, clock, adapters);
    setAutopilot(task.id, { autoFix: true });
    seed(task.id, clock);
    await pass(rt, task.id, clock);
    expect(sendPendingFix(task.id).pendingFix).not.toBeNull();
    await pass(rt, task.id, clock);
    await until(() => existsSync(file), "the fix round");
    await until(() => getTask(task.id)?.state === "done", "the round to settle");
  });

  test("Skip never sends that evidence; a new head is new evidence, and a round again", async () => {
    const { task, file, adapters } = fixTask();
    const clock = { now: START + 10 * 60_000 };
    const { state, github } = fakeGitHub({ pr: redPr() });
    const rt = runtime(github, clock, adapters);
    setAutopilot(task.id, { autoFix: true });
    seed(task.id, clock);
    await pass(rt, task.id, clock);
    skipPendingFix(task.id);
    clock.now += SEND_DELAY_MS + 1000;
    await pass(rt, task.id, clock);
    expect(autopilotStatus(task.id)).toMatchObject({ state: "needs-you", reason: "test failed (auto-fix skipped)" });
    expect(existsSync(file)).toBe(false);
    state.pr = redPr({ head: "a".repeat(40) });
    await pass(rt, task.id, clock);
    await until(() => existsSync(file), "a round for the new head");
    await until(() => getTask(task.id)?.state === "done", "the round to settle");
  });

  test("after three rounds it gives up and pauses; Resume starts the budget again", async () => {
    const { task, adapters } = fixTask();
    const clock = { now: START + 10 * 60_000 };
    const { github } = fakeGitHub({ pr: redPr() });
    const rt = runtime(github, clock, adapters);
    setAutopilot(task.id, { autoFix: true });
    seed(task.id, clock, { rounds: 3, idleSince: longAgo, idleTurn: 1 });
    await pass(rt, task.id, clock);
    expect(autopilotStatus(task.id)).toMatchObject({ state: "paused", reason: "Auto-fix gave up after 3 rounds — resume to try again" });
    expect(resumeAutopilot(task.id).fixRounds).toBe(0);
  });

  test("without required checks, a red gets one token-free rerun before it costs a turn", async () => {
    const { task, file, adapters } = fixTask();
    const clock = { now: START + 10 * 60_000 };
    const { state, github } = fakeGitHub({ pr: snapshot({ checks: [{ ...RED, required: false }] }) });
    state.required = [];
    const rt = runtime(github, clock, adapters);
    setAutopilot(task.id, { autoFix: true });
    seed(task.id, clock, { idleSince: longAgo, idleTurn: 1 });
    await pass(rt, task.id, clock);
    expect(state.reruns).toEqual([5]);
    expect(autopilotStatus(task.id)).toMatchObject({ reason: "Rerunning test", by: "auto-fix" });
    // the rerun came back red too: now it is worth a turn
    await pass(rt, task.id, clock);
    await until(() => existsSync(file), "the fix round");
    expect(state.reruns).toEqual([5]);
    await until(() => getTask(task.id)?.state === "done", "the round to settle");
  });

  test("with both on, a red is fixed and never merged; once green, it merges", async () => {
    const { task, file, adapters } = fixTask();
    const clock = { now: START + 10 * 60_000 };
    const { state, github } = fakeGitHub({ pr: redPr() });
    const rt = runtime(github, clock, adapters);
    setAutopilot(task.id, { autoMerge: true, autoFix: true });
    seed(task.id, clock, { idleSince: longAgo, idleTurn: 1 });
    await pass(rt, task.id, clock);
    await until(() => existsSync(file), "the fix round");
    expect(readFileSync(file, "utf8")).toContain("Do not wait for CI and do not merge");
    expect(state.merges).toHaveLength(0);
    await until(() => getTask(task.id)?.state === "done", "the round to settle");
    state.pr = snapshot();
    await pass(rt, task.id, clock);
    expect(state.merges).toHaveLength(1);
  });

  test("a round that never started is withdrawn, and its checkpoint comes back", () => {
    const task = doneTask();
    setAutopilot(task.id, { autoFix: true });
    const row = autopilotRow(task.id)!;
    expect(reserveRound(row, { key: "ci:x:test", prompt: "fix it", reason: "Sent test failing (round 1 of 3)", checkpoint: { ...checkpointOf(row), rounds: 1 }, turnCount: 0 }, new Date())).not.toBeNull();
    expect(checkpointOf(autopilotRow(task.id)!).rounds).toBe(1);
    expect(withdrawQueuedRound(autopilotRow(task.id)!)).toBe(true);
    expect(checkpointOf(autopilotRow(task.id)!).rounds).toBeUndefined();
  });

  test("a round reserved after the task got busy is refused; Stop withdraws a queued one and keeps its hold", () => {
    const task = doneTask();
    setAutopilot(task.id, { autoFix: true });
    const round = (row = autopilotRow(task.id)!) =>
      reserveRound(row, { key: "ci:x:test", prompt: "fix it", reason: "Sent", checkpoint: { ...checkpointOf(row), rounds: 1 }, turnCount: 0 }, new Date());
    queue(task.id, "the owner's own message");
    expect(round()).toBeNull();
    db.run("DELETE FROM task_messages WHERE task_id = ?", [task.id]);
    // a turn since the look began makes its evidence stale
    expect(reserveRound(autopilotRow(task.id)!, { key: "ci:x:test", prompt: "fix it", reason: "Sent", checkpoint: {}, turnCount: 7 }, new Date())).toBeNull();
    // the round came from a countdown, which the cancel below restores
    writeAutopilotCheckpoint(autopilotRow(task.id)!, { pending: { key: "ci:x:test", summary: "test failing", sendsAt: new Date().toISOString() } }, new Date());
    const id = round()!;
    pauseTaskWorkflows(task.id);
    const message = db.query("SELECT status FROM task_messages WHERE id = ?").get(id) as { status: string };
    expect(message.status).toBe("cancelled");
    // the cancel restored the checkpoint from before the round; the hold was written onto it
    const checkpoint = checkpointOf(autopilotRow(task.id)!);
    expect(checkpoint.stopHold).toBeDefined();
    expect(checkpoint.rounds).toBeUndefined();
    expect(checkpoint.pending).toBeUndefined();
    expect(autopilotStatus(task.id)).toMatchObject({ state: "held", pendingFix: null });
  });

  test("the delay runs from the task's latest turn: one the owner finished meanwhile restarts it", async () => {
    const { task, file, adapters } = fixTask();
    const clock = { now: START + 10 * 60_000 };
    const { github } = fakeGitHub({ pr: redPr() });
    const rt = runtime(github, clock, adapters);
    setAutopilot(task.id, { autoFix: true });
    seed(task.id, clock);
    await pass(rt, task.id, clock);
    const first = autopilotStatus(task.id).pendingFix!.sendsAt;
    // the owner steered and the turn finished between two looks
    setTaskFields(task.id, { turn_count: 2 });
    clock.now += SEND_DELAY_MS + 1000;
    await pass(rt, task.id, clock);
    const status = autopilotStatus(task.id);
    expect(status.reason).toBe("Auto-fix will send: test failing");
    expect(Date.parse(status.pendingFix!.sendsAt)).toBeGreaterThan(Date.parse(first));
    expect(existsSync(file)).toBe(false);
  });

  test("with every task slot taken, a round waits instead of being spent", async () => {
    const { task, file, adapters } = fixTask();
    const clock = { now: START + 10 * 60_000 };
    const { github } = fakeGitHub({ pr: redPr() });
    const rt = runtime(github, clock, adapters, { ...loadConfig(), maxConcurrentTasks: 0 });
    setAutopilot(task.id, { autoFix: true });
    seed(task.id, clock, { idleSince: longAgo, idleTurn: 1 });
    await pass(rt, task.id, clock);
    expect(autopilotStatus(task.id)).toMatchObject({ state: "waiting", reason: "Waiting for a free task slot", fixRounds: 0 });
    expect(existsSync(file)).toBe(false);
  });

  test("a round with no readable log waits for GitHub a few looks, then goes with links only", async () => {
    const { task, file, adapters } = fixTask();
    const clock = { now: START + 10 * 60_000 };
    const { state, github } = fakeGitHub({ pr: redPr() });
    state.logs = () => { throw new Error("HTTP 404: log not found"); };
    const rt = runtime(github, clock, adapters);
    setAutopilot(task.id, { autoFix: true });
    seed(task.id, clock, { idleSince: longAgo, idleTurn: 1 });
    await pass(rt, task.id, clock);
    expect(autopilotStatus(task.id).reason).toBe("Waiting for GitHub to serve the logs of test");
    await pass(rt, task.id, clock);
    expect(existsSync(file)).toBe(false);
    await pass(rt, task.id, clock);
    await until(() => existsSync(file), "the fix round");
    const evidence = readFileSync(readFileSync(file, "utf8").match(/Read (\S+PR-FEEDBACK\.md)/)![1]!, "utf8");
    expect(evidence).toContain("(could not read it: HTTP 404: log not found)");
    await until(() => getTask(task.id)?.state === "done", "the round to settle");
  });

  test("a pending round, and a Send now, belong to one piece of evidence", async () => {
    const { task, file, adapters } = fixTask();
    const clock = { now: START + 10 * 60_000 };
    const { state, github } = fakeGitHub({ pr: redPr() });
    const rt = runtime(github, clock, adapters);
    setAutopilot(task.id, { autoFix: true });
    seed(task.id, clock);
    await pass(rt, task.id, clock);
    sendPendingFix(task.id);
    // a new head before the next look: Send now was for the old evidence, so
    // the new one still waits out the delay (it runs from the task's idle moment)
    state.pr = redPr({ head: "a".repeat(40) });
    await pass(rt, task.id, clock);
    expect(autopilotStatus(task.id).pendingFix).not.toBeNull();
    expect(existsSync(file)).toBe(false);
    // and once CI is green there is nothing pending at all
    state.pr = snapshot({ head: "a".repeat(40) });
    await pass(rt, task.id, clock);
    expect(autopilotStatus(task.id)).toMatchObject({ pendingFix: null, reason: "Nothing to fix", by: "auto-fix" });
  });

  test("cancelling a queued round from the message list means Skip, not a pause", async () => {
    const task = doneTask();
    setAutopilot(task.id, { autoFix: true });
    writeAutopilotCheckpoint(autopilotRow(task.id)!, { pending: { key: "ci:x:test", summary: "test failing", sendsAt: new Date().toISOString() } }, new Date());
    const row = autopilotRow(task.id)!;
    const id = reserveRound(row, { key: "ci:x:test", prompt: "fix it", reason: "Sent", checkpoint: checkpointOf(row), turnCount: 0 }, new Date())!;
    const path = `/api/tasks/${task.id}/messages/${id}`;
    const response = await taskMessageRoute(new Request(`http://localhost${path}`, { method: "DELETE" }), path, "DELETE");
    expect(response?.status).toBe(200);
    expect(autopilotRow(task.id)!.state).toBe("active");
    expect(checkpointOf(autopilotRow(task.id)!).skipped).toContain("ci:x:test");
    // the countdown it came from is answered, not offered again
    expect(checkpointOf(autopilotRow(task.id)!).pending).toBeUndefined();
  });

  test("a slot taken while the logs are read makes the round wait, and the task is never failed", async () => {
    const { task, file, adapters } = fixTask();
    const other = doneTask();
    const clock = { now: START + 10 * 60_000 };
    const { state, github } = fakeGitHub({ pr: redPr() });
    state.logs = () => {
      db.run("INSERT INTO turns(task_id, n, prompt, status, log_file, started_at) VALUES (?, 1, 'x', 'running', '/dev/null', ?)", [other.id, new Date().toISOString()]);
      return "(fail) boom";
    };
    const rt = runtime(github, clock, adapters, { ...loadConfig(), maxConcurrentTasks: 1 });
    setAutopilot(task.id, { autoFix: true });
    seed(task.id, clock, { idleSince: longAgo, idleTurn: 1 });
    try {
      await pass(rt, task.id, clock);
      expect(autopilotStatus(task.id)).toMatchObject({ reason: "Waiting for a free task slot", fixRounds: 0 });
      expect(getTask(task.id)!.state).toBe("done");
      expect(existsSync(file)).toBe(false);
    } finally {
      db.run("DELETE FROM turns WHERE task_id = ?", [other.id]);
    }
  });

  test("an owner turn that runs while the logs are read wins, and the delay starts again after it", async () => {
    const { task, file, adapters } = fixTask();
    const clock = { now: START + 10 * 60_000 };
    const { state, github } = fakeGitHub({ pr: redPr() });
    state.logs = () => { setTaskFields(task.id, { turn_count: 2 }); return "(fail) boom"; };
    const rt = runtime(github, clock, adapters);
    setAutopilot(task.id, { autoFix: true });
    seed(task.id, clock, { idleSince: longAgo, idleTurn: 1 });
    await pass(rt, task.id, clock);
    expect(autopilotStatus(task.id).fixRounds).toBe(0);
    state.logs = null;
    await pass(rt, task.id, clock);
    expect(autopilotStatus(task.id)).toMatchObject({ reason: "Auto-fix will send: test failing", fixRounds: 0 });
    expect(existsSync(file)).toBe(false);
  });

  test("a look that runs out of time reading logs backs off instead of repeating at once", async () => {
    const { task, file, adapters } = fixTask();
    const clock = { now: START + 10 * 60_000 };
    const { state, github } = fakeGitHub({ pr: redPr() });
    state.logs = (_job, signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));
    const rt = runtime(github, clock, adapters, loadConfig(), 100);
    setAutopilot(task.id, { autoFix: true });
    seed(task.id, clock, { idleSince: longAgo, idleTurn: 1 });
    await pass(rt, task.id, clock);
    const row = autopilotRow(task.id)!;
    expect(row.reason).toBe("Check failed: reading the logs took too long");
    expect(row.failures).toBe(1);
    expect(Date.parse(row.next_check_at)).toBeGreaterThan(clock.now);
    expect(existsSync(file)).toBe(false);
  });

  test("a refused rerun says so and is not asked for again", async () => {
    const { task, file, adapters } = fixTask();
    const clock = { now: START + 10 * 60_000 };
    const { state, github } = fakeGitHub({ pr: snapshot({ checks: [{ ...RED, required: false }] }) });
    state.required = [];
    state.rerunOk = false;
    const rt = runtime(github, clock, adapters);
    setAutopilot(task.id, { autoFix: true });
    seed(task.id, clock, { idleSince: longAgo, idleTurn: 1 });
    await pass(rt, task.id, clock);
    expect(autopilotStatus(task.id).reason).toBe("Could not rerun test");
    await pass(rt, task.id, clock);
    await until(() => existsSync(file), "the fix round");
    expect(state.reruns).toEqual([5]);
    await until(() => getTask(task.id)?.state === "done", "the round to settle");
  });

  test("GitHub's own auto-merge pauses as auto-merge's, even when auto-fix spoke last", async () => {
    const { task, adapters } = fixTask();
    const clock = { now: START + 10 * 60_000 };
    const { state, github } = fakeGitHub({ pr: redPr({ checks: [{ ...RED, status: "IN_PROGRESS", conclusion: null }] }) });
    const rt = runtime(github, clock, adapters);
    setAutopilot(task.id, { autoMerge: true, autoFix: true });
    seed(task.id, clock, { idleSince: longAgo, idleTurn: 1 });
    await pass(rt, task.id, clock);
    expect(autopilotStatus(task.id)).toMatchObject({ reason: "Waiting for checks (1 running)", by: "auto-fix" });
    state.pr = { ...state.pr, providerAutoMerge: true };
    await pass(rt, task.id, clock);
    expect(autopilotStatus(task.id)).toMatchObject({ state: "paused", by: "auto-merge" });
    // so switching auto-fix off does not lift it
    expect(setAutopilot(task.id, { autoFix: false })).toMatchObject({ state: "paused" });
  });

  test("switching auto-fix off lifts the pause auto-fix made, and on again gives it a fresh budget", async () => {
    const { task, adapters } = fixTask();
    const clock = { now: START + 10 * 60_000 };
    const { github } = fakeGitHub({ pr: redPr() });
    const rt = runtime(github, clock, adapters);
    setAutopilot(task.id, { autoMerge: true, autoFix: true });
    seed(task.id, clock, { rounds: 3, idleSince: longAgo, idleTurn: 1, pending: { key: "k", summary: "test failing", sendsAt: longAgo } });
    await pass(rt, task.id, clock);
    expect(autopilotStatus(task.id)).toMatchObject({ state: "paused", by: "auto-fix" });
    expect(setAutopilot(task.id, { autoFix: false })).toMatchObject({ state: "waiting", autoMerge: true, by: "auto-merge", pendingFix: null });
    setAutopilot(task.id, { autoFix: true });
    expect(checkpointOf(autopilotRow(task.id)!).rounds).toBeUndefined();
  });
});
