import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import type { PrComment, PrReview, PrThread } from "../src/autopilot/github";
import { autopilotRow, autopilotStatus, checkpointOf, noteTurnSigning, reserveRound, setAutopilot, skipPendingFix } from "../src/autopilot/store";
import { taskMessageRoute } from "../src/routes/task-messages";
import { startNextQueuedMessage } from "../src/runner";
import { loadConfig } from "../src/config";
import { db, getTask, setTaskFields } from "../src/store";
import { HEAD, START, forgetTasks, doneTask, snapshot, fakeGitHub, runtime, seed, pass, until, capture, queue } from "./autopilot-harness";

afterEach(forgetTasks);

describe("auto-fix for review feedback", () => {
  const SOON = "2026-09-23T12:09:30Z";
  const said = (over: Partial<PrComment> = {}): PrComment => ({
    id: "RC_1", author: "owner", association: "OWNER", bot: false, body: "Rename this to `retryLimit`.",
    createdAt: SOON, editedAt: null, url: "https://github.com/o/r/pull/7#discussion_r1", hidden: false, ...over,
  });
  const thread = (over: Partial<PrThread> = {}, comments = [said()]): PrThread => ({
    id: "PRRT_1", resolved: false, outdated: false, path: "src/retry.ts", line: 40,
    starter: { author: comments[0]!.author, bot: comments[0]!.bot, body: comments[0]!.body }, comments, ...over,
  });
  const blocking: PrReview = {
    id: "PRR_1", author: "owner", association: "OWNER", bot: false, state: "COMMENTED", body: "Verdict: not safe to merge\n\n1. The retry never stops.",
    commit: HEAD, submittedAt: SOON, editedAt: null, url: "https://github.com/o/r/pull/7#pullrequestreview-1",
  };

  function reviewTask() {
    const { dir, file, adapters } = capture();
    const task = doneTask({ harness: "capture" });
    setTaskFields(task.id, { worktree_path: dir, turn_count: 1 });
    return { task, file, adapters };
  }
  const evidenceOf = (file: string) => readFileSync(readFileSync(file, "utf8").match(/Read (\S+PR-FEEDBACK\.md)/)![1]!, "utf8");

  test("a reviewer's review and thread go to the agent as one round, once the burst settles — and only once", async () => {
    const { task, file, adapters } = reviewTask();
    const clock = { now: START + 10 * 60_000 };
    const { state, github } = fakeGitHub({ pr: snapshot({ reviews: [blocking], threads: [thread()], unresolvedThreads: 1, mergeState: "BLOCKED" }) });
    const rt = runtime(github, clock, adapters);
    setAutopilot(task.id, { autoFix: true });
    seed(task.id, clock, { idleSince: new Date(START).toISOString(), idleTurn: 1 });
    await pass(rt, task.id, clock);
    // written 30 s ago: it waits two minutes after the newest words
    expect(autopilotStatus(task.id)).toMatchObject({ reason: "Auto-fix will send: 1 review thread, 1 review", by: "auto-fix" });
    expect(existsSync(file)).toBe(false);
    clock.now += 2 * 60_000;
    await pass(rt, task.id, clock);
    await until(() => existsSync(file), "the review round");
    const prompt = readFileSync(file, "utf8");
    expect(prompt).toContain("New review feedback on this PR: 1 review thread, 1 review.");
    expect(prompt).toContain(`End every comment or reply you post on GitHub with: — capture via Wisp <!-- wisp:task=${task.id} -->`);
    const evidence = evidenceOf(file);
    expect(evidence).toContain("### Thread on `src/retry.ts:40` — you may resolve it");
    expect(evidence).toContain("Thread id: `PRRT_1`");
    expect(evidence).toContain("Rename this to `retryLimit`.");
    expect(evidence).toContain("### Review by @owner (the PR's owner): commented on");
    expect(evidence).toContain("The retry never stops.");
    expect(evidence).toContain("resolveReviewThread");
    expect(autopilotStatus(task.id).fixRounds).toBe(1);
    await until(() => getTask(task.id)?.state === "done", "the round to settle");
    // nothing new to send, but the thread Wisp sent is still open: that is for a person now
    await pass(rt, task.id, clock);
    expect(autopilotStatus(task.id)).toMatchObject({ fixRounds: 1, state: "needs-you", reason: "1 review thread still open" });
    // a new reply on the thread is new feedback, and gets its own settle time
    clock.now += 5 * 60_000;
    state.pr = { ...state.pr, threads: [thread({}, [said(), said({ id: "RC_2", body: "Still wrong for 0.", createdAt: new Date(clock.now - 30_000).toISOString() })])] };
    await pass(rt, task.id, clock);
    expect(autopilotStatus(task.id).reason).toBe("Auto-fix will send: 1 review thread");
  });

  test("on a PR with more than 100 threads, a sent thread that fell out of the newest 100 still holds the merge", async () => {
    const { task, adapters } = reviewTask();
    const clock = { now: START + 10 * 60_000 };
    const { state, github } = fakeGitHub({ pr: snapshot({ threads: [], threadsTruncated: true }) });
    const rt = runtime(github, clock, adapters);
    setAutopilot(task.id, { autoMerge: true, autoFix: true });
    seed(task.id, clock, { idleSince: new Date(START).toISOString(), idleTurn: 1, delivered: { "thread:PRRT_OLD": SOON } });
    await pass(rt, task.id, clock);
    expect(autopilotStatus(task.id)).toMatchObject({ state: "needs-you", reason: "1 review thread still open" });
    expect(state.merges).toHaveLength(0);
    // on a PR Wisp can read in full, a sent thread that is gone was resolved or deleted
    state.pr = { ...state.pr, threadsTruncated: false };
    await pass(rt, task.id, clock);
    expect(state.merges).toHaveLength(1);
  });

  test("CI and review feedback share one round and one budget", async () => {
    const { task, file, adapters } = reviewTask();
    const clock = { now: START + 10 * 60_000 };
    const red = { name: "test", status: "COMPLETED", conclusion: "FAILURE", required: true, url: "https://ci/test", checkRunId: 11, run: { id: 5, event: "pull_request" }, deployment: false };
    const { github } = fakeGitHub({ pr: snapshot({ checks: [red], reviews: [{ ...blocking, submittedAt: "2026-09-23T12:00:00Z" }] }) });
    const rt = runtime(github, clock, adapters);
    setAutopilot(task.id, { autoMerge: true, autoFix: true });
    seed(task.id, clock, { idleSince: new Date(START).toISOString(), idleTurn: 1 });
    await pass(rt, task.id, clock);
    await until(() => existsSync(file), "the round");
    expect(readFileSync(file, "utf8")).toContain("CI failed on this PR: test failing. New review feedback on this PR: 1 review.");
    const evidence = evidenceOf(file);
    expect(evidence).toContain("## What failed");
    expect(evidence).toContain("## Review feedback");
    expect(autopilotStatus(task.id).fixRounds).toBe(1);
    await until(() => getTask(task.id)?.state === "done", "the round to settle");
    // no push, nothing new: the CI part is not sent again under its own key
    await pass(rt, task.id, clock);
    expect(autopilotStatus(task.id)).toMatchObject({ fixRounds: 1, state: "needs-you", reason: "Still test failing after round 1, with no new push" });
  });

  test("a combined round cancelled from the message list skips its CI part and marks its feedback seen", async () => {
    const task = doneTask();
    setAutopilot(task.id, { autoFix: true });
    const row = autopilotRow(task.id)!;
    const key = `ci:${HEAD}:test|fb:thread:PRRT_1@${SOON}`;
    const id = reserveRound(row, { key, prompt: "fix it", reason: "Sent", checkpoint: checkpointOf(row), turnCount: 0 }, new Date())!;
    const path = `/api/tasks/${task.id}/messages/${id}`;
    expect((await taskMessageRoute(new Request(`http://localhost${path}`, { method: "DELETE" }), path, "DELETE"))?.status).toBe(200);
    const checkpoint = checkpointOf(autopilotRow(task.id)!);
    expect(checkpoint.skipped).toContain(`ci:${HEAD}:test`);
    expect(checkpoint.delivered).toEqual({ "thread:PRRT_1": SOON });
  });

  test("review feedback counts against the same three rounds", async () => {
    const { task, adapters } = reviewTask();
    const clock = { now: START + 10 * 60_000 };
    const { github } = fakeGitHub({ pr: snapshot({ reviews: [{ ...blocking, submittedAt: "2026-09-23T12:00:00Z" }] }) });
    const rt = runtime(github, clock, adapters);
    setAutopilot(task.id, { autoFix: true });
    seed(task.id, clock, { idleSince: new Date(START).toISOString(), idleTurn: 1, rounds: 3 });
    await pass(rt, task.id, clock);
    expect(autopilotStatus(task.id)).toMatchObject({ state: "paused", reason: "Auto-fix gave up after 3 rounds — resume to try again" });
  });

  test("the runner records which turns were asked to sign, and a reused turn number takes the later answer", async () => {
    const { task, adapters } = reviewTask();
    setAutopilot(task.id, { autoFix: true });
    queue(task.id, "/review");
    expect(startNextQueuedMessage(task.id, adapters, loadConfig())).not.toBeNull();
    await until(() => getTask(task.id)?.state === "done", "the slash turn");
    expect(checkpointOf(autopilotRow(task.id)!).unmarkedTurns).toEqual([2]);
    queue(task.id, "a plain turn");
    startNextQueuedMessage(task.id, adapters, loadConfig());
    await until(() => getTask(task.id)?.state === "done", "the plain turn");
    expect(checkpointOf(autopilotRow(task.id)!).unmarkedTurns).toEqual([2]);
    // turn 2's start failed and a signing turn took its number
    noteTurnSigning(task.id, 2, true);
    expect(checkpointOf(autopilotRow(task.id)!).unmarkedTurns).toEqual([]);
  });

  test("a slash-command turn is never asked to sign, so the owner's-account posts inside it are the agent's", async () => {
    const { task, file, adapters } = reviewTask();
    const clock = { now: START + 10 * 60_000 };
    setAutopilot(task.id, { autoFix: true });
    // turn 2 ran `/code-review --comment` after arming: no notes, so no signature
    noteTurnSigning(task.id, 2, false);
    db.run("INSERT INTO turns(task_id, n, prompt, status, log_file, started_at, ended_at) VALUES (?, 2, '/code-review', 'done', '/dev/null', ?, ?)",
      [task.id, "2026-09-23T12:01:00Z", "2026-09-23T12:03:00Z"]);
    const posted = said({ id: "RC_7", body: "nit: rename `x`", createdAt: "2026-09-23T12:02:00Z" });
    const owners = said({ id: "RC_8", body: "Also handle ```` fences ````", createdAt: "2026-09-23T12:04:00Z" });
    const { github } = fakeGitHub({ pr: snapshot({ threads: [thread({ id: "PRRT_7" }, [posted]), thread({ id: "PRRT_8" }, [owners])] }) });
    const rt = runtime(github, clock, adapters);
    seed(task.id, clock, { idleSince: new Date(START).toISOString(), idleTurn: 1, ...{ unmarkedTurns: checkpointOf(autopilotRow(task.id)!).unmarkedTurns } });
    await pass(rt, task.id, clock);
    await until(() => existsSync(file), "the round");
    const evidence = evidenceOf(file);
    expect(evidence).toContain("Also handle");
    expect(evidence).not.toContain("nit: rename");
    // the fence outruns the body's own backticks
    expect(evidence).toContain("`````text\nAlso handle ```` fences ````\n`````");
    await until(() => getTask(task.id)?.state === "done", "the round to settle");
  });

  test("review feedback is not held back while CI is still running", async () => {
    const { task, file, adapters } = reviewTask();
    const clock = { now: START + 10 * 60_000 };
    const running = { name: "test", status: "IN_PROGRESS", conclusion: null, required: true, url: "", run: { id: 5, event: "pull_request" } };
    const { github } = fakeGitHub({ pr: snapshot({ checks: [running], reviews: [{ ...blocking, submittedAt: "2026-09-23T12:00:00Z" }] }) });
    const rt = runtime(github, clock, adapters);
    setAutopilot(task.id, { autoFix: true });
    seed(task.id, clock, { idleSince: new Date(START).toISOString(), idleTurn: 1 });
    await pass(rt, task.id, clock);
    await until(() => existsSync(file), "the review round");
    expect(readFileSync(file, "utf8")).not.toContain("CI failed");
    await until(() => getTask(task.id)?.state === "done", "the round to settle");
  });

  test("the owner's account inside a turn from before auto-fix was armed is the agent speaking; outside it, the owner", async () => {
    const { task, file, adapters } = reviewTask();
    const clock = { now: START + 10 * 60_000 };
    // a turn from before arming: its "comment" is the agent's own, unmarked
    db.run("INSERT INTO turns(task_id, n, prompt, status, log_file, started_at, ended_at) VALUES (?, 1, 'x', 'done', '/dev/null', ?, ?)",
      [task.id, "2026-09-23T12:00:00Z", "2026-09-23T12:05:00Z"]);
    const theirs = { id: "IC_1", author: "owner", association: "OWNER", bot: false, body: "I opened this PR to fix the retry loop.", createdAt: "2026-09-23T12:02:00Z", editedAt: null, url: "https://gh/c/1" };
    const mine = { ...theirs, id: "IC_2", body: "Please also cover the zero case.", createdAt: "2026-09-23T12:07:00Z" };
    const { github } = fakeGitHub({ pr: snapshot({ comments: [theirs, mine] }) });
    const rt = runtime(github, clock, adapters);
    setAutopilot(task.id, { autoFix: true });
    seed(task.id, clock, { idleSince: new Date(START).toISOString(), idleTurn: 1, fixArmedAt: "2026-09-23T12:06:00Z" });
    await pass(rt, task.id, clock);
    await until(() => existsSync(file), "the round");
    const evidence = evidenceOf(file);
    expect(evidence).toContain("Please also cover the zero case.");
    expect(evidence).not.toContain("I opened this PR");
    await until(() => getTask(task.id)?.state === "done", "the round to settle");
  });

  test("only people who can push instruct the agent", async () => {
    const { task, file, adapters } = reviewTask();
    const clock = { now: START + 10 * 60_000 };
    const colleague = { ...blocking, author: "colleague", association: "MEMBER", submittedAt: "2026-09-23T12:00:00Z" };
    const { state, github } = fakeGitHub({ pr: snapshot({ reviews: [colleague] }) });
    const rt = runtime(github, clock, adapters);
    setAutopilot(task.id, { autoFix: true });
    seed(task.id, clock, { idleSince: new Date(START).toISOString(), idleTurn: 1 });
    await pass(rt, task.id, clock);
    expect(autopilotStatus(task.id).reason).toBe("Nothing to fix");
    expect(existsSync(file)).toBe(false);
    // the lookup is cached an hour, so a later grant takes a new runtime (or the hour)
    state.pushers = ["colleague"];
    const later = runtime(github, clock, adapters);
    await pass(later, task.id, clock);
    await until(() => existsSync(file), "the round");
    expect(evidenceOf(file)).toContain("### Review by @colleague (can push to this repository)");
    await until(() => getTask(task.id)?.state === "done", "the round to settle");
  });

  test("Skip marks the batch handled: those words are never sent, newer ones are", async () => {
    const { task, file, adapters } = reviewTask();
    const clock = { now: START + 10 * 60_000 };
    const { state, github } = fakeGitHub({ pr: snapshot({ threads: [thread()] }) });
    const rt = runtime(github, clock, adapters);
    setAutopilot(task.id, { autoFix: true });
    seed(task.id, clock, { idleSince: new Date(START).toISOString(), idleTurn: 1 });
    await pass(rt, task.id, clock);
    expect(autopilotStatus(task.id).pendingFix).not.toBeNull();
    skipPendingFix(task.id);
    clock.now += 5 * 60_000;
    await pass(rt, task.id, clock);
    // skipped means seen, not answered: the open thread is for a person
    expect(autopilotStatus(task.id)).toMatchObject({ reason: "1 review thread still open", pendingFix: null });
    expect(existsSync(file)).toBe(false);
    state.pr = { ...state.pr, threads: [thread({}, [said(), said({ id: "RC_2", body: "And the zero case.", createdAt: new Date(clock.now - 30_000).toISOString() })])] };
    await pass(rt, task.id, clock);
    expect(autopilotStatus(task.id).reason).toBe("Auto-fix will send: 1 review thread");
  });
});
