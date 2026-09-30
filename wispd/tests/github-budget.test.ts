import { afterEach, describe, expect, test } from "bun:test";
import type { ProbeSpawnFn } from "../src/adapters";
import { nextDelay } from "../src/autopilot/cadence";
import { createGhAutopilot, SNAPSHOT, snapshotsQuery, type AutopilotGitHub } from "../src/autopilot/github";
import { MOVING_MS, WAITING_ON_YOU_MS } from "../src/autopilot/runtime";
import { autopilotRow, autopilotStatus, checkpointOf, setAutopilot, writeAutopilotCheckpoint } from "../src/autopilot/store";
import { loadConfig } from "../src/config";
import { githubBudgetCheck } from "../src/doctor-background";
import { clockTime, ghReply, GitHubBudget, GitHubPausedError, limitSignal, MERGE_POINTS, WISP_SHARE } from "../src/github-budget";
import { PullRequestCache } from "../src/pull-requests";
import { db } from "../src/store";
import type { Task } from "../src/types";
import { doneTask, forgetTasks, fakeGitHub, HEAD, pass, runtime, seed, snapshot, START } from "./autopilot-harness";
import { fakeGh, graphqlCost } from "./github-fake";

afterEach(forgetTasks);

const HOUR = 60 * 60_000;
const included = (status: number, headers: Record<string, string>, body: unknown) =>
  `HTTP/2.0 ${status} X\n${Object.entries(headers).map(([name, value]) => `${name}: ${value}\r\n`).join("")}\r\n${JSON.stringify(body)}`;
const running = (number: number) => snapshot({
  number, url: `https://github.com/o/r/pull/${number}`,
  checks: [{ name: "test", status: "IN_PROGRESS", conclusion: null, required: true, url: "" }],
});

/** Armed tasks bound to PRs `first`, `first + 1`, …, all due now. */
function armed(count: number, first: number, clock: { now: number }): Task[] {
  const tasks = Array.from({ length: count }, (_, index) => {
    const task = doneTask();
    setAutopilot(task.id, { autoMerge: true }, new Date(clock.now));
    seed(task.id, clock, { pr: first + index });
    return task;
  });
  dueNow(tasks, clock);
  return tasks;
}

function dueNow(tasks: Task[], clock: { now: number }): void {
  for (const task of tasks) {
    db.run("UPDATE workflows SET next_check_at = ? WHERE task_id = ? AND type = 'pr-autopilot' AND state != 'completed'", [new Date(clock.now).toISOString(), task.id]);
  }
}

function setup(clock: { now: number }, client?: (github: AutopilotGitHub) => AutopilotGitHub) {
  const budget = new GitHubBudget(() => clock.now);
  const gh = fakeGh({ clock, pr: running });
  const real = createGhAutopilot({ run: gh.run, budget });
  const github = client ? client(real) : real;
  return { budget, gh, rt: runtime(github, clock, {}, loadConfig(), undefined, { budget }) };
}

describe("reading GitHub's answers", () => {
  test("gh api --include splits into status, headers and JSON, and plain output stays a body", () => {
    const reply = ghReply(included(200, { "X-Ratelimit-Remaining": "4990", "X-Ratelimit-Resource": "graphql" }, { data: { ok: 1 } }), "", false);
    expect(reply.status).toBe(200);
    expect(reply.headers.get("x-ratelimit-remaining")).toBe("4990");
    expect(reply.json).toEqual({ data: { ok: 1 } });
    expect(ghReply('{"a":1}', "", false)).toMatchObject({ status: null, json: { a: 1 } });
  });

  test("primary and secondary limits are told apart, and a permission 403 is not a limit", () => {
    const now = START;
    const refused = (status: number, headers: Record<string, string>, message: string) =>
      limitSignal(ghReply(included(status, headers, { message }), `gh: ${message} (HTTP ${status})`, true), now);
    const reset = String(Math.floor((now + 30 * 60_000) / 1000));
    expect(refused(403, { "Retry-After": "90" }, "You have exceeded a secondary rate limit")).toEqual({ kind: "secondary", until: now + 90_000 });
    expect(refused(403, {}, "You have exceeded a secondary rate limit")).toEqual({ kind: "secondary", until: null });
    expect(refused(429, {}, "Too many requests")).toEqual({ kind: "secondary", until: null });
    expect(refused(403, { "X-Ratelimit-Remaining": "0", "X-Ratelimit-Reset": reset }, "API rate limit exceeded for user ID 1.")).toEqual({ kind: "primary", until: now + 30 * 60_000 });
    const graphql = ghReply(included(200, {}, { errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }] }), "gh: API rate limit exceeded", true);
    expect(limitSignal(graphql, now)?.kind).toBe("primary");
    expect(refused(403, { "X-Ratelimit-Remaining": "4000" }, "Resource not accessible by integration")).toBeNull();
    // a call that succeeded is never a limit, whatever its body says
    expect(limitSignal(ghReply(included(200, {}, { message: "rate limit exceeded" }), "", false), now)).toBeNull();
  });

  test("the fake prices a snapshot as GitHub does: 2 points alone, 10 for a batch of five", () => {
    // 2 points is what rateLimit(dryRun: true) reported for the snapshot on a real PR
    expect(graphqlCost(SNAPSHOT)).toBe(2);
    expect(graphqlCost(snapshotsQuery([1, 2, 3, 4, 5]))).toBe(10);
  });
});

describe("the budget", () => {
  test("Wisp's own spend is capped at a quarter of the hourly limit over a rolling hour", () => {
    const clock = { now: START };
    const budget = new GitHubBudget(() => clock.now);
    const spend = (cost: number) => budget.settle("graphql", ghReply(included(200, {}, { data: { rateLimit: { cost, remaining: 4000, limit: 5000, resetAt: new Date(clock.now + HOUR).toISOString() } } }), "", false), 0);
    spend(600);
    expect(budget.stretch()).toBe(1);
    clock.now += 10 * 60_000;
    spend(338); // 938 of 1250: three quarters of the share, so waits are twice as long
    expect(budget.stretch()).toBeCloseTo(2, 1);
    spend(312);
    expect(() => budget.reserve("graphql", 1)).toThrow(`Paused: Wisp's share of the GitHub rate limit is used up, resumes ${clockTime(START + HOUR)}`);
    expect(budget.reserve("core", 1)).toBeUndefined();
    // the first spend ages out an hour after it was made
    clock.now = START + HOUR + 1;
    expect(budget.isOpen("graphql")).toBe(true);
  });

  test("less than a fifth of the limit left, whoever spent it, slows Wisp down in proportion", () => {
    const clock = { now: START };
    const budget = new GitHubBudget(() => clock.now);
    const headers = (remaining: number) => ({ "X-Ratelimit-Limit": "5000", "X-Ratelimit-Remaining": String(remaining), "X-Ratelimit-Reset": String(Math.floor((START + HOUR) / 1000)), "X-Ratelimit-Resource": "core" });
    budget.settle("core", ghReply(included(200, headers(2000), {}), "", false), 0);
    expect(budget.stretch()).toBe(1);
    budget.settle("core", ghReply(included(200, headers(500), {}), "", false), 0);
    expect(budget.stretch()).toBeCloseTo(2, 5);
    // nothing left: no REST call goes out until the reset, and GraphQL, a limit of its own, carries on
    budget.settle("core", ghReply(included(200, headers(0), {}), "", false), 0);
    expect(() => budget.reserve("core", 1)).toThrow(`Paused: GitHub rate limit, resumes ${clockTime(START + HOUR)}`);
    expect(budget.isOpen("graphql")).toBe(true);
    expect(budget.report().resources.map((entry) => entry.paused?.why ?? null)).toEqual([null, "primary"]);
    clock.now = START + HOUR;
    expect(budget.isOpen("core")).toBe(true);
    expect(budget.stretch()).toBe(1);
  });

  test("a secondary limit stops both limits, and every pause is bounded whatever GitHub's numbers say", () => {
    const clock = { now: START };
    const budget = new GitHubBudget(() => clock.now);
    const refuse = (resource: "graphql" | "core", status: number, headers: Record<string, string>, message: string) => {
      try {
        budget.settle(resource, ghReply(included(status, headers, { message }), `gh: ${message} (HTTP ${status})`, true), 0);
      } catch (error) {
        return error as { until: number; why: string; sent: boolean };
      }
      throw new Error("expected a pause");
    };
    // retry-after 0 would retry at once: a secondary pause lasts at least a minute, on both limits
    expect(refuse("core", 403, { "Retry-After": "0" }, "You have exceeded a secondary rate limit")).toMatchObject({ until: START + 60_000, why: "secondary", sent: true });
    expect(budget.isOpen("graphql")).toBe(false);
    clock.now = START + 60_000;
    expect(budget.isOpen("graphql")).toBe(true);
    // ten days of retry-after is fifteen minutes
    expect(refuse("graphql", 429, { "Retry-After": "864000" }, "Too many requests").until).toBe(clock.now + 15 * 60_000);
    clock.now += 15 * 60_000;
    expect(budget.isOpen("core")).toBe(true);
    // a reset a day away (a skewed clock) pauses an hour, then the limit is read again; one already past, a minute
    const tomorrow = String(Math.floor((clock.now + 24 * HOUR) / 1000));
    expect(refuse("graphql", 403, { "X-Ratelimit-Remaining": "0", "X-Ratelimit-Reset": tomorrow }, "API rate limit exceeded").until).toBe(clock.now + HOUR);
    const yesterday = String(Math.floor((clock.now - 24 * HOUR) / 1000));
    expect(refuse("core", 403, { "X-Ratelimit-Remaining": "0", "X-Ratelimit-Reset": yesterday }, "API rate limit exceeded").until).toBe(clock.now + 60_000);
    clock.now += HOUR;
    expect(budget.isOpen("graphql") && budget.isOpen("core")).toBe(true);
  });

  test("a patient wait doubles from a minute up to its cap, and any other look starts it over", () => {
    const patient = (previous?: { key: string; looks: number }, key = "k") => nextDelay({ delayMs: WAITING_ON_YOU_MS, patient: true, key, previous, stretch: 1 });
    const delays: number[] = [];
    let previous: { key: string; looks: number } | undefined;
    for (let look = 0; look < 5; look++) {
      const next = patient(previous);
      delays.push(next.delayMs);
      previous = next.backoff;
    }
    expect(delays).toEqual([60_000, 120_000, 240_000, 300_000, 300_000]);
    // a rerun or a round (not patient) leaves no backoff behind; a new situation starts over too
    expect(nextDelay({ delayMs: MOVING_MS, patient: false, key: "k", previous, stretch: 1 })).toEqual({ delayMs: MOVING_MS });
    expect(patient(previous, "other").delayMs).toBe(60_000);
    // the budget stretches every wait, never past an hour
    expect(nextDelay({ delayMs: MOVING_MS, patient: false, key: "k", stretch: 2.5 }).delayMs).toBe(150_000);
    expect(nextDelay({ delayMs: 30 * 60_000, patient: false, key: "k", stretch: 10 }).delayMs).toBe(HOUR);
  });
});

describe("autopilot on the budget", () => {
  test("forty armed PRs with checks running stay under a quarter of the hourly GraphQL limit", async () => {
    const cap = 5000 * WISP_SHARE;
    // Without the budget, every PR is looked at each minute for 2 points: 4,800 an hour.
    const unpaced = { now: START };
    const loose = setup(unpaced);
    const unlimited = new GitHubBudget(() => unpaced.now);
    Object.assign(unlimited, { reserve() {}, stretch: () => 1 });
    const looseRt = runtime(createGhAutopilot({ run: loose.gh.run, budget: unlimited }), unpaced, {}, loadConfig(), undefined, { budget: unlimited });
    const before = armed(40, 9001, unpaced);
    for (let step = 0; step < 6 * 20; step++) {
      unpaced.now += 10_000;
      await looseRt.tick();
    }
    expect(loose.gh.pointsInHourTo(unpaced.now)).toBeGreaterThan(cap);
    forgetTasks();
    expect(before.length).toBe(40);

    const clock = { now: START };
    const { gh, rt } = setup(clock);
    armed(40, 9101, clock);
    for (let step = 0; step < 6 * 120; step++) {
      clock.now += 10_000;
      await rt.tick();
    }
    let worst = 0;
    for (let at = START + 60_000; at <= clock.now; at += 60_000) worst = Math.max(worst, gh.pointsInHourTo(at));
    expect(worst).toBeLessThanOrEqual(cap);
    // paced, not starved: the second hour still spent most of the share
    expect(gh.pointsInHourTo(clock.now)).toBeGreaterThan(cap / 2);
  });

  test("a secondary rate limit pauses every GitHub read until its retry-after, and says so", async () => {
    const clock = { now: START };
    const { gh, rt } = setup(clock);
    const tasks = armed(3, 9301, clock);
    dueNow(tasks, clock);
    await rt.tick();
    expect(tasks.map((task) => autopilotStatus(task.id).reason)).toEqual(Array(3).fill("Waiting for checks (1 running)"));
    clock.now += 60_000;
    const resumes = clock.now + 120_000;
    gh.state.refusal = { until: resumes, status: 403, headers: { "Retry-After": "120" }, message: "You have exceeded a secondary rate limit." };
    const sent = gh.state.calls.length;
    dueNow(tasks, clock);
    await rt.tick();
    // the one refused request is the only one: the other looks were stopped before theirs went out
    expect(gh.state.calls.length - sent).toBe(1);
    for (const task of tasks) {
      expect(autopilotStatus(task.id)).toMatchObject({ state: "waiting", reason: `Paused: GitHub rate limit, resumes ${clockTime(resumes)}` });
      const row = autopilotRow(task.id)!;
      expect(row.failures).toBe(0);
      expect(Date.parse(row.next_check_at)).toBe(resumes);
    }
    clock.now += 60_000;
    dueNow(tasks, clock);
    await rt.tick();
    expect(gh.state.calls.length - sent).toBe(1);
    clock.now = resumes;
    dueNow(tasks, clock);
    await rt.tick();
    expect(gh.state.calls.length - sent).toBeGreaterThan(1);
    expect(tasks.map((task) => autopilotStatus(task.id).reason)).toEqual(Array(3).fill("Waiting for checks (1 running)"));
  });

  test("an hourly limit spent by other tools pauses until GitHub's reset, and a low one stretches the waits", async () => {
    const clock = { now: START };
    const { gh, rt } = setup(clock);
    const [task] = armed(1, 9401, clock);
    // someone else has used 92% of the hour: Wisp's next wait is stretched
    gh.state.used.graphql = 4600;
    await pass(rt, task!.id, clock);
    expect(autopilotStatus(task!.id).reason).toBe("Waiting for checks (1 running)");
    expect(Date.parse(autopilotRow(task!.id)!.next_check_at) - clock.now).toBeGreaterThan(2 * MOVING_MS);
    // and then all of it
    gh.state.used.graphql = 5000;
    clock.now += 5 * 60_000;
    await pass(rt, task!.id, clock);
    const reset = START + HOUR;
    expect(autopilotStatus(task!.id).reason).toBe(`Paused: GitHub rate limit, resumes ${clockTime(reset)}`);
    expect(Date.parse(autopilotRow(task!.id)!.next_check_at)).toBe(reset);
    clock.now = reset;
    await pass(rt, task!.id, clock);
    expect(autopilotStatus(task!.id).reason).toBe("Waiting for checks (1 running)");
  });

  test("a merge GitHub refuses for the rate is no merge failure: it pauses, then merges", async () => {
    const clock = { now: START + 10 * 60_000 };
    const budget = new GitHubBudget(() => clock.now);
    const gh = fakeGh({ clock, pr: (number) => snapshot({ number, url: `https://github.com/o/r/pull/${number}`, state: gh.state.merged.has(number) ? "MERGED" : "OPEN" }) });
    const rt = runtime(createGhAutopilot({ run: gh.run, budget }), clock, {}, loadConfig(), undefined, { budget });
    const [task] = armed(1, 9601, clock);
    gh.state.refuseMerge = "You have exceeded a secondary rate limit. Please wait a few minutes before you try again.";
    await rt.tick();
    const row = autopilotRow(task!.id)!;
    expect(autopilotStatus(task!.id)).toMatchObject({ state: "waiting", reason: `Paused: GitHub rate limit, resumes ${clockTime(clock.now + 60_000)}` });
    expect(row.state).toBe("active");
    expect(checkpointOf(row).mergeFailures).toBeUndefined();
    // it went out, so its attempt stays for the next look to confirm or forget
    expect(checkpointOf(row).mergeAttempt?.head).toBe(HEAD);
    clock.now += 60_000;
    dueNow([task!], clock);
    await rt.tick();
    expect(gh.state.merged.has(9601)).toBe(true);
    expect(autopilotStatus(task!.id).reason).toBe("#9601 merged by Wisp · Waiting for the task's next PR");
  });

  test("a merge attempt survives a pause unless the merge never went out", async () => {
    const clock = { now: START + 10 * 60_000 };
    const budget = new GitHubBudget(() => clock.now);
    const gh = fakeGh({ clock, pr: (number) => snapshot({ number, url: `https://github.com/o/r/pull/${number}`, state: gh.state.merged.has(number) ? "MERGED" : "OPEN" }) });
    const rt = runtime(createGhAutopilot({ run: gh.run, budget }), clock, {}, loadConfig(), undefined, { budget });
    // held back before gh ran: no merge happened, so no attempt is left to be mistaken for one
    const reserve = budget.reserve.bind(budget);
    let holdMerge = true;
    budget.reserve = (resource, estimate) => {
      if (holdMerge && estimate === MERGE_POINTS) { holdMerge = false; throw new GitHubPausedError(clock.now + 60_000, "share") }
      reserve(resource, estimate);
    };
    const [held] = armed(1, 9801, clock);
    await rt.tick();
    expect(autopilotStatus(held!.id).reason).toStartWith("Paused: Wisp's share of the GitHub rate limit is used up");
    expect(checkpointOf(autopilotRow(held!.id)!).mergeAttempt).toBeUndefined();
    expect(gh.state.calls.some((call) => call.kind === "merge")).toBe(false);
    forgetTasks();
    // a daemon that stopped mid-merge comes back to a rate limit: the attempt it left is kept,
    // so the merge it may have made is still known as Wisp's once GitHub answers
    const [restarted] = armed(1, 9802, clock);
    const row = autopilotRow(restarted!.id)!;
    writeAutopilotCheckpoint(row, { ...checkpointOf(row), state: "merging", mergeAttempt: { head: HEAD, at: new Date(clock.now).toISOString() } }, new Date(clock.now));
    gh.state.merged.add(9802);
    gh.state.refusal = { until: clock.now + 120_000, status: 403, headers: { "Retry-After": "120" }, message: "You have exceeded a secondary rate limit." };
    await rt.tick();
    expect(autopilotStatus(restarted!.id).reason).toStartWith("Paused: GitHub rate limit");
    expect(checkpointOf(autopilotRow(restarted!.id)!).mergeAttempt?.head).toBe(HEAD);
    clock.now += 120_000;
    dueNow([restarted!], clock);
    await rt.tick();
    expect(autopilotStatus(restarted!.id)).toMatchObject({ reason: "#9802 merged by Wisp · Waiting for the task's next PR", lastMerged: { pr: 9802, byWisp: true } });
  });

  test("one PR GitHub cannot find fails its own look, not the batch it was read in", async () => {
    const clock = { now: START };
    const { gh, rt } = setup(clock);
    const tasks = armed(5, 9701, clock);
    gh.state.missing.add(9703);
    await rt.tick();
    const reads = gh.state.calls.filter((call) => call.kind === "graphql");
    // one request for all five, and no second read of the others (or of the missing one)
    expect(reads.map((call) => ({ cost: call.cost, prs: call.prs }))).toEqual([{ cost: 10, prs: 5 }]);
    expect(tasks.map((task) => autopilotStatus(task.id).reason)).toEqual([
      "Waiting for checks (1 running)", "Waiting for checks (1 running)",
      "GitHub unavailable: Could not resolve to a PullRequest with the number of 9703.",
      "Waiting for checks (1 running)", "Waiting for checks (1 running)",
    ]);
    expect(autopilotRow(tasks[2]!.id)!.failures).toBe(1);
  });

  test("PRs of one repository are read five to a request: a quarter of the requests for the same points", async () => {
    const measure = async (client?: (github: AutopilotGitHub) => AutopilotGitHub) => {
      const clock = { now: START };
      const { gh, rt } = setup(clock, client);
      const tasks = armed(12, 9501, clock);
      dueNow(tasks, clock);
      await rt.tick();
      const reads = gh.state.calls.filter((call) => call.kind === "graphql");
      const reasons = tasks.map((task) => autopilotStatus(task.id).reason);
      forgetTasks();
      return {
        requests: reads.length, points: reads.reduce((sum, call) => sum + call.cost, 0), prs: reads.reduce((sum, call) => sum + call.prs, 0),
        // the base branch's rules, read once for all the looks side by side
        rest: gh.state.calls.filter((call) => call.kind === "rest").length, reasons,
      };
    };
    const alone = await measure((github) => ({ ...github, snapshots: undefined }));
    const batched = await measure();
    expect(alone).toMatchObject({ requests: 12, points: 24, prs: 12, rest: 2 });
    expect(batched).toMatchObject({ requests: 3, points: 24, prs: 12, rest: 2 });
    expect(batched.reasons).toEqual(alone.reasons);
  });

  test("waiting on a review backs off from a minute to five, and a push starts it over", async () => {
    const task = doneTask();
    const clock = { now: START + 150_000 };
    const { state, github } = fakeGitHub({ pr: snapshot({ mergeState: "BLOCKED", reviewDecision: "REVIEW_REQUIRED" }) });
    const rt = runtime(github, clock);
    setAutopilot(task.id, { autoMerge: true });
    seed(task.id, clock);
    const look = async () => {
      await pass(rt, task.id, clock);
      const next = Date.parse(autopilotRow(task.id)!.next_check_at);
      const delay = next - clock.now;
      clock.now = next;
      return { delay, reason: autopilotStatus(task.id).reason };
    };
    const waits = [];
    for (let index = 0; index < 5; index++) waits.push(await look());
    expect(waits).toEqual([60_000, 120_000, 240_000, 300_000, 300_000].map((delay) => ({ delay, reason: "Waiting for an approving review" })));
    // the agent pushes: the new head is looked at each minute, and the review wait begins again at a minute
    state.pr = snapshot({ head: "d".repeat(40), mergeState: "BLOCKED", reviewDecision: "REVIEW_REQUIRED" });
    const after = [await look(), await look(), await look(), await look()];
    expect(after).toEqual([
      { delay: 60_000, reason: "Waiting for checks to start" },
      { delay: 60_000, reason: "Waiting for checks to start" },
      { delay: 60_000, reason: "Waiting for an approving review" },
      { delay: 120_000, reason: "Waiting for an approving review" },
    ]);
  });
});

describe("the PR overview and wisp doctor", () => {
  test("the PR status spends from the same budget, and sends nothing while it is paused", async () => {
    const clock = { now: START };
    const budget = new GitHubBudget(() => clock.now);
    const gh = fakeGh({ clock, pr: running });
    const run: ProbeSpawnFn = async (cmd) => {
      if (cmd[0] === "git") return cmd[1] === "remote" ? { exitCode: 0, stdout: "https://github.com/o/r.git", stderr: "" } : { exitCode: 1, stdout: "", stderr: "" };
      const result = await gh.run({ cmd });
      return { exitCode: result.exitCode ?? 1, stdout: result.out, stderr: result.err };
    };
    const cache = new PullRequestCache({ run, budget, now: () => new Date(clock.now), ttlMs: 1000 });
    const task = { id: "tbudget", repo_path: "/fixture/repo", branch: "wisp/tbudget-x", mode: "worktree", archived: 0 } as Task;
    expect((await cache.status(task)).kind).toBe("none");
    expect(budget.report().resources[0]).toMatchObject({ resource: "graphql", spentLastHour: 1, remaining: 4999, limit: 5000 });
    gh.state.refusal = { until: clock.now + 5 * 60_000, status: 429, headers: {}, message: "Too many requests" };
    clock.now += 2000;
    expect((await cache.status(task)).kind).toBe("unavailable");
    const sent = gh.state.calls.length;
    clock.now += 2000;
    await cache.status(task);
    expect(gh.state.calls.length).toBe(sent);
    expect(budget.report().resources.map((entry) => entry.paused?.why)).toEqual(["secondary", "secondary"]);
  });

  test("wisp doctor shows Wisp's spend, what GitHub reports is left, and a pause", () => {
    const now = new Date(START);
    const clock = { now: START };
    const budget = new GitHubBudget(() => clock.now);
    budget.settle("graphql", ghReply(included(200, {}, { data: { rateLimit: { cost: 40, remaining: 4700, limit: 5000, resetAt: new Date(START + HOUR).toISOString() } } }), "", false), 0);
    const fine = githubBudgetCheck(budget.report(), now)!;
    expect(fine.status).toBe("ok");
    expect(fine.message).toContain("Wisp spent 40 of 1250 GraphQL points and 0 of 1250 REST requests of its 25% share in the last hour");
    expect(fine.message).toContain(`GitHub reports 4700 of 5000 GraphQL points left until ${clockTime(START + HOUR)}`);
    expect(() => budget.settle("graphql", ghReply(included(403, { "Retry-After": "60" }, { message: "secondary rate limit" }), "", true), 0)).toThrow("Paused: GitHub rate limit");
    const paused = githubBudgetCheck(budget.report(), now)!;
    expect(paused.status).toBe("warn");
    expect(paused.message).toStartWith(`all GitHub calls paused until ${clockTime(START + 60_000)}: GitHub's secondary rate limit`);
    // a primary limit names the one limit it stops
    clock.now = START + 60_000;
    const reset = String(Math.floor((START + HOUR) / 1000));
    expect(() => budget.settle("core", ghReply(included(403, { "X-Ratelimit-Remaining": "0", "X-Ratelimit-Reset": reset }, { message: "API rate limit exceeded" }), "", true), 0)).toThrow();
    expect(githubBudgetCheck(budget.report(), new Date(clock.now))!.message).toStartWith(`REST calls paused until ${clockTime(START + HOUR)}: GitHub's hourly rate limit is used up`);
    expect(githubBudgetCheck(undefined, now)).toBeNull();
  });
});
