import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { loadConfig } from "../src/config";
import { type PrSnapshot } from "../src/autopilot/github";
import { SEND_DELAY_MS } from "../src/autopilot/runtime";
import { autopilotRow, autopilotStatus, checkpointOf, reserveRound, resumeAutopilot, sendPendingFix, setAutopilot, skipPendingFix, withdrawQueuedRound, writeAutopilotCheckpoint } from "../src/autopilot/store";
import { taskMessageRoute } from "../src/routes/task-messages";
import { db, getTask, setTaskFields } from "../src/store";
import { pauseTaskWorkflows } from "../src/workflows/store";
import { HEAD, START, forgetTasks, doneTask, snapshot, fakeGitHub, runtime, seed, pass, until, capture, queue } from "./autopilot-harness";

afterEach(forgetTasks);

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
    // the round is Wisp's own words: delivered whole inside the input's one Wisp section
    expect(prompt.startsWith("<wisp>\n")).toBe(true);
    expect(prompt.split("\n")).toContain(`[Wisp auto-fix · PR #7 · round 1 of 5 · head ${HEAD.slice(0, 7)}]`);
    expect(prompt.trimEnd().endsWith("</wisp>")).toBe(true);
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

  test("after five rounds it gives up and pauses; Resume starts the budget again", async () => {
    const { task, adapters } = fixTask();
    const clock = { now: START + 10 * 60_000 };
    const { github } = fakeGitHub({ pr: redPr() });
    const rt = runtime(github, clock, adapters);
    setAutopilot(task.id, { autoFix: true });
    seed(task.id, clock, { rounds: 5, idleSince: longAgo, idleTurn: 1 });
    await pass(rt, task.id, clock);
    expect(autopilotStatus(task.id)).toMatchObject({ state: "paused", reason: "Auto-fix gave up after 5 rounds — resume to try again" });
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
    // it was done before a round came due: the round coming back does not make it done again
    writeAutopilotCheckpoint(autopilotRow(task.id)!, { done: true }, new Date());
    const row = autopilotRow(task.id)!;
    expect(reserveRound(row, { key: "ci:x:test", prompt: "fix it", reason: "Sent test failing (round 1 of 3)", checkpoint: { ...checkpointOf(row), rounds: 1 }, turnCount: 0 }, new Date())).not.toBeNull();
    expect(checkpointOf(autopilotRow(task.id)!).rounds).toBe(1);
    expect(withdrawQueuedRound(autopilotRow(task.id)!)).toBe(true);
    expect(checkpointOf(autopilotRow(task.id)!).rounds).toBeUndefined();
    expect(checkpointOf(autopilotRow(task.id)!).done).toBeUndefined();
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

  test("a rerun that fails outright is a refused rerun whose reason reaches the daemon log", async () => {
    const { task, adapters } = fixTask();
    const clock = { now: START + 10 * 60_000 };
    const { state, github } = fakeGitHub({ pr: snapshot({ checks: [{ ...RED, required: false }] }) });
    state.required = [];
    github.rerunRun = () => Promise.reject(new Error("gh: HTTP 403: Resource not accessible by integration"));
    const rt = runtime(github, clock, adapters);
    setAutopilot(task.id, { autoFix: true });
    seed(task.id, clock, { idleSince: longAgo, idleTurn: 1 });
    const logged = spyOn(console, "error").mockImplementation(() => {});
    try {
      await pass(rt, task.id, clock);
      expect(autopilotStatus(task.id).reason).toBe("Could not rerun test");
      expect(logged.mock.calls.map((call) => String(call[0]))).toContain(
        "[wisp] autopilot: could not rerun workflow run 5 of o/r: gh: HTTP 403: Resource not accessible by integration",
      );
    } finally {
      logged.mockRestore();
      await rt.stop();
    }
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
    seed(task.id, clock, { rounds: 5, idleSince: longAgo, idleTurn: 1, pending: { key: "k", summary: "test failing", sendsAt: longAgo } });
    await pass(rt, task.id, clock);
    expect(autopilotStatus(task.id)).toMatchObject({ state: "paused", by: "auto-fix" });
    expect(setAutopilot(task.id, { autoFix: false })).toMatchObject({ state: "waiting", autoMerge: true, by: "auto-merge", pendingFix: null });
    setAutopilot(task.id, { autoFix: true });
    expect(checkpointOf(autopilotRow(task.id)!).rounds).toBeUndefined();
  });
});
