import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { autopilotHistory, autopilotRow, autopilotStatus, autopilotTurnNotes, checkpointOf, resumeAutopilot, setAutopilot } from "../src/autopilot/store";
import type { NewTaskInput } from "../src/domain/task-create";
import { autoReviewRoute } from "../src/routes/auto-review";
import { createTask, db, freeSlot, getTask, newTaskId, setTaskFields, transition } from "../src/store";
import { activateDraft, saveDraft } from "../src/verify/recipe";
import { submitVerdict } from "../src/verify/reviewer";
import { getRound, roundOfReviewer, roundsOf, type RoundRow } from "../src/verify/rounds";
import { reviewTurnEnv, reviewsOf, type ReviewRow } from "../src/verify/reviews";
import { loadConfig } from "../src/config";
import { verifyTaskOf } from "../src/verify/status";
import { HEAD, START, capture, created, doneTask, fakeGitHub, forgetTasks, pass, runtime, seed, snapshot, until } from "./autopilot-harness";

afterEach(forgetTasks);

/** A launcher that makes the task row the way createAndLaunchTask would, and starts nothing. */
function launcher() {
  const launched: NewTaskInput[] = [];
  const ids: string[] = [];
  const launch = async (input: NewTaskInput) => {
    launched.push(input);
    const id = newTaskId();
    ids.push(id);
    createTask({ id, title: input.prompt, repo_path: input.repoPath, harness: input.harness, model: input.model ?? null, verify_role: input.verifyRole ?? null, slot: freeSlot() });
    created.push(id);
    setTaskFields(id, { worktree_path: `/fixture/${id}`, branch: `wisp/${id}-review` });
    transition(id, "running");
    const task = getTask(id)!;
    input.prepare?.(task);
    return { task, autopilot: autopilotStatus(id) };
  };
  return { launched, launch, ids };
}

function armed(options: { autoMerge?: boolean; autoFix?: boolean; repo?: string; harness?: string; worktree?: string } = {}) {
  const task = doneTask({ ...(options.repo ? { repo_path: options.repo } : {}), ...(options.harness ? { harness: options.harness } : {}) });
  if (options.worktree) setTaskFields(task.id, { worktree_path: options.worktree, turn_count: 1 });
  setAutopilot(task.id, { autoMerge: options.autoMerge ?? true, autoFix: options.autoFix ?? false, autoReview: true });
  return task;
}

/**
 * The project's config: one reviewer unless `panel` (the second reviewer then
 * defaults to the first's agent; a fixture repo's diff cannot be read, so its
 * rounds are deep and get both).
 */
function cfgFor(repo: string, panel: boolean) {
  return { ...loadConfig(), repos: [{ path: repo, ...(panel ? {} : { verifySecond: "off" as const }) }] };
}

function setup(options: Parameters<typeof armed>[0] & { adapters?: Record<string, never>; panel?: boolean; realClock?: boolean } = {}) {
  // a recipe activation is stamped with the real time: a test that activates one runs on it too
  const clock = { now: options.realClock ? Date.now() : START + 10 * 60_000 };
  const { state, github } = fakeGitHub();
  const { launched, launch, ids } = launcher();
  const task = armed(options);
  seed(task.id, clock);
  const rt = runtime(github, clock, options.adapters ?? {}, cfgFor(options.repo ?? "/fixture/repo", options.panel === true), undefined, { launch });
  return { clock, state, launched, ids, task, rt };
}

const primaryOf = (round: RoundRow): ReviewRow => reviewsOf(round.id).find((review) => review.role === "primary")!;
const reviewerOf = (round: RoundRow) => getTask(primaryOf(round).reviewer_task_id!)!;
const latest = (taskId: string) => roundsOf(taskId)[0]!;

/** A verdict in the panel's shape: a rejection's findings block and name a file unless the test says otherwise. */
function shaped(body: Record<string, unknown>): Record<string, unknown> {
  const findings = (body.findings as Record<string, unknown>[] | undefined)?.map((finding) => ({
    severity: body.verdict === "fail" ? "blocking" : "note", lens: "correctness", detail: "Seen broken", file: "src/app.ts", ...finding,
  }));
  return { summary: "Checked it", ...body, ...(findings ? { findings } : {}) };
}

function submitFor(review: ReviewRow, body: Record<string, unknown>) {
  return submitVerdict(review.reviewer_task_id!, { token: review.token, ...shaped(body) } as never);
}

/** The primary reviewer's verdict (the only reviewer unless the round has a panel). */
function verdict(round: RoundRow, body: Record<string, unknown>) {
  return submitFor(primaryOf(round), body);
}

describe("auto-review", () => {
  test("a green head gets a reviewer in its own worktree at that head, and nothing merges before its pass", async () => {
    const { clock, state, launched, task, rt } = setup();
    await pass(rt, task.id, clock);
    expect(launched).toHaveLength(1);
    expect(launched[0]!).toMatchObject({ base: HEAD, mode: "worktree", verifyRole: "reviewer", repoPath: task.repo_path, actor: "autopilot" });
    expect(launched[0]!.firstTurnPrompt).toContain("Round 1 of 3");
    expect(launched[0]!.firstTurnPrompt).toContain("review submit --stdin");
    expect(autopilotStatus(task.id)).toMatchObject({ autoReview: true, state: "waiting", by: "auto-review", reviewRounds: 1 });
    expect(autopilotStatus(task.id).reason).toBe("Auto-review round 1 of 3: A reviewing");
    expect(state.merges).toHaveLength(0);

    // still running: no second reviewer
    await pass(rt, task.id, clock);
    expect(launched).toHaveLength(1);

    const round = latest(task.id);
    verdict(round, { verdict: "pass" });
    transition(reviewerOf(round).id, "done");
    await pass(rt, task.id, clock);
    expect(state.merges).toEqual([{ number: 7, method: "SQUASH", head: HEAD }]);
    expect(autopilotHistory(task.id).find((entry) => entry.kind === "merging")?.detail).toContain("auto-review passed (round 1)");
  });

  test("checks still running or red spend no reviewer", async () => {
    const { clock, state, launched, task, rt } = setup();
    state.pr = snapshot({ checks: [{ name: "test", status: "IN_PROGRESS", conclusion: null, required: true, url: "" }] });
    await pass(rt, task.id, clock);
    expect(launched).toHaveLength(0);
    expect(autopilotStatus(task.id).reason).toBe("Waiting for checks (1 running) before auto-review");
    state.pr = snapshot({ checks: [{ name: "test", status: "COMPLETED", conclusion: "FAILURE", required: true, url: "" }] });
    await pass(rt, task.id, clock);
    expect(launched).toHaveLength(0);
    expect(autopilotStatus(task.id)).toMatchObject({ state: "needs-you", reason: "test failed" });
  });

  test("without auto-fix, a rejection needs you and names the reviewer's summary", async () => {
    const { clock, task, rt } = setup();
    await pass(rt, task.id, clock);
    const round = latest(task.id);
    verdict(round, { verdict: "fail", summary: "The save button does nothing", findings: [{ title: "Save is dead" }] });
    await pass(rt, task.id, clock);
    expect(autopilotStatus(task.id)).toMatchObject({ state: "needs-you", by: "auto-review" });
    // the headline is the first blocking finding
    expect(autopilotStatus(task.id).reason).toBe(`Auto-review rejected ${HEAD.slice(0, 7)}: Save is dead`);
  });

  test("with auto-fix, a rejection goes back to the author once, with the findings beside its data", async () => {
    const { dir, file, adapters } = capture();
    const { clock, task, rt } = setup({ autoFix: true, harness: "capture", worktree: dir, adapters: adapters as never });
    await pass(rt, task.id, clock);
    const round = latest(task.id);
    verdict(round, { verdict: "fail", summary: "Dark mode is unreadable", findings: [{ title: "White on white", detail: "Opened settings in dark mode", file: "web/theme.css", line: 12 }] });
    await pass(rt, task.id, clock);
    await until(() => existsSync(file), "the author's round turn");
    const prompt = readFileSync(file, "utf8");
    expect(prompt).toContain(`[Wisp auto-review · PR #7 · round 1 of 3 · head ${HEAD.slice(0, 7)}]`);
    const feedback = prompt.match(/Read (\S+REVIEW-FEEDBACK\.md)/)![1]!;
    expect(feedback.startsWith(dir)).toBe(false);
    expect(readFileSync(feedback, "utf8")).toContain("White on white");
    expect(readFileSync(feedback, "utf8")).toContain("web/theme.css:12");
    await until(() => getTask(task.id)!.state === "done", "the round turn to finish");

    // the same head again: no second round of the same findings
    await pass(rt, task.id, clock);
    expect(autopilotStatus(task.id)).toMatchObject({ state: "needs-you" });
    expect(autopilotStatus(task.id).reason).toBe("Still rejected after review round 1, with no new push");
  });

  test("a new head ends the running reviewer and gets a fresh round", async () => {
    const { clock, state, launched, task, rt } = setup();
    await pass(rt, task.id, clock);
    const first = latest(task.id);
    const next = "d".repeat(40);
    state.pr = snapshot({ head: next });
    clock.now += 5 * 60_000;
    await pass(rt, task.id, clock);
    expect(getRound(first.id)!.state).toBe("superseded");
    // a fresh head waits out the fresh-head floor first
    clock.now += 3 * 60_000;
    await pass(rt, task.id, clock);
    expect(launched).toHaveLength(2);
    expect(launched[1]!.base).toBe(next);
    expect(latest(task.id)).toMatchObject({ round: 2, head: next, state: "running" });
  });

  test("three counted rounds, then it pauses; resume gives three more", async () => {
    const { clock, state, launched, task, rt } = setup();
    for (let n = 1; n <= 3; n++) {
      state.pr = snapshot({ head: String(n).repeat(40) });
      clock.now += 5 * 60_000;
      await pass(rt, task.id, clock);
      clock.now += 3 * 60_000;
      await pass(rt, task.id, clock);
      const round = latest(task.id);
      expect(round.round).toBe(n);
      verdict(round, { verdict: "fail", findings: [{ title: `bug ${n}` }] });
    }
    state.pr = snapshot({ head: "4".repeat(40) });
    clock.now += 5 * 60_000;
    await pass(rt, task.id, clock);
    clock.now += 3 * 60_000;
    await pass(rt, task.id, clock);
    expect(launched).toHaveLength(3);
    expect(autopilotStatus(task.id)).toMatchObject({ state: "paused", reason: "Auto-review did not pass after 3 rounds — resume to try again" });
    resumeAutopilot(task.id, new Date(clock.now));
    await pass(rt, task.id, clock);
    expect(launched).toHaveLength(4);
    // numbering goes on, and the budget is three more
    expect(latest(task.id)).toMatchObject({ round: 4, counted: 1 });
    expect(launched[3]!.firstTurnPrompt).toContain("Round 4 of 6");
    expect(autopilotStatus(task.id).reason).toBe("Auto-review round 4 of 6: A reviewing");
  });

  test("Resume has a rejected head looked at again, without a push and without spending a round", async () => {
    const { clock, launched, task, rt } = setup();
    await pass(rt, task.id, clock);
    verdict(latest(task.id), { verdict: "fail", findings: [{ title: "flaky" }] });
    await pass(rt, task.id, clock);
    expect(autopilotStatus(task.id)).toMatchObject({ state: "needs-you", by: "auto-review" });
    resumeAutopilot(task.id, new Date(clock.now));
    await pass(rt, task.id, clock);
    expect(launched).toHaveLength(2);
    expect(latest(task.id)).toMatchObject({ round: 1, counted: 0, state: "running" });
  });

  test("Continue after a Stop hold, or a row without auto-review, arms no re-review", () => {
    const task = doneTask();
    setAutopilot(task.id, { autoMerge: true });
    resumeAutopilot(task.id);
    expect(checkpointOf(autopilotRow(task.id)!).reviewRetry).toBeUndefined();
    setAutopilot(task.id, { autoReview: true });
    db.run("UPDATE workflows SET checkpoint_json = json_set(checkpoint_json, '$.stopHold', json('{\"turnCount\":1}'), '$.state', 'held') WHERE task_id = ?", [task.id]);
    resumeAutopilot(task.id);
    expect(checkpointOf(autopilotRow(task.id)!).reviewRetry).toBeUndefined();
  });

  test("a reviewer that cannot start yet stays pending on its round, and starts when a slot frees", async () => {
    const clock = { now: START + 10 * 60_000 };
    const { github } = fakeGitHub();
    const { launched, launch } = launcher();
    let refuse = false;
    const gated = async (input: NewTaskInput) => refuse
      ? { kind: "at-capacity" as const, error: "all task slots are busy" }
      : launch(input);
    const task = armed();
    seed(task.id, clock);
    const rt = runtime(github, clock, {}, cfgFor("/fixture/repo", false), undefined, { launch: gated });
    await pass(rt, task.id, clock);
    verdict(latest(task.id), { verdict: "fail", findings: [{ title: "flaky" }] });
    await pass(rt, task.id, clock);
    resumeAutopilot(task.id, new Date(clock.now));
    refuse = true;
    await pass(rt, task.id, clock);
    // the round exists with its reviewer pending: it starts when a slot frees, the panel never shrinks
    expect(autopilotStatus(task.id).reason).toBe("Auto-review round 1 of 3: A waiting for a free task slot");
    expect(primaryOf(latest(task.id)).state).toBe("pending");
    refuse = false;
    await pass(rt, task.id, clock);
    expect(launched).toHaveLength(2);
    expect(primaryOf(latest(task.id)).state).toBe("running");
  });

  test("a recipe the reviewer could not follow holds the PR, spends no round, and is fixed before a re-run", async () => {
    const repo = mkdtempSync(join(tmpdir(), "wisp-review-repo-"));
    // an active recipe whose web area the reviewer will find broken
    saveDraft(repo, "tfirst", [{ path: "RECIPE.md", content: "# r" }, { path: "areas/web/AREA.md", content: "---\npaths: web/**\nstatus: proven\n---" }]);
    await activateDraft(repo, "test");
    const { clock, launched, ids, task, rt } = setup({ repo, realClock: true });
    await pass(rt, task.id, clock);
    const round = latest(task.id);
    verdict(round, { verdict: "inconclusive", cause: "recipe", recipeFeedback: "the dev server needs PORT", recipeArea: "web" });
    await pass(rt, task.id, clock);
    expect(launched).toHaveLength(2);
    expect(launched[1]!).toMatchObject({ verifyRole: "recipe", repoPath: repo, prompt: expect.stringContaining("Fix verification (web)") });
    expect(launched[1]!.firstTurnPrompt).toContain("the dev server needs PORT");
    const fixer = getTask(ids[1]!)!;
    expect(verifyTaskOf(fixer.id)).toMatchObject({ mode: "fix", area: "web", round_id: round.id });
    expect(autopilotStatus(task.id)).toMatchObject({ state: "waiting", reviewRounds: 1 });
    expect(autopilotStatus(task.id).reason).toBe("Waiting on the verification recipe (web): the dev server needs PORT");

    // the fixer saves a draft: a person has to activate it
    transition(fixer.id, "done");
    saveDraft(repo, fixer.id, [{ path: "RECIPE.md", content: "# r\n\nPORT matters." }, { path: "areas/web/AREA.md", content: "---\npaths: web/**\nstatus: proven\n---" }]);
    await pass(rt, task.id, clock);
    expect(autopilotStatus(task.id)).toMatchObject({ state: "needs-you" });
    expect(autopilotStatus(task.id).reason).toContain("has a fixed draft — activate it");

    await activateDraft(repo, "test");
    await pass(rt, task.id, clock);
    expect(launched).toHaveLength(3);
    expect(latest(task.id)).toMatchObject({ round: 1, counted: 0, state: "running" });
    expect(checkpointOf(autopilotRow(task.id)!).reviewRounds).toBe(1);
  });

  test("with no recipe at all, what the reviewer could not do is set one up", async () => {
    const repo = mkdtempSync(join(tmpdir(), "wisp-review-repo-"));
    const { clock, launched, ids, task, rt } = setup({ repo });
    await pass(rt, task.id, clock);
    verdict(latest(task.id), { verdict: "inconclusive", cause: "recipe", recipeFeedback: "no way to start the app is documented" });
    await pass(rt, task.id, clock);
    expect(launched[1]!).toMatchObject({ verifyRole: "recipe", prompt: expect.stringContaining("Set up verification") });
    expect(launched[1]!.firstTurnPrompt).toContain("no way to start the app is documented");
    expect(verifyTaskOf(ids[1]!)).toMatchObject({ mode: "setup" });
  });

  test("a reviewer that ends without a verdict is asked once, then the round needs you; resume asks a new reviewer", async () => {
    const { clock, launched, task, rt } = setup();
    await pass(rt, task.id, clock);
    const round = latest(task.id);
    transition(reviewerOf(round).id, "done");
    await pass(rt, task.id, clock);
    expect(primaryOf(round).nudged).toBe(1);
    expect(autopilotStatus(task.id).reason).toBe("Auto-review round 1 of 3: A asked for its verdict");
    // the nudge's turn could not start (no harness here): once the reviewer is idle again, the round ends
    db.run("UPDATE task_messages SET status = 'cancelled' WHERE task_id = ?", [reviewerOf(round).id]);
    transition(reviewerOf(round).id, "done");
    await pass(rt, task.id, clock);
    expect(getRound(round.id)!.state).toBe("error");
    expect(autopilotStatus(task.id)).toMatchObject({ state: "needs-you" });
    resumeAutopilot(task.id, new Date(clock.now));
    await pass(rt, task.id, clock);
    expect(launched).toHaveLength(2);
    expect(latest(task.id)).toMatchObject({ round: 1, counted: 0 });
  });

  test("a round whose row ended is ended by the sweep, and a finished reviewer is archived once its turn is over", async () => {
    const { clock, task, rt } = setup();
    await pass(rt, task.id, clock);
    const round = latest(task.id);
    // every switch off completes the row at once: no look will touch this round again
    setAutopilot(task.id, { autoMerge: false, autoReview: false });
    await rt.tick();
    expect(getRound(round.id)).toMatchObject({ state: "superseded", summary: "auto-review stopped for this task" });
    await until(() => getTask(primaryOf(round).reviewer_task_id!)!.archived === 1, "the superseded reviewer to be archived");
  });

  test("a passing reviewer still mid-turn is archived by a later sweep, after the merge moved on", async () => {
    const { clock, state, task, rt } = setup();
    await pass(rt, task.id, clock);
    const round = latest(task.id);
    verdict(round, { verdict: "pass" });
    await pass(rt, task.id, clock);
    expect(state.merges).toHaveLength(1);
    expect(getTask(primaryOf(round).reviewer_task_id!)!.archived).toBe(0);
    transition(primaryOf(round).reviewer_task_id!, "done");
    await rt.tick();
    await until(() => getTask(primaryOf(round).reviewer_task_id!)!.archived === 1, "the finished reviewer to be archived");
  });

  test("switching auto-review off ends a reviewer still at work", async () => {
    const { clock, task, rt } = setup();
    await pass(rt, task.id, clock);
    const round = latest(task.id);
    setAutopilot(task.id, { autoReview: false });
    await pass(rt, task.id, clock);
    expect(getRound(round.id)!.state).toBe("superseded");
  });

  test("auto-review alone is done for now once the head passes", async () => {
    const clock = { now: START + 10 * 60_000 };
    const { state, github } = fakeGitHub();
    const { launch } = launcher();
    const task = doneTask();
    setAutopilot(task.id, { autoReview: true });
    seed(task.id, clock);
    const rt = runtime(github, clock, {}, cfgFor("/fixture/repo", false), undefined, { launch });
    await pass(rt, task.id, clock);
    verdict(latest(task.id), { verdict: "pass" });
    await pass(rt, task.id, clock);
    expect(state.merges).toHaveLength(0);
    expect(autopilotStatus(task.id)).toMatchObject({ state: "waiting", done: true, reason: `Auto-review passed ${HEAD.slice(0, 7)}` });
  });
});

describe("the verdict", () => {
  async function round() {
    const { clock, task, rt } = setup();
    await pass(rt, task.id, clock);
    return latest(task.id);
  }
  const post = (reviewer: string, body: unknown) => autoReviewRoute(new Request(`http://wisp/api/tasks/${reviewer}/auto-review/verdict`, {
    method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" },
  }), `/api/tasks/${reviewer}/auto-review/verdict`);

  test("only the round's own token is taken, once", async () => {
    const open = await round();
    expect((await post(primaryOf(open).reviewer_task_id!, { token: "guess", verdict: "pass", summary: "ok" })).status).toBe(403);
    const ok = await post(primaryOf(open).reviewer_task_id!, { token: primaryOf(open).token, verdict: "pass", summary: "ok" });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ state: "pass", summary: "ok" });
    expect((await post(primaryOf(open).reviewer_task_id!, { token: primaryOf(open).token, verdict: "fail", summary: "changed my mind", findings: [{ title: "x", severity: "blocking", lens: "correctness", detail: "d", file: "a.ts" }] })).status).toBe(409);
  });

  test("a malformed verdict names the field", async () => {
    const open = await round();
    const check = async (body: Record<string, unknown>, says: string) => {
      const res = await post(primaryOf(open).reviewer_task_id!, { token: primaryOf(open).token, summary: "s", ...body });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain(says);
    };
    await check({ verdict: "maybe" }, "verdict must be");
    await check({ verdict: "inconclusive" }, "needs cause");
    await check({ verdict: "pass", cause: "change" }, "inconclusive verdict only");
    await check({ verdict: "fail" }, "at least one finding");
    await check({ verdict: "fail", findings: [{ title: "" }] }, "title is required");
    await check({ verdict: "inconclusive", cause: "recipe" }, "needs recipeFeedback");
    await check({ verdict: "pass", extra: 1 }, "unknown field");
  });

  test("an ordinary task is no reviewer, and its turns carry no token", async () => {
    const open = await round();
    const author = getTask(open.task_id)!;
    expect((await post(author.id, { token: primaryOf(open).token, verdict: "pass", summary: "ok" })).status).toBe(409);
    expect(reviewTurnEnv(author)).toEqual({});
    expect(reviewTurnEnv(getTask(primaryOf(open).reviewer_task_id!)!)).toEqual({ WISP_REVIEW_TOKEN: primaryOf(open).token });
    expect(roundOfReviewer(primaryOf(open).reviewer_task_id!)?.id).toBe(open.id);
  });
});

describe("the author's side", () => {
  test("its turns are told an independent reviewer checks the PR", () => {
    const task = doneTask();
    setAutopilot(task.id, { autoReview: true });
    const notes = autopilotTurnNotes(task.id).notes.join("\n");
    expect(notes).toContain("Auto-review is on for this task");
    expect(notes).toContain("open a pull request");
  });

  test("a reviewer or recipe task cannot switch autopilot on", () => {
    const id = newTaskId();
    createTask({ id, title: "reviewer", repo_path: "/fixture/repo", harness: "fake", model: null, verify_role: "reviewer", slot: freeSlot() });
    created.push(id);
    expect(() => setAutopilot(id, { autoMerge: true })).toThrow("cannot switch these on");
  });
});
