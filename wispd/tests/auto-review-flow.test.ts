import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BUILTIN_ADAPTERS } from "../src/adapters";
import { attachmentsDirFor } from "../src/attachments";
import type { PrComment, PrSnapshot, PrThread } from "../src/autopilot/github";
import { sendPendingFix, skipPendingFix } from "../src/autopilot/pending-fix";
import { SEND_DELAY_MS } from "../src/autopilot/runtime";
import { autopilotHistory, autopilotRow, autopilotStatus, checkpointOf, pauseAutopilot, resumeAutopilot, setAutopilot, writeAutopilotCheckpoint } from "../src/autopilot/store";
import { LOG_DIR, loadConfig, type RepoConfig } from "../src/config";
import type { NewTaskInput } from "../src/domain/task-create";
import { GitHubPausedError } from "../src/github-budget";
import { publishOutputImage } from "../src/outputs";
import { taskMessageRoute } from "../src/routes/task-messages";
import { createTask, createTurn, db, freeSlot, getTask, messagesFor, newTaskId, setTaskFields, transition } from "../src/store";
import { submitVerdict } from "../src/verify/reviewer";
import { createPanelRound, reviewsOf, supersedeRound, type SupersedeCause } from "../src/verify/reviews";
import { getRound, reviewLedger, roundsOf, UNPRODUCTIVE_LIMIT, type RoundRow } from "../src/verify/rounds";
import { samplePng } from "../scripts/harness/image-output-probe";
import { HEAD, START, capture, created, doneTask, fakeGitHub, forgetTasks, pass, runtime, seed, snapshot, until } from "./autopilot-harness";

afterEach(forgetTasks);

type Checks = PrSnapshot["checks"];
const RUNNING: Checks = [{ name: "test", status: "IN_PROGRESS", conclusion: null, required: true, url: "" }];
const FAILED: Checks = [{ name: "test", status: "COMPLETED", conclusion: "FAILURE", required: true, url: "" }];
const GREEN: Checks = [{ name: "test", status: "COMPLETED", conclusion: "SUCCESS", required: true, url: "" }];
const short = HEAD.slice(0, 7);
const sha = (n: number): string => String(n).repeat(40);

/** A launcher that makes the reviewer's task row the way createAndLaunchTask would, and starts nothing; `gate.refuse` says the slots are full. */
function launcher() {
  const launched: NewTaskInput[] = [];
  const gate = { refuse: false };
  const launch = async (input: NewTaskInput) => {
    if (gate.refuse) return { kind: "at-capacity" as const, error: "all task slots are busy" };
    launched.push(input);
    const id = newTaskId();
    createTask({ id, title: input.prompt, repo_path: input.repoPath, harness: input.harness, model: input.model ?? null, verify_role: input.verifyRole ?? null, slot: freeSlot() });
    created.push(id);
    setTaskFields(id, { worktree_path: `/fixture/${id}`, branch: `wisp/${id}-review` });
    transition(id, "running");
    const task = getTask(id)!;
    input.prepare?.(task);
    return { task, autopilot: autopilotStatus(id) };
  };
  return { launched, launch, gate };
}

interface Options {
  autoFix?: boolean
  autoMerge?: boolean
  repo?: Partial<RepoConfig>
  checks?: Checks
  /** the author's turns run, and write the prompt they were given */
  capture?: boolean
  /** no turn starts (the task has no worktree): a round's message stays queued */
  queued?: boolean
  adapters?: Record<string, unknown>
  checkpoint?: Record<string, unknown>
}

/** An author task on #7 under the default reviewStart ("ready"), auto-fix on unless said otherwise, one reviewer. */
function setup(options: Options = {}) {
  const clock = { now: START + 10 * 60_000 };
  const { state, github } = fakeGitHub({ pr: snapshot({ checks: options.checks ?? GREEN }) });
  const ctl = launcher();
  const turns = options.capture ? capture() : null;
  const task = doneTask(turns ? { harness: "capture" } : {});
  if (turns) setTaskFields(task.id, { worktree_path: turns.dir, turn_count: 1 });
  if (options.queued) setTaskFields(task.id, { worktree_path: null });
  setAutopilot(task.id, { autoMerge: options.autoMerge ?? false, autoFix: options.autoFix ?? true, autoReview: true });
  seed(task.id, clock, { reviewArmedAt: new Date(START).toISOString(), ...options.checkpoint });
  const cfg = { ...loadConfig(), repos: [{ path: "/fixture/repo", verifySecond: "off" as const, ...options.repo }] };
  const rt = runtime(github, clock, turns?.adapters ?? options.adapters ?? {}, cfg, undefined, { launch: ctl.launch as never });
  return { clock, state, github, task, rt, file: turns?.file ?? "", ...ctl };
}

const latest = (taskId: string): RoundRow => roundsOf(taskId)[0]!;
const primary = (round: RoundRow) => reviewsOf(round.id).find((review) => review.role === "primary")!;
const blocker = (title: string) => ({ title, severity: "blocking", lens: "correctness", detail: "Ran it and saw it break", file: "src/app.ts", line: 3 });
function verdict(round: RoundRow, body: Record<string, unknown>) {
  const review = primary(round);
  return submitVerdict(review.reviewer_task_id!, { token: review.token, summary: "Checked it", ...body } as never);
}
const passes = (round: RoundRow) => verdict(round, { verdict: "pass" });
const rejects = (round: RoundRow, title = "The total is wrong") => verdict(round, { verdict: "fail", findings: [blocker(title)] });
const sent = (taskId: string) => messagesFor(taskId).filter((message) => message.origin === "workflow");
const keyOf = (messageId: string): string =>
  (db.query("SELECT event_key FROM workflow_wakes WHERE message_id = ?").get(messageId) as { event_key: string }).event_key;
const said = (at: number, over: Partial<PrComment> = {}): PrComment => ({
  id: "RC_1", author: "owner", association: "OWNER", bot: false, body: "Guard the empty list in `pick()`.",
  createdAt: new Date(at).toISOString(), editedAt: null, url: "https://github.com/o/r/pull/7#discussion_r1", hidden: false, ...over,
});
const thread = (at: number): PrThread => ({
  id: "PRRT_1", resolved: false, outdated: false, path: "src/app.ts", line: 3, starter: { author: "owner", bot: false, body: "Guard the empty list in `pick()`." }, comments: [said(at)],
});
/** A review thread that arrives on the PR, as it stands. */
function comment(state: { pr: PrSnapshot }, at: number, over: Partial<PrSnapshot> = {}) {
  state.pr = { ...state.pr, threads: [thread(at)], unresolvedThreads: 1, ...over };
}
/** A push: the new head, waited out past the fresh-head floor. */
async function push(ctx: ReturnType<typeof setup>, n: number, checks: Checks = GREEN) {
  ctx.state.pr = snapshot({ head: sha(n), checks });
  ctx.clock.now += 5 * 60_000;
  await pass(ctx.rt, ctx.task.id, ctx.clock);
  ctx.clock.now += 3 * 60_000;
  await pass(ctx.rt, ctx.task.id, ctx.clock);
}
/** A round row written directly, as an earlier look (or an older daemon) left it. */
function pastRound(taskId: string, at: number, over: { round: number; state: string; cause?: SupersedeCause; launched?: boolean; head?: string }): RoundRow {
  const { round } = createPanelRound({
    taskId, workflowId: autopilotRow(taskId)!.id, pr: 7, head: over.head ?? sha(9), base: "main", round: over.round, counted: true, recipeVersion: null,
    tier: "standard", signals: null, agents: [{ role: "primary", harness: "fake", model: null, effort: null }],
  }, new Date(at));
  if (over.launched) db.run("UPDATE round_reviews SET launched_at = ? WHERE round_id = ?", [new Date(at).toISOString(), round.id]);
  if (over.state === "superseded") supersedeRound(round.id, "ended", new Date(at), over.cause);
  else if (over.state !== "running") db.run("UPDATE auto_review_rounds SET state = ?, finished_at = ? WHERE id = ?", [over.state, new Date(at).toISOString(), round.id]);
  return getRound(round.id)!;
}

describe("reviewStart \"ready\" (the default)", () => {
  test("a settled head starts its round with its checks still running, and the merge still waits for them", async () => {
    const { clock, state, launched, task, rt } = setup({ autoFix: false, autoMerge: true, checks: RUNNING });
    await pass(rt, task.id, clock);
    expect(launched).toHaveLength(1);
    expect(latest(task.id)).toMatchObject({ round: 1, counted: 1, early: 2, head: HEAD, state: "running" });
    expect(autopilotStatus(task.id).reason).toBe("Auto-review round 1 · 0 of 3 rejections used (started on ready, checks still running): A reviewing");
    expect(autopilotHistory(task.id).some((entry) => entry.detail.startsWith("Round 1 started") && entry.detail.includes(", started on ready, checks still running:"))).toBe(true);
    // no click to offer: the round is under way
    expect(autopilotStatus(task.id).reviewNow).toBeNull();
    passes(latest(task.id));
    transition(primary(latest(task.id)).reviewer_task_id!, "done");
    await pass(rt, task.id, clock);
    expect(latest(task.id).state).toBe("pass");
    expect(state.merges).toHaveLength(0);
    expect(autopilotStatus(task.id)).toMatchObject({ by: "auto-merge", reason: "Waiting for checks (1 running)" });
    state.pr = snapshot({ checks: GREEN });
    await pass(rt, task.id, clock);
    expect(state.merges).toEqual([{ number: 7, method: "SQUASH", head: HEAD }]);
    expect(autopilotHistory(task.id).find((entry) => entry.kind === "merging")?.detail).toContain("auto-review passed (round 1 · 0 of 3 rejections used)");
  });

  test("a red head auto-fix is about to fix is not reviewed: the fix goes first", async () => {
    const { clock, launched, task, rt } = setup({ checks: FAILED });
    await pass(rt, task.id, clock);
    expect(launched).toHaveLength(0);
    expect(autopilotStatus(task.id)).toMatchObject({ by: "auto-fix", pendingFix: { summary: "test failing" } });
  });

  test("a red head auto-fix will not send is reviewed: auto-fix off, or its fix skipped", async () => {
    const off = setup({ autoFix: false, checks: FAILED });
    await pass(off.rt, off.task.id, off.clock);
    expect(off.launched).toHaveLength(1);
    expect(autopilotStatus(off.task.id).reason).toContain("(started on ready, test failed)");

    const skipped = setup({ checks: FAILED });
    await pass(skipped.rt, skipped.task.id, skipped.clock);
    skipPendingFix(skipped.task.id);
    await pass(skipped.rt, skipped.task.id, skipped.clock);
    expect(skipped.launched).toHaveLength(1);
    expect(latest(skipped.task.id)).toMatchObject({ early: 2, state: "running" });
  });

  test("a head still inside the fresh-head floor waits, then starts on its own", async () => {
    const ctx = setup({ autoFix: false, checks: RUNNING, checkpoint: { heads: { [HEAD]: new Date(START + 9 * 60_000).toISOString() } } });
    await pass(ctx.rt, ctx.task.id, ctx.clock);
    expect(ctx.launched).toHaveLength(0);
    // Review now is still offered while it waits
    expect(autopilotStatus(ctx.task.id).reviewNow).toEqual({ head: HEAD, requested: false });
    ctx.clock.now += 2 * 60_000;
    await pass(ctx.rt, ctx.task.id, ctx.clock);
    expect(ctx.launched).toHaveLength(1);
  });

  test("while auto-fix waits on the failing run, the round starts; the CI fix then joins its findings", async () => {
    const LINT_RUNNING: Checks = [
      { name: "lint", status: "COMPLETED", conclusion: "FAILURE", required: true, url: "", run: { id: 5, event: "pull_request" } },
      { name: "build", status: "IN_PROGRESS", conclusion: null, required: false, url: "", run: { id: 5, event: "pull_request" } },
    ];
    const { clock, state, launched, task, rt } = setup({ checks: LINT_RUNNING });
    state.required = ["lint"];
    await pass(rt, task.id, clock);
    expect(launched).toHaveLength(1);
    expect(latest(task.id).early).toBe(2);
  });

  test("\"checks\" keeps waiting for the checks before a round", async () => {
    const { clock, launched, task, rt } = setup({ autoFix: false, checks: RUNNING, repo: { reviewStart: "checks" } });
    await pass(rt, task.id, clock);
    expect(launched).toHaveLength(0);
    expect(autopilotStatus(task.id)).toMatchObject({ reason: "Waiting for checks (1 running) before auto-review", reviewNow: { head: HEAD, requested: false } });
  });
});

describe("a running round is driven first", () => {
  test("a round that waited for its checks keeps going when they turn pending or red: its pending reviewer launches, and it settles", async () => {
    const { clock, state, launched, gate, task, rt } = setup({ autoFix: false, repo: { reviewStart: "checks" } });
    gate.refuse = true;
    await pass(rt, task.id, clock);
    expect(latest(task.id)).toMatchObject({ early: 0, state: "running" });
    expect(primary(latest(task.id)).state).toBe("pending");
    // a rerun, or a bot's own check, starts: checksGate would wait now
    state.pr = snapshot({ checks: RUNNING });
    gate.refuse = false;
    await pass(rt, task.id, clock);
    expect(launched).toHaveLength(1);
    expect(primary(latest(task.id)).state).toBe("running");
    // and a red check would need you: the round still settles
    state.pr = snapshot({ checks: FAILED });
    passes(latest(task.id));
    transition(primary(latest(task.id)).reviewer_task_id!, "done");
    await pass(rt, task.id, clock);
    expect(latest(task.id).state).toBe("pass");
  });
});

describe("auto-fix holds while a round runs", () => {
  test("a review comment during a round is held, not queued; Send now sends it at once", async () => {
    const { clock, state, task, rt } = setup();
    await pass(rt, task.id, clock);
    expect(latest(task.id).state).toBe("running");
    comment(state, clock.now - 5 * 60_000);
    clock.now += SEND_DELAY_MS;
    await pass(rt, task.id, clock);
    expect(autopilotStatus(task.id)).toMatchObject({ state: "waiting", pendingFix: { summary: "1 review thread", afterReview: true } });
    expect(autopilotStatus(task.id).reason).toBe("Auto-review round 1 · 0 of 3 rejections used: A reviewing · Auto-fix will send after the review: 1 review thread");
    clock.now += 10 * 60_000;
    await pass(rt, task.id, clock);
    expect(sent(task.id)).toHaveLength(0);
    sendPendingFix(task.id);
    await pass(rt, task.id, clock);
    expect(sent(task.id)).toHaveLength(1);
    expect(sent(task.id)[0]!.text).toContain("New review feedback on this PR: 1 review thread.");
  });

  test("Skip on a held round skips it", async () => {
    const { clock, state, task, rt } = setup();
    await pass(rt, task.id, clock);
    comment(state, clock.now - 5 * 60_000);
    await pass(rt, task.id, clock);
    expect(autopilotStatus(task.id).pendingFix).toMatchObject({ afterReview: true });
    skipPendingFix(task.id);
    await pass(rt, task.id, clock);
    expect(autopilotStatus(task.id).pendingFix).toBeNull();
    passes(latest(task.id));
    transition(primary(latest(task.id)).reviewer_task_id!, "done");
    await pass(rt, task.id, clock);
    expect(sent(task.id)).toHaveLength(0);
  });

  test("auto-fix at its cap does not pause before the running round settles", async () => {
    const { clock, state, task, rt } = setup({ checkpoint: { rounds: 5 } });
    await pass(rt, task.id, clock);
    comment(state, clock.now - 5 * 60_000);
    await pass(rt, task.id, clock);
    expect(autopilotStatus(task.id)).toMatchObject({ state: "waiting", pendingFix: { afterReview: true } });
    expect(latest(task.id).state).toBe("running");
    passes(latest(task.id));
    transition(primary(latest(task.id)).reviewer_task_id!, "done");
    await pass(rt, task.id, clock);
    expect(latest(task.id).state).toBe("pass");
    expect(autopilotStatus(task.id)).toMatchObject({ state: "paused", reason: "Auto-fix gave up after 5 rounds — resume to try again" });
  });

  test("a round that passes releases the held round with its countdown kept", async () => {
    const { clock, state, task, rt } = setup();
    await pass(rt, task.id, clock);
    comment(state, clock.now);
    await pass(rt, task.id, clock);
    passes(latest(task.id));
    transition(primary(latest(task.id)).reviewer_task_id!, "done");
    await pass(rt, task.id, clock);
    expect(sent(task.id)).toHaveLength(0);
    expect(autopilotStatus(task.id).pendingFix).toEqual({ summary: "1 review thread", sendsAt: new Date(clock.now + SEND_DELAY_MS).toISOString() });
    clock.now += SEND_DELAY_MS;
    await pass(rt, task.id, clock);
    expect(sent(task.id)).toHaveLength(1);
  });

  test("a round that errs, or that a push ends, releases it too", async () => {
    const erred = setup();
    await pass(erred.rt, erred.task.id, erred.clock);
    comment(erred.state, erred.clock.now - 5 * 60_000);
    await pass(erred.rt, erred.task.id, erred.clock);
    db.run("UPDATE round_reviews SET launched_at = ? WHERE round_id = ?", [new Date(erred.clock.now - 3 * 60 * 60_000).toISOString(), latest(erred.task.id).id]);
    erred.clock.now += SEND_DELAY_MS;
    await pass(erred.rt, erred.task.id, erred.clock);
    expect(latest(erred.task.id).state).toBe("error");
    expect(sent(erred.task.id)).toHaveLength(1);

    const pushed = setup({ repo: { reviewStart: "checks" } });
    await pass(pushed.rt, pushed.task.id, pushed.clock);
    comment(pushed.state, pushed.clock.now - 5 * 60_000);
    await pass(pushed.rt, pushed.task.id, pushed.clock);
    const first = latest(pushed.task.id);
    comment(pushed.state, pushed.clock.now - 5 * 60_000, { head: sha(2), checks: RUNNING });
    pushed.clock.now += SEND_DELAY_MS;
    await pass(pushed.rt, pushed.task.id, pushed.clock);
    expect(getRound(first.id)).toMatchObject({ state: "superseded", cause: "head" });
    expect(sent(pushed.task.id)).toHaveLength(1);
  });
});

describe("one message for a rejection and everything auto-fix holds", () => {
  /** A round under way on a head with running checks, then a review thread and red CI held behind it, then a rejection. */
  async function rejected(options: Options = {}) {
    const ctx = setup({ checks: RUNNING, ...options });
    await pass(ctx.rt, ctx.task.id, ctx.clock);
    comment(ctx.state, ctx.clock.now - 60_000, { checks: options.checks === undefined ? FAILED : options.checks });
    await pass(ctx.rt, ctx.task.id, ctx.clock);
    expect(autopilotStatus(ctx.task.id).pendingFix).toMatchObject({ summary: "test failing and 1 review thread", afterReview: true });
    rejects(latest(ctx.task.id));
    ctx.clock.now += SEND_DELAY_MS;
    return ctx;
  }

  test("the findings come first, then CI, then the item, in one message whose key names all three; later looks resend none of it", async () => {
    const ctx = await rejected({ capture: true });
    const { clock, task, rt, file } = ctx;
    await pass(rt, task.id, clock);
    expect(sent(task.id)).toHaveLength(1);
    const message = sent(task.id)[0]!;
    expect(keyOf(message.id)).toMatch(new RegExp(`^ci:${HEAD}:test\\|fb:thread:PRRT_1@[^|]+\\|rv:${latest(task.id).id}$`));
    expect(JSON.parse(message.source_json!)).toEqual({ by: "autopilot", kind: "auto-fix", pr: 7, round: 1, rounds: 5 });
    const text = message.text;
    const at = (words: string) => { const index = text.indexOf(words); expect(index).toBeGreaterThan(-1); return index; };
    expect(at(`Auto-review, round 1 · 1 of 3 rejections used, head ${short}:`)).toBeLessThan(at("CI failed on this PR: test failing."));
    expect(at("CI failed on this PR")).toBeLessThan(at("New review feedback on this PR: 1 review thread."));
    expect(at("New review feedback")).toBeLessThan(at("- Fix everything in one push, once all of it is done."));
    at("- Run the project's local checks (lint, type checks, tests) before you push.");
    at("- For a review comment you disagree with, reply on its thread with your reason instead of changing code.");
    // the review part keeps its own rule for a finding the author thinks wrong
    at("- If a finding is wrong, say why in your final message");
    const findings = text.match(/Read (\S+REVIEW-FEEDBACK\.md)/)![1]!;
    expect(readFileSync(findings, "utf8")).toContain("The total is wrong");
    expect(autopilotHistory(task.id).some((entry) => entry.detail === "Sent auto-review's findings and test failing and 1 review thread (round 1 of 5; auto-review round 1 · 1 of 3 rejections used)")).toBe(true);
    await until(() => existsSync(file) && getTask(task.id)!.state === "done", "the combined round's turn");
    await pass(rt, task.id, clock);
    expect(sent(task.id)).toHaveLength(1);
    // the round started on ready, so auto-review speaks first: both say there is nothing new to send
    expect(autopilotStatus(task.id)).toMatchObject({
      state: "needs-you", reason: "Still rejected after review round 1, with no new push · Still test failing after round 1, with no new push",
    });
  });

  test("a settled rejection that was never sent goes out under \"checks\" too", async () => {
    const { clock, task, rt } = setup({ repo: { reviewStart: "checks" } });
    await pass(rt, task.id, clock);
    rejects(latest(task.id));
    await pass(rt, task.id, clock);
    expect(autopilotStatus(task.id).reason).toBe("Auto-fix will send: auto-review's findings");
    clock.now += SEND_DELAY_MS;
    await pass(rt, task.id, clock);
    expect(sent(task.id)).toHaveLength(1);
    expect(keyOf(sent(task.id)[0]!.id)).toBe(`rv:${latest(task.id).id}`);
  });

  test("a person's cancel restores everything, and none of the three parts goes out again on its own", async () => {
    const { clock, task, rt } = await rejected({ queued: true });
    await pass(rt, task.id, clock);
    const [message] = sent(task.id);
    const path = `/api/tasks/${task.id}/messages/${message!.id}`;
    expect((await taskMessageRoute(new Request(`http://localhost${path}`, { method: "DELETE" }), path, "DELETE"))?.status).toBe(200);
    const checkpoint = checkpointOf(autopilotRow(task.id)!);
    expect(checkpoint).toMatchObject({ skipped: [`ci:${HEAD}:test`], reviewsSent: [latest(task.id).id], delivered: { "thread:PRRT_1": expect.any(String) } });
    expect(checkpoint.rounds).toBeUndefined();
    for (let look = 0; look < 3; look++) {
      clock.now += SEND_DELAY_MS;
      await pass(rt, task.id, clock);
    }
    expect(sent(task.id)).toHaveLength(1);
    expect(autopilotStatus(task.id)).toMatchObject({
      state: "needs-you", reason: "Still rejected after review round 1, with no new push · test failed (auto-fix skipped)",
    });
  });

  test("Wisp's own withdrawal is no person's cancel: the next look plans all three parts together again", async () => {
    const { clock, task, rt } = await rejected({ queued: true });
    await pass(rt, task.id, clock);
    const first = sent(task.id)[0]!;
    const key = keyOf(first.id);
    // the round's turn never started: the next look withdraws it, and the one after plans it afresh
    await pass(rt, task.id, clock);
    expect(messagesFor(task.id).find((message) => message.id === first.id)!.status).toBe("cancelled");
    expect(checkpointOf(autopilotRow(task.id)!).reviewsSent).toBeUndefined();
    await pass(rt, task.id, clock);
    const again = sent(task.id).filter((message) => message.id !== first.id);
    expect(again).toHaveLength(1);
    expect(keyOf(again[0]!.id)).toBe(key);
  });

  test("a GitHub pause while the logs are read leaves no attachments behind; the next look sends them", async () => {
    const REPORTED: Checks = [{ ...FAILED[0]!, checkRunId: 11 }];
    const ctx = setup({ checks: RUNNING, adapters: { fake: BUILTIN_ADAPTERS.cursor } });
    const { clock, state, github, task, rt } = ctx;
    await pass(rt, task.id, clock);
    const review = primary(latest(task.id));
    const turnId = createTurn(review.reviewer_task_id!, 1, "review", null, join(LOG_DIR, `${review.reviewer_task_id}-1.log`), null);
    publishOutputImage(turnId, samplePng(), "page.png", "published");
    rejects(latest(task.id));
    state.pr = snapshot({ checks: REPORTED });
    clock.now += SEND_DELAY_MS;
    const report = github.checkRunReport;
    github.checkRunReport = async () => { throw new GitHubPausedError(clock.now + 60_000, "share"); };
    await pass(rt, task.id, clock);
    expect(autopilotStatus(task.id).reason).toContain("Paused");
    expect(sent(task.id)).toHaveLength(0);
    const stored = join(attachmentsDirFor(task.id), "messages");
    expect(existsSync(stored) ? readdirSync(stored) : []).toEqual([]);
    github.checkRunReport = report;
    clock.now += 2 * 60_000;
    await pass(rt, task.id, clock);
    expect(sent(task.id)).toHaveLength(1);
    expect((JSON.parse(sent(task.id)[0]!.attachments_json ?? "[]") as { name: string }[]).map((file) => file.name)).toEqual(["page.png"]);
  });

  test("with auto-fix at its cap, the findings go alone, and only then may auto-fix pause", async () => {
    const { clock, state, task, rt, file } = setup({ capture: true, checkpoint: { rounds: 5 } });
    await pass(rt, task.id, clock);
    rejects(latest(task.id));
    await pass(rt, task.id, clock);
    expect(sent(task.id)).toHaveLength(1);
    const bounced = sent(task.id)[0]!;
    expect(keyOf(bounced.id)).toBe(`review:${latest(task.id).id}`);
    expect(JSON.parse(bounced.source_json!)).toEqual({ by: "autopilot", kind: "auto-review", pr: 7, round: 1, rounds: null });
    expect(bounced.text).toContain(`[Wisp auto-review · PR #7 · round 1 · 1 of 3 rejections used · head ${short}]`);
    expect(autopilotRow(task.id)!.state).toBe("active");
    await until(() => existsSync(file) && getTask(task.id)!.state === "done", "the findings' turn");
    comment(state, clock.now - 5 * 60_000);
    await pass(rt, task.id, clock);
    expect(autopilotStatus(task.id)).toMatchObject({ state: "paused", reason: "Auto-fix gave up after 5 rounds — resume to try again" });
  });
});

describe("only a rejection spends the review budget", () => {
  test("two rounds a push ended and two passes spend nothing: the pause comes after the third rejection, and the numbers go on", async () => {
    const ctx = setup({ autoFix: false });
    const { clock, task, rt } = ctx;
    await pass(rt, task.id, clock);
    await push(ctx, 2);
    await push(ctx, 3);
    passes(latest(task.id));
    await pass(rt, task.id, clock);
    await push(ctx, 4);
    passes(latest(task.id));
    await pass(rt, task.id, clock);
    for (const n of [5, 6, 7]) {
      await push(ctx, n);
      rejects(latest(task.id), `bug ${n}`);
      await pass(rt, task.id, clock);
    }
    expect(roundsOf(task.id).map((round) => [round.round, round.state]).reverse()).toEqual([
      [1, "superseded"], [2, "superseded"], [3, "pass"], [4, "pass"], [5, "fail"], [6, "fail"], [7, "fail"],
    ]);
    expect(autopilotStatus(task.id)).toMatchObject({ state: "needs-you", reviewRounds: 7, reviewSpent: 3, reviewBudget: 3 });
    await push(ctx, 8);
    expect(autopilotStatus(task.id)).toMatchObject({ state: "paused", reason: "Auto-review did not pass after 3 rounds — resume to try again" });
    expect(roundsOf(task.id)).toHaveLength(7);
    resumeAutopilot(task.id, new Date(clock.now));
    await pass(rt, task.id, clock);
    expect(latest(task.id)).toMatchObject({ round: 8, head: sha(8) });
    expect(autopilotStatus(task.id)).toMatchObject({ reviewSpent: 0 });
  });

  test("a Resume re-run of a rejection is free; an error followed by a rejecting re-run costs one", async () => {
    const rerun = setup({ autoFix: false });
    await pass(rerun.rt, rerun.task.id, rerun.clock);
    rejects(latest(rerun.task.id));
    await pass(rerun.rt, rerun.task.id, rerun.clock);
    resumeAutopilot(rerun.task.id, new Date(rerun.clock.now));
    await pass(rerun.rt, rerun.task.id, rerun.clock);
    expect(latest(rerun.task.id)).toMatchObject({ round: 1, counted: 0, state: "running" });
    rejects(latest(rerun.task.id));
    await pass(rerun.rt, rerun.task.id, rerun.clock);
    expect(autopilotStatus(rerun.task.id)).toMatchObject({ state: "needs-you", reviewSpent: 1 });

    const erred = setup({ autoFix: false });
    await pass(erred.rt, erred.task.id, erred.clock);
    db.run("UPDATE round_reviews SET launched_at = ? WHERE round_id = ?", [new Date(erred.clock.now - 3 * 60 * 60_000).toISOString(), latest(erred.task.id).id]);
    await pass(erred.rt, erred.task.id, erred.clock);
    expect(autopilotStatus(erred.task.id)).toMatchObject({ state: "needs-you", reviewSpent: 0 });
    resumeAutopilot(erred.task.id, new Date(erred.clock.now));
    await pass(erred.rt, erred.task.id, erred.clock);
    rejects(latest(erred.task.id));
    await pass(erred.rt, erred.task.id, erred.clock);
    expect(autopilotStatus(erred.task.id)).toMatchObject({ state: "needs-you", reviewRounds: 1, reviewSpent: 1 });
  });

  test("an upgraded active row gains back what pushed-over and passed rounds had spent; a paused one stays paused", async () => {
    const legacy = (taskId: string) => {
      // an older daemon's rows: a superseded round has no cause, and its checkpoint counted three rounds
      pastRound(taskId, START + 1000, { round: 1, state: "superseded", launched: true, head: sha(1) });
      db.run("UPDATE auto_review_rounds SET cause = NULL WHERE task_id = ? AND round = 1", [taskId]);
      pastRound(taskId, START + 2000, { round: 2, state: "pass", head: sha(2) });
      pastRound(taskId, START + 3000, { round: 3, state: "fail", head: sha(3) });
      const row = autopilotRow(taskId)!;
      writeAutopilotCheckpoint(row, { ...checkpointOf(row), reviewRounds: 3 }, new Date(START + 4000));
    };
    const active = setup({ autoFix: false });
    legacy(active.task.id);
    await pass(active.rt, active.task.id, active.clock);
    expect(checkpointOf(autopilotRow(active.task.id)!).reviewBase).toBeUndefined();
    expect(latest(active.task.id)).toMatchObject({ round: 4, head: HEAD, state: "running" });
    expect(autopilotStatus(active.task.id)).toMatchObject({ reviewRounds: 4, reviewSpent: 1 });

    const paused = setup({ autoFix: false });
    legacy(paused.task.id);
    pauseAutopilot(autopilotRow(paused.task.id)!, "Auto-review did not pass after 3 rounds — resume to try again", new Date(paused.clock.now));
    await pass(paused.rt, paused.task.id, paused.clock);
    expect(paused.launched).toHaveLength(0);
    expect(autopilotRow(paused.task.id)!.state).toBe("paused");
  });
});

describe("rounds that end without a verdict are bounded", () => {
  test("launched rounds a push or retarget ended, errors and recipe holds count; a switch-off does not", () => {
    const task = doneTask();
    setAutopilot(task.id, { autoReview: true });
    const workflow = autopilotRow(task.id)!.id;
    const since = new Date(START).toISOString();
    let at = START + 1000;
    const add = (round: number, state: string, cause?: SupersedeCause, launched = true) => pastRound(task.id, at += 1000, { round, state, cause, launched });
    add(1, "superseded", "head");
    add(2, "superseded", "base");
    add(3, "superseded", "head", false);
    add(4, "superseded", "off");
    add(5, "error");
    add(6, "error");
    add(7, "recipe");
    expect(reviewLedger(workflow, 7, since)).toEqual({ highest: 7, spent: 0, unproductive: 5 });
    add(8, "superseded", "head");
    expect(reviewLedger(workflow, 7, since).unproductive).toBe(UNPRODUCTIVE_LIMIT);
    // past the limit, each further one spends, above the budget's base
    add(9, "error");
    expect(reviewLedger(workflow, 7, since)).toEqual({ highest: 9, spent: 1, unproductive: UNPRODUCTIVE_LIMIT + 1 });
    expect(reviewLedger(workflow, 7, since, 9).spent).toBe(0);
  });

  test("at the limit the PR's rounds wait for its checks, with a note, and Resume does not undo that", async () => {
    const { clock, launched, task, rt } = setup({ autoFix: false, checks: RUNNING });
    for (let n = 1; n <= UNPRODUCTIVE_LIMIT; n++) pastRound(task.id, START + n * 1000, { round: n, state: n % 2 ? "error" : "superseded", cause: "head", launched: true });
    await pass(rt, task.id, clock);
    expect(launched).toHaveLength(0);
    expect(autopilotStatus(task.id).reason).toBe("Waiting for checks (1 running) before auto-review");
    const note = `PR #7: ${UNPRODUCTIVE_LIMIT} auto-review rounds ended without a verdict, so its rounds now wait for its checks`;
    expect(autopilotHistory(task.id).filter((entry) => entry.detail === note)).toHaveLength(1);
    resumeAutopilot(task.id, new Date(clock.now));
    await pass(rt, task.id, clock);
    expect(launched).toHaveLength(0);
    expect(autopilotHistory(task.id).filter((entry) => entry.detail === note)).toHaveLength(1);
  });

  test("a recipe hold on this PR starts no round on ready", async () => {
    const { clock, launched, task, rt } = setup({ autoFix: false, checks: RUNNING });
    pastRound(task.id, START + 1000, { round: 1, state: "recipe", launched: true });
    await pass(rt, task.id, clock);
    expect(launched).toHaveLength(0);
    expect(autopilotStatus(task.id).reason).toBe("Waiting for checks (1 running) before auto-review");
  });
});
