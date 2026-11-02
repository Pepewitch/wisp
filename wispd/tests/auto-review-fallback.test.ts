/**
 * A reviewer's fallback: a reviewer whose task fails on the network, on its
 * provider or in setup is replaced once, for the same round and head, by its
 * role's fallback agent. A verdict, a missing one and the time limit never
 * fall back.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { VerificationStatus } from "../../shared/api/auto-review";
import { BUILTIN_ADAPTERS, validateAdapters, type AdapterDef } from "../src/adapters";
import { sweepReviews } from "../src/autopilot/auto-review";
import { recordKillReason, startTurn } from "../src/runner";
import { finalizeTurn } from "../src/turn-finalize";
import { autopilotHistory, autopilotStatus, setAutopilot } from "../src/autopilot/store";
import { formatRound } from "../src/cli-review";
import { formatVerification } from "../src/cli-verify";
import { LOG_DIR, loadConfig, type RepoConfig } from "../src/config";
import type { NewTaskInput } from "../src/domain/task-create";
import { NETWORK_RESUME_MESSAGE } from "../src/autopilot/network";
import { createTask, createTaskMessage, createTurn, db, freeSlot, getTask, latestTurnForTask, messagesFor, newTaskId, newTaskMessageId, setTaskFields, settleTurn, transition } from "../src/store";
import { planReviewerResume, REVIEWER_NETWORK_RESUMES } from "../src/verify/reviewer-network";
import { submitVerdict } from "../src/verify/reviewer";
import { reviewsOf, reviewTokenFor, reviewView, substituteReview, type ReviewRow } from "../src/verify/reviews";
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

function setup(repo: Partial<RepoConfig> = { verifySecond: "off", verifyFallback: { harness: "standin", model: "standin-1", effort: "high" } }, adapters: Record<string, AdapterDef> = ADAPTERS) {
  const clock = { now: START + 10 * 60_000 };
  const { state, github } = fakeGitHub();
  const ctl = launcher();
  const task = doneTask();
  setAutopilot(task.id, { autoMerge: true, autoFix: false, autoReview: true });
  seed(task.id, clock);
  const cfg = { ...loadConfig(), repos: [{ path: "/fixture/repo", ...repo }] };
  const rt = runtime(github, clock, adapters, cfg, undefined, { launch: ctl.launch });
  return { clock, state, task, rt, ...ctl };
}

const latest = (taskId: string): RoundRow => roundsOf(taskId)[0]!;
const roleOf = (round: RoundRow, role: "primary" | "second"): ReviewRow => reviewsOf(round.id).find((review) => review.role === role)!;

/**
 * A reviewer task whose turn failed with this detail, settled as
 * turn-finalize.ts settles one. A network failure comes with its resumes
 * already spent (verify/reviewer-network.ts), so what follows is the fallback
 * these tests are about; `resumable` leaves them unspent.
 */
function failAfterTurn(taskId: string, detail: string, resumable = false): void {
  if (detail.startsWith("network: ") && !resumable) {
    for (let i = 0; i < REVIEWER_NETWORK_RESUMES; i++) {
      const id = newTaskMessageId();
      createTaskMessage({ id, taskId, text: NETWORK_RESUME_MESSAGE, attachmentHash: "", origin: "workflow", source: { by: "autopilot", kind: "network-resume", pr: 7, round: 1, rounds: null } });
      db.run("UPDATE task_messages SET status = 'delivered' WHERE id = ?", [id]);
    }
  }
  const n = (db.query("SELECT COUNT(*) AS n FROM turns WHERE task_id = ?").get(taskId) as { n: number }).n + 1;
  const turnId = createTurn(taskId, n, "review", null, join(LOG_DIR, `${taskId}-${n}.log`), null);
  settleTurn(turnId, { status: "failed", exitCode: 1, result: null }, taskId, "failed", detail);
}

describe("a reviewer whose turn ended on the network (#411)", () => {
  test("is told to continue after the backoff, before any fallback and without spending its nudge", async () => {
    // the reviewer's harness answers whatever it is sent
    const fake = validateAdapters({ fake: { bin: "bash", exec: ["-c", "printf 'continuing the review\\n'"], parse: { format: "text" } } }).fake!;
    const { clock, task, rt, launched } = setup(undefined, { ...ADAPTERS, fake });
    await pass(rt, task.id, clock);
    const first = roleOf(latest(task.id), "primary");
    const reviewer = first.reviewer_task_id!;
    setTaskFields(reviewer, { worktree_path: mkdtempSync(join(tmpdir(), "wisp-reviewer-network-")) });
    failAfterTurn(reviewer, "network: turn exited 1: getaddrinfo ENOTFOUND api.example.test", true);
    const resumes = () => messagesFor(reviewer).filter((message) => message.text === NETWORK_RESUME_MESSAGE);
    const ended = Date.parse(latestTurnForTask(reviewer)!.ended_at!);

    clock.now = ended + 30_000;
    await pass(rt, task.id, clock);
    expect(resumes()).toEqual([]);
    expect(autopilotStatus(task.id)?.reason).toContain("A lost the network — resuming in 1 min (1 of 3)");
    // the next look is the resume's own minute, not the round's usual twenty
    const next = (db.query("SELECT next_check_at FROM workflows WHERE task_id = ? AND type = 'pr-autopilot'").get(task.id) as { next_check_at: string }).next_check_at;
    expect(Date.parse(next)).toBe(ended + 60_000);

    clock.now = ended + 60_000;
    await pass(rt, task.id, clock);
    expect(resumes()).toHaveLength(1);
    expect(JSON.parse(resumes()[0]!.source_json!)).toMatchObject({ by: "autopilot", kind: "network-resume", pr: 7, round: 1 });
    // the same reviewer goes on: no fallback, the review still running, its one nudge unspent
    expect(launched).toHaveLength(1);
    expect(roleOf(latest(task.id), "primary")).toMatchObject({ id: first.id, state: "running", reviewer_task_id: reviewer, nudged: 0 });
    expect(autopilotHistory(task.id).map((entry) => entry.detail)).toContain("Round 1: reviewer A lost the network — resumed (1 of 3)");
    await until(() => getTask(reviewer)?.state === "done", "the resumed reviewer turn to finish");
    expect(latestTurnForTask(reviewer)).toMatchObject({ status: "done", result: "continuing the review" });
  });

  test("backs off 1, 2, then 4 minutes, never resumes a fourth time, and never sends a second resume while one waits to start", () => {
    const id = newTaskId();
    createTask({ id, title: "reviewer", repo_path: "/fixture/repo", harness: "fake", model: null, slot: freeSlot() });
    created.push(id);
    const resume = (status: "queued" | "delivered") => {
      const message = newTaskMessageId();
      createTaskMessage({ id: message, taskId: id, text: NETWORK_RESUME_MESSAGE, attachmentHash: "", origin: "workflow", source: { by: "autopilot", kind: "network-resume", pr: 7, round: 1, rounds: null } });
      if (status === "delivered") db.run("UPDATE task_messages SET status = 'delivered' WHERE id = ?", [message]);
      return message;
    };
    for (const [n, backoff] of [[1, 60_000], [2, 120_000], [3, 240_000]] as const) {
      failAfterTurn(id, "network: connection refused", true);
      const ended = Date.parse(latestTurnForTask(id)!.ended_at!);
      expect(planReviewerResume(getTask(id)!, ended + backoff - 1)).toEqual({ kind: "wait", resume: n, at: ended + backoff });
      expect(planReviewerResume(getTask(id)!, ended + backoff)).toEqual({ kind: "resume", resume: n, queued: null });
      // sent but not started yet (no free slot): that one is started again, never a second
      const queued = resume("queued");
      expect(planReviewerResume(getTask(id)!, ended + backoff + 60_000)).toEqual({ kind: "resume", resume: n, queued });
      db.run("UPDATE task_messages SET status = 'delivered' WHERE id = ?", [queued]);
    }
    failAfterTurn(id, "network: connection refused", true);
    expect(planReviewerResume(getTask(id)!, Date.now() + 60 * 60_000)).toEqual({ kind: "none" });
    // another failure is never resumed
    transition(id, "failed", "turn exited 1: Invalid API key · Please run /login");
    expect(planReviewerResume(getTask(id)!, Date.now() + 60 * 60_000)).toEqual({ kind: "none" });
  });
});

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

/** Settle a reviewer's turn from these logs the way the runner does (turn-finalize.ts), after an optional kill reason. */
async function finalizeReviewerTurn(taskId: string, def: AdapterDef, exit: number | null, out: string, kill?: string): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "wisp-fallback-turn-"));
  const outPath = join(dir, "turn.out.log"), errPath = join(dir, "turn.err.log");
  writeFileSync(outPath, out);
  writeFileSync(errPath, "");
  const turnId = createTurn(taskId, 1, "review", 99999, outPath);
  if (kill) recordKillReason(turnId, kill);
  await finalizeTurn(taskId, turnId, def, exit, outPath, errPath);
}

const CLAUDE_503 = `${JSON.stringify({
  type: "result", subtype: "success", is_error: true, session_id: "s-fixture",
  result: 'API Error: 503 {"type":"error","error":{"type":"api_error","message":"Service Unavailable"}}',
})}\n`;
const CODEX_503 = [
  { type: "thread.started", thread_id: "t-fixture" },
  { type: "turn.started" },
  { type: "turn.failed", error: { message: '{"type":"error","status":503,"error":{"type":"service_unavailable","message":"Service Unavailable"}}' } },
].map((line) => JSON.stringify(line)).join("\n") + "\n";

describe("through the real failure paths", () => {
  test("a harness that could not even be spawned is setup: the fallback reviews", async () => {
    const { clock, task, rt, launched } = setup();
    await pass(rt, task.id, clock);
    const reviewer = getTask(roleOf(latest(task.id), "primary").reviewer_task_id!)!;
    const missing: AdapterDef = { bin: join(tmpdir(), "wisp-no-such-reviewer-harness"), exec: [], parse: { format: "text" }, attach: null };
    startTurn(reviewer, "review", missing, loadConfig());
    await until(() => getTask(reviewer.id)?.state === "failed", "the spawn failure settled");
    expect(getTask(reviewer.id)!.state_detail).toStartWith("spawn failed: ");
    await pass(rt, task.id, clock);
    expect(launched).toHaveLength(2);
    expect(reviewView(roleOf(latest(task.id), "primary"), true).fallback).toMatchObject({ cause: "setup" });
  });

  test("a live session whose initialize timed out before the prompt is setup", async () => {
    const { clock, task, rt, launched } = setup();
    await pass(rt, task.id, clock);
    const reviewer = roleOf(latest(task.id), "primary").reviewer_task_id!;
    await finalizeReviewerTurn(reviewer, BUILTIN_ADAPTERS.droid!, 143, "", "live input setup failed: initialize_session timed out after 30000 ms");
    expect(getTask(reviewer)!.state_detail).toStartWith("turn killed: live input setup failed: ");
    await pass(rt, task.id, clock);
    expect(launched).toHaveLength(2);
    expect(reviewView(roleOf(latest(task.id), "primary"), true).fallback).toMatchObject({ cause: "setup" });
  });

  for (const [harness, out] of [["claude", CLAUDE_503], ["codex", CODEX_503]] as const) {
    test(`a 503 from the built-in ${harness}, settled by its own error strategy, is the provider`, async () => {
      const { clock, task, rt, launched } = setup();
      await pass(rt, task.id, clock);
      const reviewer = roleOf(latest(task.id), "primary").reviewer_task_id!;
      await finalizeReviewerTurn(reviewer, BUILTIN_ADAPTERS[harness]!, 1, out);
      expect(getTask(reviewer)!.state).toBe("failed");
      expect(infrastructureFailure(getTask(reviewer)!)).toMatchObject({ cause: "provider" });
      await pass(rt, task.id, clock);
      expect(launched).toHaveLength(2);
      expect(reviewView(roleOf(latest(task.id), "primary"), true).fallback).toMatchObject({ cause: "provider" });
    });
  }

  test("a restart between the substitution and the archive: the next sweep still retires the failed task", async () => {
    const { clock, task, rt } = setup();
    await pass(rt, task.id, clock);
    const review = roleOf(latest(task.id), "primary");
    failAfterTurn(review.reviewer_task_id!, "network: connection refused");
    // the substitution committed, and the daemon stopped before it archived the failed task
    expect(substituteReview(review.id, { harness: "standin", model: null, effort: null }, { cause: "network", detail: "connection refused" })).not.toBeNull();
    expect(getTask(review.reviewer_task_id!)?.archived).toBe(0);
    await sweepReviews(loadConfig(), new Date(clock.now));
    expect(getTask(review.reviewer_task_id!)?.archived).toBe(1);
  });
});

test("the provider's words, in any harness's detail; never credentials, limits or Wisp's own kills", () => {
  const failed = (detail: string) => {
    const id = newTaskId();
    createTask({ id, title: "classified", repo_path: "/fixture/repo", harness: "fake", model: null, slot: freeSlot() });
    created.push(id);
    failAfterTurn(id, detail);
    return infrastructureFailure(getTask(id)!)?.cause ?? null;
  };
  expect(failed("turn reported failure: API Error: 529 overloaded_error")).toBe("provider");
  expect(failed("turn exited 1: unexpected status 502 Bad Gateway")).toBe("provider");
  expect(failed("spawn failed: ENOENT: no such file or directory, posix_spawn")).toBe("setup");
  expect(failed("turn exited 1: API Error: 429 rate limit, service unavailable")).toBeNull();
  expect(failed("turn exited 1: API Error: 401 authentication_error")).toBeNull();
  expect(failed("turn killed: log cap exceeded (503 lines over)")).toBeNull();
  expect(failed("turn exited 1: wrote 503 files")).toBeNull();
});
