/**
 * A reviewer's fallback: a reviewer whose task fails on the network, on its
 * provider or in setup is replaced once, for the same round and head, by its
 * role's fallback agent. A verdict, a missing one and the time limit never
 * fall back.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { VerificationStatus } from "../../shared/api/auto-review";
import type { AdapterDef } from "../src/adapters";
import { autopilotHistory, autopilotStatus, setAutopilot } from "../src/autopilot/store";
import { formatRound } from "../src/cli-review";
import { formatVerification } from "../src/cli-verify";
import { LOG_DIR, loadConfig, type RepoConfig } from "../src/config";
import type { NewTaskInput } from "../src/domain/task-create";
import { createTask, createTurn, db, freeSlot, getTask, newTaskId, setTaskFields, settleTurn, transition } from "../src/store";
import { submitVerdict } from "../src/verify/reviewer";
import { reviewsOf, reviewTokenFor, reviewView, type ReviewRow } from "../src/verify/reviews";
import { roundsOf, roundView, type RoundRow } from "../src/verify/rounds";
import { infrastructureFailure } from "../src/verify/fallback";
import { START, created, doneTask, fakeGitHub, forgetTasks, pass, runtime, seed, until } from "./autopilot-harness";

afterEach(forgetTasks);

/** Harnesses the fallback may name: only their presence is read, nothing runs on them. */
const ADAPTERS = { standin: {} as AdapterDef, otherstandin: {} as AdapterDef };

function launcher() {
  const launched: NewTaskInput[] = [];
  const launch = async (input: NewTaskInput) => {
    launched.push(input);
    const id = newTaskId();
    createTask({ id, title: input.prompt, repo_path: input.repoPath, harness: input.harness, model: input.model ?? null, verify_role: input.verifyRole ?? null, slot: freeSlot() });
    created.push(id);
    setTaskFields(id, { worktree_path: `/fixture/${id}`, branch: `wisp/${id}-review` });
    transition(id, "running");
    input.prepare?.(getTask(id)!);
    return { task: getTask(id)!, autopilot: autopilotStatus(id) };
  };
  return { launched, launch };
}

function setup(repo: Partial<RepoConfig> = { verifySecond: "off", verifyFallback: { harness: "standin", model: "standin-1", effort: "high" } }) {
  const clock = { now: START + 10 * 60_000 };
  const { state, github } = fakeGitHub();
  const ctl = launcher();
  const task = doneTask();
  setAutopilot(task.id, { autoMerge: true, autoFix: false, autoReview: true });
  seed(task.id, clock);
  const cfg = { ...loadConfig(), repos: [{ path: "/fixture/repo", ...repo }] };
  const rt = runtime(github, clock, ADAPTERS, cfg, undefined, { launch: ctl.launch });
  return { clock, state, task, rt, ...ctl };
}

const latest = (taskId: string): RoundRow => roundsOf(taskId)[0]!;
const roleOf = (round: RoundRow, role: "primary" | "second"): ReviewRow => reviewsOf(round.id).find((review) => review.role === role)!;

/** A reviewer task whose turn failed with this detail, settled as turn-finalize.ts settles one. */
function failAfterTurn(taskId: string, detail: string): void {
  const n = (db.query("SELECT COUNT(*) AS n FROM turns WHERE task_id = ?").get(taskId) as { n: number }).n + 1;
  const turnId = createTurn(taskId, n, "review", null, join(LOG_DIR, `${taskId}-${n}.log`), null);
  settleTurn(turnId, { status: "failed", exitCode: 1, result: null }, taskId, "failed", detail);
}

describe("an infrastructure failure falls back, once", () => {
  const classes: [string, (taskId: string) => void, string][] = [
    ["the network", (id) => failAfterTurn(id, "network: turn exited 1: getaddrinfo ENOTFOUND api.example.test"), "network"],
    ["the provider", (id) => failAfterTurn(id, "transient: turn exited 1: 529 overloaded_error"), "provider"],
    ["setup, before any turn", (id) => transition(id, "failed", "setup timed out after 10 min and was killed"), "setup"],
  ];
  for (const [name, fail, cause] of classes) {
    test(`a reviewer that failed on ${name} is replaced by the fallback for the same round and head`, async () => {
      const { clock, task, rt, launched, state } = setup();
      await pass(rt, task.id, clock);
      const round = latest(task.id);
      const first = roleOf(round, "primary");
      fail(first.reviewer_task_id!);
      await pass(rt, task.id, clock);

      // the same round, the same head; one review for A, now on the fallback
      expect(roundsOf(task.id)).toHaveLength(1);
      expect(launched).toHaveLength(2);
      expect(launched[1]).toMatchObject({ harness: "standin", model: "standin-1", effort: "high" });
      expect(launched[1]!.prompt).toStartWith("Auto-review A (fallback) · PR #7 · round 1");
      expect(launched[1]!.base).toEqual(launched[0]!.base);
      const now = roleOf(latest(task.id), "primary");
      expect(now).toMatchObject({ id: first.id, state: "running", harness: "standin", model: "standin-1", nudged: 0 });
      expect(now.reviewer_task_id).not.toBe(first.reviewer_task_id);
      expect(latest(task.id)).toMatchObject({ id: round.id, state: "running", reviewer_task_id: now.reviewer_task_id });

      // who reviews and why is on record: the review, the history, `wisp review show`
      const fallback = reviewView(now, true).fallback!;
      expect(fallback).toMatchObject({ cause, from: { harness: "fake", model: null, effort: null }, taskId: first.reviewer_task_id });
      const said = autopilotHistory(task.id).find((entry) => entry.detail.includes("falling back"));
      expect(said?.detail).toContain(`Round 1: reviewer A (fake) failed`);
      expect(said?.detail).toContain("falling back to standin standin-1");
      const shown = formatRound(roundView(latest(task.id), reviewsOf(round.id).map((review) => reviewView(review, true))), true);
      expect(shown).toContain(`A standin standin-1 (fallback for fake: ${cause}): running`);

      // the failed task can no longer speak for the review, and goes
      expect(reviewTokenFor(first.reviewer_task_id!)).toBeNull();
      expect(() => submitVerdict(first.reviewer_task_id!, { token: first.token, verdict: "pass", summary: "late" })).toThrow();
      await until(() => getTask(first.reviewer_task_id!)?.archived === 1, "the failed reviewer task archived");

      // the fallback's verdict is the round's
      submitVerdict(now.reviewer_task_id!, { token: now.token, verdict: "pass", summary: "Ran it" });
      await pass(rt, task.id, clock);
      expect(latest(task.id)).toMatchObject({ id: round.id, state: "pass" });
      expect(latest(task.id).summary).toStartWith("A (fallback): pass");
      expect(state.merges).toHaveLength(1);
    });
  }

  test("a fallback that fails too ends the review as an error: there is no second fallback", async () => {
    const { clock, task, rt, launched } = setup();
    await pass(rt, task.id, clock);
    failAfterTurn(roleOf(latest(task.id), "primary").reviewer_task_id!, "network: connection refused");
    await pass(rt, task.id, clock);
    const fallback = roleOf(latest(task.id), "primary");
    failAfterTurn(fallback.reviewer_task_id!, "network: connection refused");
    await pass(rt, task.id, clock);
    expect(launched).toHaveLength(2);
    expect(roleOf(latest(task.id), "primary")).toMatchObject({ state: "error", summary: "had its task fail", harness: "standin" });
    expect(latest(task.id).state).toBe("error");
    expect(autopilotStatus(task.id)?.reason).toContain("gave no verdict");
  });

  test("reviewer B falls back to its own fallback agent", async () => {
    const { clock, task, rt, launched } = setup({ verifyFallback: { harness: "standin" }, verifySecondFallback: { harness: "otherstandin" } });
    await pass(rt, task.id, clock);
    // a diff Wisp cannot read is deep: A and B
    expect(reviewsOf(latest(task.id).id)).toHaveLength(2);
    transition(roleOf(latest(task.id), "second").reviewer_task_id!, "failed", "git worktree add failed");
    await pass(rt, task.id, clock);
    expect(launched.map((input) => input.harness)).toEqual(["fake", "fake", "otherstandin"]);
    expect(launched[2]!.prompt).toStartWith("Auto-review B (fallback)");
    expect(roleOf(latest(task.id), "primary")).toMatchObject({ harness: "fake", fallback_json: null });
  });
});

describe("what never falls back", () => {
  test("with no fallback set, an infrastructure failure ends the round as an error, as before", async () => {
    const { clock, task, rt, launched } = setup({ verifySecond: "off" });
    await pass(rt, task.id, clock);
    failAfterTurn(roleOf(latest(task.id), "primary").reviewer_task_id!, "network: getaddrinfo ENOTFOUND api.example.test");
    await pass(rt, task.id, clock);
    expect(launched).toHaveLength(1);
    expect(roleOf(latest(task.id), "primary")).toMatchObject({ state: "error", summary: "had its task fail" });
  });

  test("a failed turn that is not the machine's (a usage limit, a plain failure) ends as an error", async () => {
    for (const detail of ["limit: turn exited 1: usage limit reached", "turn exited 1: TypeError in the agent"]) {
      const { clock, task, rt, launched } = setup();
      await pass(rt, task.id, clock);
      failAfterTurn(roleOf(latest(task.id), "primary").reviewer_task_id!, detail);
      await pass(rt, task.id, clock);
      expect(launched).toHaveLength(1);
      expect(roleOf(latest(task.id), "primary")).toMatchObject({ state: "error", fallback_json: null });
      forgetTasks();
    }
  });

  test("a verdict stands: a reviewer whose task fails after it gave one is not replaced", async () => {
    const { clock, task, rt, launched } = setup();
    await pass(rt, task.id, clock);
    const review = roleOf(latest(task.id), "primary");
    submitVerdict(review.reviewer_task_id!, { token: review.token, verdict: "fail", summary: "Broke it", findings: [
      { title: "Saving drops the name", severity: "blocking", lens: "correctness", detail: "Ran it", file: "src/app.ts" },
    ] });
    failAfterTurn(review.reviewer_task_id!, "network: connection reset");
    await pass(rt, task.id, clock);
    expect(launched).toHaveLength(1);
    expect(latest(task.id).state).toBe("fail");
  });

  test("a turn that ended without a verdict is asked once, then ends as an error", async () => {
    const { clock, task, rt, launched } = setup();
    await pass(rt, task.id, clock);
    const review = roleOf(latest(task.id), "primary");
    transition(review.reviewer_task_id!, "done");
    await pass(rt, task.id, clock);
    db.run("UPDATE task_messages SET status = 'cancelled' WHERE task_id = ?", [review.reviewer_task_id!]);
    transition(review.reviewer_task_id!, "done");
    await pass(rt, task.id, clock);
    expect(launched).toHaveLength(1);
    expect(roleOf(latest(task.id), "primary")).toMatchObject({ state: "error", summary: "ended without a verdict" });
  });

  test("the time limit wins over a network failure: past it, the review ends as an error", async () => {
    const { clock, task, rt, launched } = setup();
    await pass(rt, task.id, clock);
    const round = latest(task.id);
    db.run("UPDATE round_reviews SET launched_at = ? WHERE round_id = ?", [new Date(clock.now - 3 * 60 * 60_000).toISOString(), round.id]);
    failAfterTurn(roleOf(round, "primary").reviewer_task_id!, "network: connection refused");
    await pass(rt, task.id, clock);
    expect(launched).toHaveLength(1);
    expect(roleOf(latest(task.id), "primary")).toMatchObject({ state: "error", summary: "ran past 120 minutes" });
  });
});

describe("infrastructureFailure", () => {
  const task = (detail: string, turns: boolean) => {
    const id = newTaskId();
    createTask({ id, title: "classified", repo_path: "/fixture/repo", harness: "fake", model: null, slot: freeSlot() });
    created.push(id);
    if (turns) settleTurn(createTurn(id, 1, "x", null, join(LOG_DIR, `${id}-1.log`), null), { status: "failed", exitCode: 1, result: null }, id, "failed", detail);
    else transition(id, "failed", detail);
    return getTask(id)!;
  };

  test("reads the cause Wisp wrote on the task, without its prefix", () => {
    expect(infrastructureFailure(task("network: turn exited 1: ECONNRESET", true))).toEqual({ cause: "network", detail: "turn exited 1: ECONNRESET" });
    expect(infrastructureFailure(task("transient: turn exited 1: service unavailable", true))).toEqual({ cause: "provider", detail: "turn exited 1: service unavailable" });
    expect(infrastructureFailure(task("setup script exited 2", false))).toEqual({ cause: "setup", detail: "setup script exited 2" });
    expect(infrastructureFailure(task("limit: usage limit", true))).toBeNull();
    expect(infrastructureFailure(task("turn exited 1: boom", true))).toBeNull();
  });

  test("a task that has not failed has no failure", () => {
    const id = newTaskId();
    createTask({ id, title: "running", repo_path: "/fixture/repo", harness: "fake", model: null, slot: freeSlot() });
    created.push(id);
    transition(id, "running");
    expect(infrastructureFailure(getTask(id)!)).toBeNull();
  });
});

test("`wisp verify status` names each reviewer's fallback, and says nothing when there is none", () => {
  const status: VerificationStatus = {
    state: "none", version: null, activatedAt: null, areas: [], draft: null, task: null, attention: null,
    reviewer: { harness: "droid", model: "kimi-k3", effort: null }, second: null,
    fallbacks: { primary: { harness: "claude", model: "opus-5", effort: "high" }, second: null },
  };
  const text = formatVerification(status, "/fixture/repo");
  expect(text).toContain("fallback for A: claude opus-5 (high effort), after an infrastructure failure");
  expect(text).not.toContain("fallback for B");
  expect(formatVerification({ ...status, fallbacks: undefined }, "/fixture/repo")).not.toContain("fallback");
});
