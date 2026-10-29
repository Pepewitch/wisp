import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { AutopilotStatus } from "../../shared/autopilot";
import { autopilotHistory, autopilotRow, autopilotStatus, checkpointOf, paramsOf, setAutopilot, writeAutopilotCheckpoint } from "../src/autopilot/store";
import { prCommand } from "../src/cli-pr";
import { GitHubPausedError } from "../src/github-budget";
import { loadConfig, type WispConfig } from "../src/config";
import type { NewTaskInput } from "../src/domain/task-create";
import { autopilotRoute } from "../src/routes/autopilot";
import { createTask, db, freeSlot, getTask, messagesFor, newTaskId, setTaskFields, transition } from "../src/store";
import { submitVerdict } from "../src/verify/reviewer";
import { roundsOf } from "../src/verify/rounds";
import { reviewsOf } from "../src/verify/reviews";
import { HEAD, START, capture, created, doneTask, fakeGitHub, forgetTasks, pass, runtime, seed, snapshot, until } from "./autopilot-harness";

afterEach(forgetTasks);

const RUNNING = [{ name: "test", status: "IN_PROGRESS", conclusion: null, required: true, url: "" }];
const FAILED = [{ name: "test", status: "COMPLETED", conclusion: "FAILURE", required: true, url: "" }];
const GREEN = [{ name: "test", status: "COMPLETED", conclusion: "SUCCESS", required: true, url: "" }];

/** A launcher that makes the reviewer's task row the way createAndLaunchTask would, and starts nothing. */
function launcher(during?: { launch?: () => void }) {
  const launched: NewTaskInput[] = [];
  const launch = async (input: NewTaskInput) => {
    launched.push(input);
    during?.launch?.();
    const id = newTaskId();
    createTask({ id, title: input.prompt, repo_path: input.repoPath, harness: input.harness, model: input.model ?? null, verify_role: input.verifyRole ?? null, slot: freeSlot() });
    created.push(id);
    setTaskFields(id, { worktree_path: `/fixture/${id}`, branch: `wisp/${id}-review` });
    transition(id, "running");
    const task = getTask(id)!;
    input.prepare?.(task);
    return { task, autopilot: autopilotStatus(id) };
  };
  return { launched, launch };
}

function setup(options: { autoMerge?: boolean; autoFix?: boolean; harness?: string; worktree?: string; adapters?: Record<string, never>; checks?: typeof GREEN } = {}) {
  const clock = { now: START + 10 * 60_000 };
  const { state, github } = fakeGitHub({ pr: snapshot({ checks: options.checks ?? RUNNING }) });
  const during: { launch?: () => void } = {};
  const { launched, launch } = launcher(during);
  const task = doneTask(options.harness ? { harness: options.harness } : {});
  if (options.worktree) setTaskFields(task.id, { worktree_path: options.worktree, turn_count: 1 });
  setAutopilot(task.id, { autoMerge: options.autoMerge ?? true, autoFix: options.autoFix ?? false, autoReview: true });
  // as setAutopilot armed it, before seed replaced the checkpoint
  seed(task.id, clock, { reviewArmedAt: new Date(START).toISOString() });
  // Review now is for a project whose rounds wait for the checks; under "ready" they start on their own
  const cfg: WispConfig = { ...loadConfig(), repos: [{ path: "/fixture/repo", verifySecond: "off", reviewStart: "checks" }] };
  const rt = runtime(github, clock, options.adapters ?? {}, cfg, undefined, { launch });
  return { clock, state, github, launched, task, rt, cfg, during };
}

const call = (taskId: string, body?: unknown, method = "POST") => {
  const path = `/api/tasks/${taskId}/autopilot/review-now`;
  return autopilotRoute(new Request(`http://wisp.test${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), path);
};
async function reviewNow(taskId: string, body: unknown = {}): Promise<AutopilotStatus> {
  const response = await call(taskId, body);
  expect(response.status).toBe(200);
  return await response.json() as AutopilotStatus;
}
const latest = (taskId: string) => roundsOf(taskId)[0]!;
/** The checkpoint as a version from before reviewArmedAt left it. */
function forgetEpoch(taskId: string, clock: { now: number }) {
  const row = autopilotRow(taskId)!;
  const { reviewArmedAt: _armed, ...legacy } = checkpointOf(row);
  writeAutopilotCheckpoint(row, legacy, new Date(clock.now));
}
const primary = (taskId: string) => reviewsOf(latest(taskId).id).find((review) => review.role === "primary")!;
const short = HEAD.slice(0, 7);

describe("Review now", () => {
  test("starts a round while checks are running, and says it was the person's", async () => {
    const { clock, launched, task, rt } = setup();
    await pass(rt, task.id, clock);
    expect(launched).toHaveLength(0);
    expect(autopilotStatus(task.id)).toMatchObject({ reason: "Waiting for checks (1 running) before auto-review", reviewNow: { head: HEAD, requested: false } });
    expect(await reviewNow(task.id, { head: HEAD })).toMatchObject({ reviewNow: { head: HEAD, requested: true } });
    await pass(rt, task.id, clock);
    expect(launched).toHaveLength(1);
    expect(launched[0]!.base).toMatchObject({ commit: HEAD });
    expect(autopilotStatus(task.id)).toMatchObject({ state: "waiting", by: "auto-review", reviewRounds: 1, reviewNow: null });
    expect(autopilotStatus(task.id).reason).toBe("Auto-review round 1 · 0 of 3 rejections used (started by you, checks still running): A reviewing");
    expect(latest(task.id)).toMatchObject({ round: 1, counted: 1, head: HEAD, state: "running" });
    expect(autopilotHistory(task.id).some((entry) => entry.detail.startsWith("Round 1 started") && entry.detail.includes("by Review now (started by you, checks still running)"))).toBe(true);
    // the click is spent: later looks drive the round, and no second one starts
    await pass(rt, task.id, clock);
    expect(launched).toHaveLength(1);
    expect(latest(task.id).early).toBe(1);
    expect(checkpointOf(autopilotRow(task.id)!).reviewNow).toBeUndefined();
  });

  test("starts a round despite a failed check", async () => {
    const { clock, launched, task, rt } = setup({ checks: FAILED });
    await pass(rt, task.id, clock);
    expect(autopilotStatus(task.id)).toMatchObject({ state: "needs-you", reason: "test failed", reviewNow: { head: HEAD, requested: false } });
    await reviewNow(task.id);
    await pass(rt, task.id, clock);
    expect(launched).toHaveLength(1);
    expect(autopilotStatus(task.id).reason).toBe("Auto-review round 1 · 0 of 3 rejections used (started by you, test failed): A reviewing");
  });

  test("starts a round despite an auto-fix countdown, which then waits for the round, and sends once it passes", async () => {
    const { dir, file, adapters } = capture();
    const { clock, launched, task, rt } = setup({ autoFix: true, checks: FAILED, harness: "capture", worktree: dir, adapters: adapters as never });
    await pass(rt, task.id, clock);
    const counting = autopilotStatus(task.id);
    expect(counting.by).toBe("auto-fix");
    expect(counting.pendingFix).not.toBeNull();
    expect(counting.reviewNow).toEqual({ head: HEAD, requested: false });
    await reviewNow(task.id);
    await pass(rt, task.id, clock);
    expect(launched).toHaveLength(1);
    const reviewing = autopilotStatus(task.id);
    expect(reviewing).toMatchObject({ by: "auto-review", reviewRounds: 1, reviewNow: null });
    expect(reviewing.reason).toContain("(started by you, test failed)");
    // a push would end the round: auto-fix holds its round until the review settles
    expect(reviewing.reason).toContain(" · Auto-fix will send after the review: test failing");
    expect(reviewing.pendingFix).toMatchObject({ summary: counting.pendingFix!.summary, afterReview: true });
    clock.now = Date.parse(counting.pendingFix!.sendsAt) + 1000;
    await pass(rt, task.id, clock);
    expect(messagesFor(task.id).some((message) => message.origin === "workflow")).toBe(false);
    submitVerdict(primary(task.id).reviewer_task_id!, { token: primary(task.id).token, verdict: "pass", summary: "Checked it" } as never);
    transition(primary(task.id).reviewer_task_id!, "done");
    await pass(rt, task.id, clock);
    expect(messagesFor(task.id).some((message) => message.origin === "workflow")).toBe(true);
    await until(() => getTask(task.id)!.state === "done" && Bun.file(file).size > 0, "the auto-fix round's turn");
  });

  test("a push between the click and the look cancels it", async () => {
    const { clock, state, launched, task, rt } = setup();
    await pass(rt, task.id, clock);
    await reviewNow(task.id);
    const next = "d".repeat(40);
    state.pr = snapshot({ head: next, checks: RUNNING });
    await pass(rt, task.id, clock);
    expect(launched).toHaveLength(0);
    expect(checkpointOf(autopilotRow(task.id)!).reviewNow).toBeUndefined();
    expect(autopilotStatus(task.id)).toMatchObject({ reason: "Waiting for checks (1 running) before auto-review", reviewNow: { head: next, requested: false } });
    // a click on the head the person saw before the push is refused, not moved onto the new one
    const stale = await call(task.id, { head: HEAD });
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { error: string }).error).toContain(`newer head (${next.slice(0, 7)})`);
  });

  test("a GitHub pause in auto-fix after its round launched keeps the round counted and early", async () => {
    const RERUNNABLE = [{ ...FAILED[0]!, conclusion: "CANCELLED", checkRunId: 11, run: { id: 5, event: "pull_request" }, deployment: false }];
    const { clock, state, github, launched, task, rt } = setup({ autoFix: true });
    await pass(rt, task.id, clock);
    await reviewNow(task.id);
    state.pr = snapshot({ checks: RERUNNABLE });
    let reruns = 0;
    github.rerunRun = async () => { reruns++; throw new GitHubPausedError(clock.now + 60_000, "share"); };
    await pass(rt, task.id, clock);
    expect(launched).toHaveLength(1);
    expect(reruns).toBe(1);
    expect(autopilotStatus(task.id).reason).toContain("Paused");
    // the round row carries what the lost checkpoint would have: it is counted, and it waits for no check
    expect(roundsOf(task.id).filter((round) => round.counted)).toHaveLength(1);
    expect(latest(task.id)).toMatchObject({ round: 1, counted: 1, early: 1, state: "running" });
    // the next look drives that round past the red check, and a pass is settled, not stuck behind CI
    github.rerunRun = async () => true;
    clock.now += 2 * 60_000;
    submitVerdict(primary(task.id).reviewer_task_id!, { token: primary(task.id).token, verdict: "pass", summary: "Checked it" } as never);
    transition(primary(task.id).reviewer_task_id!, "done");
    await pass(rt, task.id, clock);
    expect(launched).toHaveLength(1);
    expect(latest(task.id).state).toBe("pass");
    expect(autopilotStatus(task.id)).toMatchObject({ reviewRounds: 1, reviewNow: null });
  });

  test.each(["armed", "upgraded"])("GitHub pauses in auto-fix, one launching the round and one settling it, leave the round counted (%s)", async (profile) => {
    const RERUNNABLE = [{ ...FAILED[0]!, conclusion: "CANCELLED", checkRunId: 11, run: { id: 5, event: "pull_request" }, deployment: false }];
    const { clock, state, github, launched, task, rt } = setup({ autoFix: true });
    // upgraded: a checkpoint from before the epoch; auto-fix answers the first look before auto-review stores one
    if (profile === "upgraded") forgetEpoch(task.id, clock);
    await pass(rt, task.id, clock);
    if (profile === "upgraded") expect(checkpointOf(autopilotRow(task.id)!)).not.toHaveProperty("reviewArmedAt");
    await reviewNow(task.id);
    // the click stores the epoch the round it starts is counted from
    expect(checkpointOf(autopilotRow(task.id)!).reviewArmedAt).toBeString();
    state.pr = snapshot({ checks: RERUNNABLE });
    github.rerunRun = async () => { throw new GitHubPausedError(clock.now + 60_000, "share"); };
    await pass(rt, task.id, clock);
    expect(launched).toHaveLength(1);
    expect(latest(task.id)).toMatchObject({ round: 1, counted: 1, state: "running" });
    // the reviewer passes before the next look, and that look throws too: the round settles, the checkpoint is lost again
    clock.now += 2 * 60_000;
    submitVerdict(primary(task.id).reviewer_task_id!, { token: primary(task.id).token, verdict: "pass", summary: "Checked it" } as never);
    transition(primary(task.id).reviewer_task_id!, "done");
    await pass(rt, task.id, clock);
    expect(latest(task.id).state).toBe("pass");
    expect(checkpointOf(autopilotRow(task.id)!).reviewRounds).toBeUndefined();
    // the next head is round 2, not a second round 1
    github.rerunRun = async () => true;
    clock.now += 2 * 60_000;
    const next = "d".repeat(40);
    state.pr = snapshot({ head: next, checks: GREEN });
    await pass(rt, task.id, clock);
    // a new head waits a moment for its checks to start
    clock.now += 10 * 60_000;
    await pass(rt, task.id, clock);
    expect(launched).toHaveLength(2);
    expect(latest(task.id)).toMatchObject({ head: next, round: 2, counted: 1 });
    expect(autopilotStatus(task.id).reviewRounds).toBe(2);
  });

  test("a round on the old base does not refuse Review now after a retarget", async () => {
    const { clock, state, launched, task, rt } = setup();
    await pass(rt, task.id, clock);
    await reviewNow(task.id);
    await pass(rt, task.id, clock);
    submitVerdict(primary(task.id).reviewer_task_id!, { token: primary(task.id).token, verdict: "pass", summary: "Checked it" } as never);
    transition(primary(task.id).reviewer_task_id!, "done");
    await pass(rt, task.id, clock);
    expect(latest(task.id)).toMatchObject({ base: "main", state: "pass" });
    state.pr = snapshot({ baseRefName: "release", checks: RUNNING });
    await pass(rt, task.id, clock);
    // offered on the new base, and the click the offer invites is taken
    expect(autopilotStatus(task.id).reviewNow).toEqual({ head: HEAD, requested: false });
    expect(await reviewNow(task.id, { head: HEAD })).toMatchObject({ reviewNow: { head: HEAD, requested: true } });
    await pass(rt, task.id, clock);
    expect(launched).toHaveLength(2);
    expect(latest(task.id)).toMatchObject({ base: "release", head: HEAD, round: 2, early: 1 });
  });

test("rounds from before an upgraded profile's switch reset do not spend its fresh budget", async () => {
    // a schema-28 checkpoint: auto-review was switched off and on, which deleted the count, and the old rounds stayed
    const { clock, launched, task, rt } = setup({ checks: GREEN });
    const old = "e".repeat(40);
    forgetEpoch(task.id, clock);
    const workflow = autopilotRow(task.id)!.id;
    for (const number of [1, 2, 3]) {
      db.run(`INSERT INTO auto_review_rounds (id, task_id, workflow_id, pr, head, base, round, token, state, created_at)
        VALUES (?, ?, ?, 7, ?, 'main', ?, ?, 'fail', ?)`, [`rold${number}`, task.id, workflow, old, number, `tok${number}`, new Date(START + number * 1000).toISOString()]);
    }
    expect(checkpointOf(autopilotRow(task.id)!)).not.toHaveProperty("reviewRounds");
    expect(checkpointOf(autopilotRow(task.id)!)).not.toHaveProperty("reviewArmedAt");
    await pass(rt, task.id, clock);
    expect(launched).toHaveLength(1);
    // numbering goes on past every round the PR has had; the budget counts only rounds since the epoch
    expect(latest(task.id)).toMatchObject({ head: HEAD, round: 4, counted: 1, state: "running" });
    expect(autopilotStatus(task.id)).toMatchObject({ state: "waiting", reviewRounds: 4, reviewSpent: 0 });
    expect(autopilotStatus(task.id).reason).toBe("Auto-review round 4 · 0 of 3 rejections used: A reviewing");
    // the epoch the first look set holds: the next look still spends 0, not the old 3
    await pass(rt, task.id, clock);
    expect(launched).toHaveLength(1);
    expect(autopilotStatus(task.id)).toMatchObject({ state: "waiting", reviewRounds: 4, reviewSpent: 0 });
  });
  test("a switch moved while its reviewers launch does not leave its round behind the checks", async () => {
    const { clock, launched, task, rt, during } = setup();
    await pass(rt, task.id, clock);
    await reviewNow(task.id);
    // the person turns auto-merge off mid-launch: the revision moves, and this look's checkpoint is not saved
    during.launch = () => { setAutopilot(task.id, { autoMerge: false }, new Date(clock.now)); };
    await pass(rt, task.id, clock);
    during.launch = undefined;
    expect(launched).toHaveLength(1);
    // the window the round row covers: this look's checkpoint (the count, the spent click) was refused
    expect(checkpointOf(autopilotRow(task.id)!)).toMatchObject({ reviewNow: HEAD });
    expect(checkpointOf(autopilotRow(task.id)!).reviewRounds).toBeUndefined();
    expect(latest(task.id)).toMatchObject({ round: 1, counted: 1, early: 1, state: "running" });
    submitVerdict(primary(task.id).reviewer_task_id!, { token: primary(task.id).token, verdict: "pass", summary: "Checked it" } as never);
    transition(primary(task.id).reviewer_task_id!, "done");
    await pass(rt, task.id, clock);
    expect(latest(task.id).state).toBe("pass");
    expect(launched).toHaveLength(1);
    expect(autopilotStatus(task.id)).toMatchObject({ state: "waiting", by: "auto-review", reason: "Auto-review passed ccccccc", reviewRounds: 1, reviewNow: null });
    expect(paramsOf(autopilotRow(task.id)!)).toMatchObject({ autoMerge: false, autoReview: true });
  });

  test("with no free slot it waits, then starts on the same head", async () => {
    const { clock, launched, task, rt, cfg } = setup();
    await pass(rt, task.id, clock);
    await reviewNow(task.id);
    cfg.maxConcurrentTasks = 0;
    await pass(rt, task.id, clock);
    expect(launched).toHaveLength(0);
    expect(autopilotStatus(task.id)).toMatchObject({ reason: "Waiting for a free task slot to start the reviewers", reviewNow: { head: HEAD, requested: true } });
    cfg.maxConcurrentTasks = 100;
    await pass(rt, task.id, clock);
    expect(launched).toHaveLength(1);
    expect(latest(task.id)).toMatchObject({ head: HEAD, round: 1 });
  });

  test("an early pass never lets auto-merge skip the required checks", async () => {
    const { clock, state, task, rt } = setup();
    await pass(rt, task.id, clock);
    await reviewNow(task.id);
    await pass(rt, task.id, clock);
    submitVerdict(primary(task.id).reviewer_task_id!, { token: primary(task.id).token, verdict: "pass", summary: "Checked it" } as never);
    transition(primary(task.id).reviewer_task_id!, "done");
    await pass(rt, task.id, clock);
    expect(latest(task.id).state).toBe("pass");
    expect(state.merges).toHaveLength(0);
    expect(autopilotStatus(task.id)).toMatchObject({ state: "waiting", by: "auto-merge", reason: "Waiting for checks (1 running)" });
    state.pr = snapshot({ checks: FAILED });
    await pass(rt, task.id, clock);
    expect(state.merges).toHaveLength(0);
    expect(autopilotStatus(task.id)).toMatchObject({ state: "needs-you", reason: "test failed" });
    state.pr = snapshot({ checks: GREEN });
    await pass(rt, task.id, clock);
    expect(state.merges).toEqual([{ number: 7, method: "SQUASH", head: HEAD }]);
  });

  test("its round answers to the budget: with the rejections spent, it pauses instead", async () => {
    const { clock, launched, task, rt } = setup();
    await pass(rt, task.id, clock);
    await reviewNow(task.id);
    const workflow = autopilotRow(task.id)!.id;
    for (const number of [1, 2, 3]) {
      db.run(`INSERT INTO auto_review_rounds (id, task_id, workflow_id, pr, head, base, round, token, state, created_at)
        VALUES (?, ?, ?, 7, ?, 'main', ?, ?, 'fail', ?)`, [`rspent${number}`, task.id, workflow, String(number).repeat(40), number, `tok${number}`, new Date(clock.now - 1000 + number).toISOString()]);
    }
    await pass(rt, task.id, clock);
    expect(launched).toHaveLength(0);
    expect(autopilotStatus(task.id)).toMatchObject({ state: "paused", reason: "Auto-review did not pass after 3 rounds — resume to try again" });
    expect(checkpointOf(autopilotRow(task.id)!).reviewNow).toBeUndefined();
  });

  test("is offered only while auto-review is held on a head with no round", async () => {
    const { clock, state, task, rt } = setup({ checks: GREEN });
    // green and no countdown: the round starts on its own, nothing to offer
    await pass(rt, task.id, clock);
    expect(autopilotStatus(task.id).reviewNow).toBeNull();
    // a round on this head: Resume is the way to ask again
    state.pr = snapshot({ checks: RUNNING });
    await pass(rt, task.id, clock);
    expect(autopilotStatus(task.id).reviewNow).toBeNull();
    const refused = await call(task.id);
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toBe(`Auto-review already has a round on ${short} — Resume reviews it again`);
    // an auto-fix countdown ahead of a green head offers it too
    const row = autopilotRow(task.id)!;
    const sendsAt = new Date(clock.now + 60_000).toISOString();
    writeAutopilotCheckpoint(row, { ...checkpointOf(row), reviewOpen: { head: HEAD, base: "main", checks: false }, pending: { key: "k", summary: "a review", sendsAt } }, new Date(clock.now));
    db.run("UPDATE workflows SET params_json = json_set(params_json, '$.autoFix', json('true')) WHERE id = ?", [row.id]);
    expect(autopilotStatus(task.id).reviewNow).toEqual({ head: HEAD, requested: false });
    writeAutopilotCheckpoint(autopilotRow(task.id)!, { ...checkpointOf(autopilotRow(task.id)!), pending: undefined }, new Date(clock.now));
    expect(autopilotStatus(task.id).reviewNow).toBeNull();
  });

  test("a draft is not offered it, and is refused", async () => {
    const { clock, state, launched, task, rt } = setup();
    state.pr = snapshot({ isDraft: true, checks: RUNNING });
    await pass(rt, task.id, clock);
    expect(autopilotStatus(task.id)).toMatchObject({ state: "needs-you", reviewNow: null });
    const refused = await call(task.id);
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toBe("PR #7 is a draft — auto-review starts once it is ready for review");
    expect(launched).toHaveLength(0);
  });
});

describe("the review-now route and CLI", () => {
  test("refuses what it cannot do, by name, and audits what it does", async () => {
    const task = doneTask();
    expect((await call(task.id)).status).toBe(409);
    setAutopilot(task.id, { autoMerge: true });
    expect(((await (await call(task.id)).json()) as { error: string }).error).toBe("Auto-review is not on for this task");
    setAutopilot(task.id, { autoReview: true });
    expect(((await (await call(task.id)).json()) as { error: string }).error).toBe("Auto-review has no pull request head to review yet");
    seed(task.id, { now: START });
    expect((await call(task.id, { head: "nope" })).status).toBe(400);
    expect((await call(task.id, { sha: HEAD })).status).toBe(400);
    expect((await call(task.id, undefined, "GET")).status).toBe(405);
    expect((await call("tnope1")).status).toBe(404);
    expect(await reviewNow(task.id)).toMatchObject({ reviewNow: { head: HEAD, requested: true } });
    // asked twice: still the one click
    expect(await reviewNow(task.id, { head: HEAD })).toMatchObject({ reviewNow: { head: HEAD, requested: true } });
    expect(autopilotHistory(task.id).filter((entry) => entry.detail.startsWith("Review now:"))).toHaveLength(1);
    const audit = db.query("SELECT action, detail FROM task_audit WHERE task_id = ? AND action = 'autopilot-review-now'").all(task.id) as { action: string; detail: string }[];
    expect(audit).toEqual([{ action: "autopilot-review-now", detail: short }]);
    db.run("UPDATE workflows SET state = 'paused' WHERE id = ?", [autopilotRow(task.id)!.id]);
    expect(((await (await call(task.id)).json()) as { error: string }).error).toBe("Autopilot is paused — resume it first");
  });

  test("wisp pr <task> review now posts the action and says it was asked for", async () => {
    const calls: unknown[] = [];
    const api = async (...args: unknown[]) => {
      calls.push(args);
      return { autoMerge: false, autoFix: false, autoReview: true, pr: 7, state: "waiting", reason: "Waiting for checks (1 running) before auto-review", about: "pr", by: "auto-review",
        mergedByWisp: false, lastMerged: null, pendingFix: null, fixRounds: 0, done: false, updatedAt: null, reviewNow: { head: HEAD, requested: true } };
    };
    const printed: string[] = [];
    const log = spyOn(console, "log").mockImplementation((line: unknown) => { printed.push(String(line)); });
    try {
      await prCommand(["tabcde", "review", "now"], {}, api);
    } finally { log.mockRestore(); }
    expect(calls).toEqual([["/api/tasks/tabcde/autopilot/review-now", "POST", {}]]);
    expect(printed.join("\n")).toBe(`auto-review: on · PR #7 · waiting · Waiting for checks (1 running) before auto-review · review now asked for (${short})`);
    await expect(prCommand(["tabcde", "review", "later"], {}, api)).rejects.toThrow("usage");
  });
});
