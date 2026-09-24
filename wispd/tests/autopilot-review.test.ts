import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import type { PrComment, PrReview, PrThread } from "../src/autopilot/github";
import { autopilotRow, autopilotStatus, checkpointOf, noteTurnSigning, reserveRound, setAutopilot, skipPendingFix } from "../src/autopilot/store";
import { taskMessageRoute } from "../src/routes/task-messages";
import { startNextQueuedMessage } from "../src/runner";
import { loadConfig } from "../src/config";
import { db, getTask, setTaskFields } from "../src/store";
import { judgeLogPath } from "../src/autopilot/judge";
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
    // nothing new to send; the thread is still open, but this repository does not require it resolved
    await pass(rt, task.id, clock);
    expect(autopilotStatus(task.id)).toMatchObject({ fixRounds: 1, state: "waiting", reason: "Nothing to fix" });
    // where it does, an open conversation is for a person
    state.pr = { ...state.pr, conversationRule: "required", unresolvedThreads: 1 };
    await pass(rt, task.id, clock);
    expect(autopilotStatus(task.id)).toMatchObject({ state: "needs-you", reason: "1 unresolved conversation" });
    // where the rule cannot be read, GitHub blocking the PR says the same
    state.pr = { ...state.pr, conversationRule: "unknown", mergeState: "BLOCKED" };
    await pass(rt, task.id, clock);
    expect(autopilotStatus(task.id)).toMatchObject({ state: "needs-you", reason: "1 unresolved conversation", done: false });
    // but a branch with no classic protection at all, only a ruleset that does not ask for it, is not blocked on them
    // (branch rules are cached ten minutes, so a new runtime reads them afresh)
    state.classicProtection = false;
    await pass(runtime(github, clock, adapters), task.id, clock);
    expect(autopilotStatus(task.id)).toMatchObject({ state: "waiting", reason: "Nothing to fix" });
    state.classicProtection = true;
    state.pr = { ...state.pr, conversationRule: "not-required", mergeState: "CLEAN", unresolvedThreads: 0 };
    // a new reply on the thread is new feedback, and gets its own settle time
    clock.now += 5 * 60_000;
    state.pr = { ...state.pr, threads: [thread({}, [said(), said({ id: "RC_2", body: "Still wrong for 0.", createdAt: new Date(clock.now - 30_000).toISOString() })])] };
    await pass(rt, task.id, clock);
    expect(autopilotStatus(task.id).reason).toBe("Auto-fix will send: 1 review thread");
  });

  test("an open conversation holds the merge only where the repository requires it resolved", async () => {
    const { task, adapters } = reviewTask();
    const clock = { now: START + 10 * 60_000 };
    // the agent answered the thread; a colleague has not resolved it
    const open = { threads: [thread({ id: "PRRT_9" }, [said({ author: "colleague", association: "MEMBER", createdAt: "2026-09-23T11:00:00Z" })])], unresolvedThreads: 1 };
    const { state, github } = fakeGitHub({ pr: snapshot({ ...open, mergeState: "BLOCKED", conversationRule: "required" }) });
    const rt = runtime(github, clock, adapters);
    setAutopilot(task.id, { autoMerge: true, autoFix: true });
    seed(task.id, clock, { idleSince: new Date(START).toISOString(), idleTurn: 1, delivered: { "thread:PRRT_9": "2026-09-23T11:00:00Z" } });
    await pass(rt, task.id, clock);
    expect(autopilotStatus(task.id)).toMatchObject({ state: "needs-you", reason: "1 unresolved conversation" });
    expect(state.merges).toHaveLength(0);
    // a repository that does not require it: GitHub says mergeable, and Wisp merges
    state.pr = snapshot({ ...open, mergeState: "CLEAN", conversationRule: "not-required" });
    await pass(rt, task.id, clock);
    expect(state.merges).toHaveLength(1);
  });

  describe("with the review judge", () => {
    const summaryBody = "## Summary\n\n| Severity | Count |\n|---|---|\n| 🟡 Medium | 1 |\n\nGuard the empty list in `pick()`.";
    const summary = (over: Partial<PrComment> = {}): PrComment => said({ id: "IC_5", author: "pr-reviewer", association: "NONE", bot: true, body: summaryBody, createdAt: "2026-09-23T11:00:00Z", ...over });
    const reviewer = { name: "pr-reviewer", status: "COMPLETED", conclusion: "SUCCESS", required: false, url: "https://ci/pr-reviewer", app: "pr-reviewer" };
    function judge(kind: "needs_changes" | "all_clear" | "error" = "needs_changes") {
      const asked: string[] = [];
      const client = async (request: { text: string }) => {
        asked.push(request.text);
        if (kind === "error") throw new Error("Jev answered HTTP 529");
        return { kind, confidence: 0.96, probabilities: { [kind]: 0.96 }, model: "jev-1.13.0", inputTokens: 700 };
      };
      return { asked, client };
    }

    test("a bot's summary it reads as needing changes is a round before any merge, logged, and asked about once", async () => {
      const { task, file, adapters } = reviewTask();
      const clock = { now: START + 10 * 60_000 };
      const { state, github } = fakeGitHub({ pr: snapshot({ comments: [summary()], checks: [...snapshot().checks, reviewer] }) });
      const { asked, client } = judge();
      const rt = runtime(github, clock, adapters, undefined, undefined, { judge: client });
      setAutopilot(task.id, { autoMerge: true, autoFix: true });
      seed(task.id, clock, { idleSince: new Date(START).toISOString(), idleTurn: 1 });
      await pass(rt, task.id, clock);
      await until(() => existsSync(file), "the round");
      expect(state.merges).toHaveLength(0);
      expect(asked).toEqual([summaryBody]);
      expect(readFileSync(file, "utf8")).toContain("New review feedback on this PR: 1 comment.");
      const evidence = evidenceOf(file);
      expect(evidence).toContain("Wisp's review judge (jev-1.13.0) read this as asking for changes (confidence 0.96).");
      expect(evidence).toContain("Guard the empty list in `pick()`.");
      const row = autopilotRow(task.id)!;
      const log = readFileSync(judgeLogPath(task.id, row.id), "utf8").trim().split("\n").map((line) => JSON.parse(line));
      expect(log).toMatchObject([{ pr: 7, item: "comment:IC_5", text: summaryBody, answer: { kind: "needs_changes", confidence: 0.96 }, inputTokens: 700 }]);
      expect(db.query("SELECT detail FROM workflow_history WHERE workflow_id = ? AND kind = 'judged'").all(row.id)).toEqual([{ detail: "@pr-reviewer's comment: needs changes (0.96)" }]);
      await until(() => getTask(task.id)?.state === "done", "the round to settle");
      // the same version is never asked about again
      await pass(rt, task.id, clock);
      expect(asked).toHaveLength(1);
    });

    test("auto-merge alone: a problem about this head needs you; one about an earlier head waits for the bot's next pass", async () => {
      const { task, adapters } = reviewTask();
      const clock = { now: START + 10 * 60_000 };
      // a bot with no check of its own: only its words say whether it has looked at this head
      const checks = snapshot().checks;
      // written after this head was committed: it is about this head
      const { state, github } = fakeGitHub({ pr: snapshot({ comments: [summary({ createdAt: "2026-09-23T11:55:00Z" })], checks, headCommittedAt: "2026-09-23T11:50:00Z" }) });
      const rt = runtime(github, clock, adapters, undefined, undefined, { judge: judge().client });
      setAutopilot(task.id, { autoMerge: true });
      seed(task.id, clock, { idleSince: new Date(START).toISOString(), idleTurn: 1 });
      await pass(rt, task.id, clock);
      expect(autopilotStatus(task.id)).toMatchObject({ state: "needs-you", reason: `@pr-reviewer reported problems on ${HEAD.slice(0, 7)}` });
      // a summary written before this head was committed describes an earlier one: the bot's pass on this head is awaited
      state.pr = snapshot({ comments: [summary({ createdAt: "2026-09-23T11:40:00Z" })], checks, headCommittedAt: "2026-09-23T11:50:00Z" });
      await pass(rt, task.id, clock);
      expect(autopilotStatus(task.id)).toMatchObject({ state: "waiting", reason: `Waiting for @pr-reviewer to review ${HEAD.slice(0, 7)}` });
      expect(state.merges).toHaveLength(0);
      // its pass on this head can be an approval with no words for the judge: that ends the wait too
      state.pr = { ...state.pr, reviews: [{ id: "PRR_9", author: "pr-reviewer", association: "NONE", bot: true, state: "APPROVED", body: "", commit: HEAD, submittedAt: "2026-09-23T12:01:00Z", editedAt: null, url: "https://gh/r/9" }] };
      await pass(rt, task.id, clock);
      expect(state.merges).toHaveLength(1);
    });

    test("an edited summary is the bot's next pass", async () => {
      const { task, adapters } = reviewTask();
      const clock = { now: START + 10 * 60_000 };
      // a bot with no check of its own: only its words say whether it has looked at this head
      const checks = snapshot().checks;
      const { state, github } = fakeGitHub({ pr: snapshot({ comments: [summary({ createdAt: "2026-09-23T11:40:00Z" })], checks, headCommittedAt: "2026-09-23T11:50:00Z" }) });
      let kind: "needs_changes" | "all_clear" = "needs_changes";
      const rt = runtime(github, clock, adapters, undefined, undefined, { judge: async () => ({ kind, confidence: 0.96, probabilities: {}, model: "jev-1.13.0", inputTokens: 700 }) });
      setAutopilot(task.id, { autoMerge: true });
      seed(task.id, clock, { idleSince: new Date(START).toISOString(), idleTurn: 1 });
      await pass(rt, task.id, clock);
      expect(autopilotStatus(task.id).reason).toBe(`Waiting for @pr-reviewer to review ${HEAD.slice(0, 7)}`);
      kind = "all_clear";
      state.pr = snapshot({ comments: [summary({ createdAt: "2026-09-23T11:40:00Z", editedAt: "2026-09-23T11:58:00Z", body: "## Summary\n\nNo issues found." })], checks, headCommittedAt: "2026-09-23T11:50:00Z" });
      await pass(rt, task.id, clock);
      expect(state.merges).toHaveLength(1);
    });

    test("a judge that keeps failing holds the merge a few looks, then stops waiting and says so", async () => {
      const { task, adapters } = reviewTask();
      const clock = { now: START + 10 * 60_000 };
      const { state, github } = fakeGitHub({ pr: snapshot({ comments: [summary({ createdAt: "2026-09-23T11:55:00Z" })], checks: [...snapshot().checks, reviewer] }) });
      const rt = runtime(github, clock, adapters, undefined, undefined, { judge: judge("error").client });
      setAutopilot(task.id, { autoMerge: true, autoFix: true });
      seed(task.id, clock, { idleSince: new Date(START).toISOString(), idleTurn: 1 });
      await pass(rt, task.id, clock);
      expect(autopilotStatus(task.id)).toMatchObject({ state: "waiting", reason: "Waiting for the review judge" });
      expect(state.merges).toHaveLength(0);
      for (let look = 0; look < 4 && state.merges.length === 0; look++) {
        // past each backoff: 1, then 2 minutes
        clock.now += 5 * 60_000;
        await pass(rt, task.id, clock);
      }
      expect(state.merges).toHaveLength(1);
      const row = autopilotRow(task.id)!;
      expect(db.query("SELECT kind FROM workflow_history WHERE workflow_id = ? AND kind = 'judge-unavailable'").all(row.id)).toHaveLength(1);
      const log = readFileSync(judgeLogPath(task.id, row.id), "utf8").trim().split("\n").map((line) => JSON.parse(line));
      expect(log).toHaveLength(3);
      expect(log[0]).toMatchObject({ item: "comment:IC_5", error: "Jev answered HTTP 529" });
    });

    test("an approval that lists findings is one round before the merge, and the approval still merges it", async () => {
      const { task, file, adapters } = reviewTask();
      const clock = { now: START + 10 * 60_000 };
      const body = "Verdict: APPROVE — no blocking findings.\n\n1. **Non-blocking** — the download is not cancelled with the request.\n2. **Non-blocking** — a dropped queued request is still decoded.";
      const approval: PrReview = { ...blocking, id: "PRR_A", body, submittedAt: "2026-09-23T11:30:00Z" };
      const { state, github } = fakeGitHub({ pr: snapshot({ reviews: [approval] }) });
      const questions: string[] = [];
      const rt = runtime(github, clock, adapters, undefined, undefined, {
        judge: async (request) => {
          questions.push(request.question ?? "kind");
          return { kind: request.question === "findings" ? "several_findings" : "all_clear", confidence: 0.99, probabilities: {}, model: "jev-1.13.0", inputTokens: 600 };
        },
      });
      setAutopilot(task.id, { autoMerge: true, autoFix: true });
      seed(task.id, clock, { idleSince: new Date(START).toISOString(), idleTurn: 1 });
      await pass(rt, task.id, clock);
      await until(() => existsSync(file), "the round");
      expect(questions).toEqual(["findings"]);
      expect(state.merges).toHaveLength(0);
      expect(readFileSync(file, "utf8")).toContain("New review feedback on this PR: 1 approval with notes.");
      const evidence = evidenceOf(file);
      expect(evidence).toContain("The reviewer approved this PR, and the approval still counts: the merge does not wait on these notes.");
      expect(evidence).toContain("a dropped queued request is still decoded");
      await until(() => getTask(task.id)?.state === "done", "the round to settle");
      // one round: the notes were delivered, and the approval merges it
      await pass(rt, task.id, clock);
      expect(state.merges).toHaveLength(1);
      expect(questions).toEqual(["findings"]);
    });

    test("with auto-merge alone, an approval is never sent to the judge: its notes could not become a round", async () => {
      const { task, adapters } = reviewTask();
      const clock = { now: START + 10 * 60_000 };
      const approval: PrReview = { ...blocking, id: "PRR_A", body: "Verdict: APPROVE — no blocking findings.\n\n1. Non-blocking — a gap.", submittedAt: "2026-09-23T11:30:00Z" };
      const { state, github } = fakeGitHub({ pr: snapshot({ reviews: [approval] }) });
      const asked: string[] = [];
      const rt = runtime(github, clock, adapters, undefined, undefined, { judge: async (request) => { asked.push(request.question ?? "kind"); return { kind: "several_findings", confidence: 1, probabilities: {}, model: "jev-1.13.0", inputTokens: 1 }; } });
      setAutopilot(task.id, { autoMerge: true });
      seed(task.id, clock, { idleSince: new Date(START).toISOString(), idleTurn: 1 });
      await pass(rt, task.id, clock);
      expect(asked).toEqual([]);
      expect(state.merges).toHaveLength(1);
    });

    test("with the key removed, stored answers no longer count", async () => {
      const { task, adapters } = reviewTask();
      const clock = { now: START + 10 * 60_000 };
      // about this head: a stored answer still counting would hold the merge and send a round
      const comment = summary({ createdAt: "2026-09-23T11:55:00Z" });
      const { state, github } = fakeGitHub({ pr: snapshot({ comments: [comment], checks: [...snapshot().checks, reviewer], headCommittedAt: "2026-09-23T11:50:00Z" }) });
      setAutopilot(task.id, { autoMerge: true, autoFix: true });
      seed(task.id, clock, { idleSince: new Date(START).toISOString(), idleTurn: 1, judged: { "comment:IC_5": { fp: comment.createdAt, kind: "needs_changes", confidence: 0.99, model: "jev-1.13.0" } } });
      // no judge and no key: the summary is a status board, as it always was
      await pass(runtime(github, clock, adapters), task.id, clock);
      expect(state.merges).toHaveLength(1);
      expect(autopilotStatus(task.id).fixRounds ?? 0).toBe(0);
    });
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
    // skipped means seen: nothing new to send (and this repository does not require the thread resolved)
    expect(autopilotStatus(task.id)).toMatchObject({ reason: "Nothing to fix", pendingFix: null });
    expect(existsSync(file)).toBe(false);
    state.pr = { ...state.pr, threads: [thread({}, [said(), said({ id: "RC_2", body: "And the zero case.", createdAt: new Date(clock.now - 30_000).toISOString() })])] };
    await pass(rt, task.id, clock);
    expect(autopilotStatus(task.id).reason).toBe("Auto-fix will send: 1 review thread");
  });
});
