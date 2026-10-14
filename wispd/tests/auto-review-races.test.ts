/**
 * Auto-review's edges a second review reproduced: a retarget, a push while the
 * author works, simultaneous recipe tasks, and an activation that changed
 * nothing.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { autopilotStatus, resumeAutopilot, setAutopilot } from "../src/autopilot/store";
import { loadConfig } from "../src/config";
import type { NewTaskInput } from "../src/domain/task-create";
import { createTask, freeSlot, getTask, newTaskId, setTaskFields, transition } from "../src/store";
import { activateDraft, saveDraft } from "../src/verify/recipe";
import { startRecipeTask, submitVerdict } from "../src/verify/reviewer";
import { getRound, roundsOf, type RoundRow } from "../src/verify/rounds";
import { reviewsOf } from "../src/verify/reviews";
import { HEAD, START, created, doneTask, fakeGitHub, forgetTasks, pass, runtime, seed, snapshot } from "./autopilot-harness";

afterEach(forgetTasks);

function launcher(state: "running" | "creating" = "running") {
  const launched: NewTaskInput[] = [];
  const ids: string[] = [];
  const launch = async (input: NewTaskInput) => {
    launched.push(input);
    const id = newTaskId();
    ids.push(id);
    createTask({ id, title: input.prompt, repo_path: input.repoPath, harness: input.harness, model: input.model ?? null, verify_role: input.verifyRole ?? null, slot: freeSlot() });
    created.push(id);
    setTaskFields(id, { worktree_path: `/fixture/${id}`, branch: `wisp/${id}-review` });
    if (state === "running") transition(id, "running");
    const task = getTask(id)!;
    input.prepare?.(task);
    return { task, autopilot: autopilotStatus(id) };
  };
  return { launched, ids, launch };
}

const latest = (taskId: string) => roundsOf(taskId)[0]!;
const primaryOf = (round: RoundRow) => reviewsOf(round.id).find((review) => review.role === "primary")!;
/** The primary reviewer's verdict, in the panel's shape. */
const verdict = (round: RoundRow, body: Record<string, unknown>) =>
  submitVerdict(primaryOf(round).reviewer_task_id!, { token: primaryOf(round).token, summary: "Checked it", ...body } as never);

function setup(options: { autoFix?: boolean; repo?: string; cfg?: ReturnType<typeof loadConfig>; realClock?: boolean } = {}) {
  // a recipe activation is stamped with the real time: a test that activates one runs on it too
  const clock = { now: options.realClock ? Date.now() : START + 10 * 60_000 };
  const { state, github } = fakeGitHub();
  const { launched, ids, launch } = launcher();
  const task = doneTask(options.repo ? { repo_path: options.repo } : {});
  setAutopilot(task.id, { autoMerge: true, autoFix: options.autoFix ?? false, autoReview: true });
  seed(task.id, clock);
  // one reviewer, unless a test's own config says otherwise
  const cfg = options.cfg ?? { ...loadConfig(), repos: [{ path: options.repo ?? "/fixture/repo", verifySecond: "off" as const }] };
  const rt = runtime(github, clock, {}, cfg, undefined, { launch });
  return { clock, state, launched, ids, task, rt };
}

describe("a pass belongs to the base it was reviewed against", () => {
  test("retargeting the same head to another allowed base asks for a new review before anything merges", async () => {
    const cfg = { ...loadConfig(), repos: [{ path: "/fixture/repo", baseBranch: "release", verifySecond: "off" as const }] };
    const { clock, state, launched, task, rt } = setup({ cfg });
    state.merges.length = 0;
    // reviewed against main, but before the merge the PR is retargeted to release
    await pass(rt, task.id, clock);
    verdict(latest(task.id), { verdict: "pass" });
    state.pr = snapshot({ baseRefName: "release" });
    state.mergeResult = { ok: true, detail: "" };
    await pass(rt, task.id, clock);
    expect(state.merges).toHaveLength(0);
    expect(launched).toHaveLength(2);
    expect(latest(task.id)).toMatchObject({ head: HEAD, base: "release", state: "running" });
  });
});

describe("an obsolete reviewer stops at once", () => {
  test("a push while the author is still working supersedes the running round", async () => {
    const { clock, state, task, rt } = setup();
    await pass(rt, task.id, clock);
    const first = latest(task.id);
    transition(task.id, "running");
    state.pr = snapshot({ head: "d".repeat(40) });
    await pass(rt, task.id, clock);
    expect(getRound(first.id)!.state).toBe("superseded");
  });

  test("a new red head with auto-fix on supersedes it before the fix round", async () => {
    const { clock, state, task, rt } = setup({ autoFix: true });
    await pass(rt, task.id, clock);
    const first = latest(task.id);
    state.pr = snapshot({ head: "e".repeat(40), checks: [{ name: "test", status: "COMPLETED", conclusion: "FAILURE", required: true, url: "" }] });
    clock.now += 5 * 60_000;
    await pass(rt, task.id, clock);
    expect(getRound(first.id)!.state).toBe("superseded");
  });
});

describe("one recipe writer per project", () => {
  test("two simultaneous starts: one task, one refusal", async () => {
    const repo = mkdtempSync(join(tmpdir(), "wisp-recipe-race-"));
    const { launched, launch } = launcher("creating");
    // a launch that takes a moment, as task creation does
    const slow = async (input: NewTaskInput) => { await Bun.sleep(20); return launch(input); };
    const start = { cfg: loadConfig(), adapters: {}, launch: slow };
    const input = { repoPath: repo, projectName: "p", mode: "setup" as const, area: null, note: null, complaints: [], agent: { harness: "fake" }, roundId: null, actor: "web" };
    const [a, b] = await Promise.all([startRecipeTask(start, input), startRecipeTask(start, input)]);
    const results = [a, b].map((result) => ("task" in result ? 201 : result.status)).sort();
    expect(results).toEqual([201, 409]);
    expect(launched).toHaveLength(1);
    // and once it exists, a later start still sees it working
    const later = await startRecipeTask(start, input);
    expect("error" in later && later.status).toBe(409);
  });
});

describe("a held review goes again on the person's word", () => {
  async function held() {
    const repo = mkdtempSync(join(tmpdir(), "wisp-review-hold-"));
    const files = [{ path: "RECIPE.md", content: "# r" }, { path: "areas/web/AREA.md", content: "---\npaths: web/**\nstatus: proven\n---" }];
    saveDraft(repo, "tfirst", files);
    await activateDraft(repo, "test");
    const ctx = setup({ repo, realClock: true });
    await pass(ctx.rt, ctx.task.id, ctx.clock);
    verdict(latest(ctx.task.id), { verdict: "inconclusive", cause: "recipe", recipeFeedback: "the dev server was down", recipeArea: "web" });
    await pass(ctx.rt, ctx.task.id, ctx.clock);
    expect(ctx.launched).toHaveLength(2);
    return { ...ctx, repo, files };
  }

  test("activating a draft that changed nothing still re-reviews the head", async () => {
    const { clock, launched, ids, task, rt, repo, files } = await held();
    transition(ids[1]!, "done");
    saveDraft(repo, ids[1]!, files);
    await Bun.sleep(5);
    expect((await activateDraft(repo, "web")).changed).toBe(false);
    await pass(rt, task.id, clock);
    expect(launched).toHaveLength(3);
    expect(latest(task.id)).toMatchObject({ round: 1, counted: 0, state: "running" });
  });

  test("Resume re-reviews a recipe-held head without a recipe change", async () => {
    const { clock, launched, ids, task, rt } = await held();
    transition(ids[1]!, "done");
    await pass(rt, task.id, clock);
    expect(autopilotStatus(task.id).state).toBe("needs-you");
    resumeAutopilot(task.id, new Date(clock.now));
    await pass(rt, task.id, clock);
    expect(launched).toHaveLength(3);
    expect(latest(task.id)).toMatchObject({ round: 1, counted: 0 });
  });
});
