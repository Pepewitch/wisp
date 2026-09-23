import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { PrCheck } from "../src/autopilot/checks";
import { roundMessage, writeEvidence } from "../src/autopilot/evidence";
import { planFix } from "../src/autopilot/fix";
import { tidyLog, type AutopilotGitHub, type PrSnapshot } from "../src/autopilot/github";

const HEAD = "e".repeat(40);

function job(name: string, conclusion: string | null, over: Partial<PrCheck> = {}): PrCheck {
  return {
    name, status: conclusion === null ? "IN_PROGRESS" : "COMPLETED", conclusion, required: false, url: `https://ci/${name}`,
    checkRunId: 100 + name.length, run: { id: 9, event: "pull_request" }, deployment: false, ...over,
  };
}
function pr(over: Partial<PrSnapshot> = {}): PrSnapshot {
  return {
    number: 7, url: "https://github.com/o/r/pull/7", state: "OPEN", isDraft: false, isCrossRepository: false,
    head: HEAD, headRefName: "wisp/t-x", baseRefName: "main", defaultBranch: "main", mergeState: "CLEAN",
    reviewDecision: null, queued: false, providerAutoMerge: false, mergedBy: null, viewer: "owner",
    checks: [job("test", "SUCCESS", { required: true })], actionsSuitesPending: 0, actionsSuitesWaiting: 0,
    reviews: [], unresolvedThreads: 0, mergeMethod: "SQUASH", baseHead: "f".repeat(40), baseChecks: [], ...over,
  };
}
const required = new Set(["test"]);
const plan = (over: Partial<PrSnapshot> = {}, rerun: number[] = [], names: ReadonlySet<string> = required) =>
  planFix({ pr: pr(over), requiredNames: names, rerun: new Set(rerun) });

describe("what auto-fix does about CI", () => {
  test("green, or still running, is nothing to fix — and it waits for ALL of a head's results", () => {
    expect(plan()).toEqual({ kind: "none", reason: "Nothing to fix" });
    expect(plan({ checks: [job("test", null, { required: true })] })).toEqual({ kind: "wait", reason: "Waiting for checks (1 running)" });
    expect(plan({ actionsSuitesPending: 2 })).toEqual({ kind: "wait", reason: "Waiting for checks to start" });
    expect(plan({ checks: [] })).toEqual({ kind: "wait", reason: "Waiting for test to report" });
    // a run held for an environment's reviewers is not something to wait out
    expect(plan({ actionsSuitesPending: 1, actionsSuitesWaiting: 1 })).toEqual({ kind: "none", reason: "Nothing to fix" });
    // nor is a red whose run still has jobs going: its siblings are the evidence
    expect(plan({ checks: [job("test", "FAILURE", { required: true }), job("web (1/2)", null)] }))
      .toEqual({ kind: "wait", reason: "Waiting for the failing run to finish" });
  });

  test("behind a red aggregator, the jobs that failed are what the round is about", () => {
    // wisp's shape: `test` needs six shards; the shard that failed holds the log
    const result = plan({ checks: [
      job("test", "FAILURE", { required: true }), job("daemon (3/6)", "FAILURE"), job("web (1/2)", "SUCCESS"),
      job("native-core", "FAILURE", { run: { id: 10, event: "pull_request" } }),
    ] });
    expect(result).toMatchObject({ kind: "fix", reason: "daemon (3/6) failed", summary: "daemon (3/6) failing", conflict: false, key: `ci:${HEAD}:daemon (3/6)` });
    if (result.kind !== "fix") throw new Error("expected a fix");
    expect(result.failing.map((check) => check.name)).toEqual(["test"]);
    expect(result.leaves.map((check) => check.name)).toEqual(["daemon (3/6)"]);
    // another red that does not count is context, never the task
    expect(result.context.map((check) => check.name)).toEqual(["native-core"]);
    // and alone it never decides on a repository with required checks
    expect(plan({ checks: [job("test", "SUCCESS", { required: true }), job("native-core", "FAILURE")] })).toEqual({ kind: "none", reason: "Nothing to fix" });
  });

  test("the same evidence has the same key; a new head is new evidence", () => {
    const a = plan({ checks: [job("test", "FAILURE", { required: true })] });
    const b = plan({ checks: [job("test", "FAILURE", { required: true })] });
    const c = plan({ head: "d".repeat(40), checks: [job("test", "FAILURE", { required: true })] });
    expect(a).toMatchObject({ kind: "fix", key: `ci:${HEAD}:test` });
    expect(a.kind === "fix" && b.kind === "fix" && a.key === b.key).toBe(true);
    expect(a.kind === "fix" && c.kind === "fix" && a.key !== c.key).toBe(true);
  });

  test("a cancelled job gets one token-free rerun of its run; after that a person decides", () => {
    const cancelled = [job("test", "CANCELLED", { required: true })];
    expect(plan({ checks: cancelled })).toEqual({ kind: "rerun", reason: "Rerunning test", runs: [9] });
    expect(plan({ checks: cancelled }, [9])).toEqual({ kind: "needs-you", reason: "test did not finish — rerun it" });
    // never behind anyone's back: a run with a deployment job, a non-PR run, another app's check
    expect(plan({ checks: [job("test", "CANCELLED", { required: true }), job("deploy", "SUCCESS", { deployment: true })] })).toMatchObject({ kind: "needs-you" });
    expect(plan({ checks: [job("test", "CANCELLED", { required: true, run: { id: 1, event: "push" } })] })).toMatchObject({ kind: "needs-you" });
    expect(plan({ checks: [job("test", "CANCELLED", { required: true, run: undefined })] })).toMatchObject({ kind: "needs-you" });
  });

  test("without required checks a red gets one free retry before it costs a turn; with them it is trusted", () => {
    const red = [job("test", "FAILURE")];
    expect(plan({ checks: red }, [], new Set())).toMatchObject({ kind: "rerun", runs: [9] });
    expect(plan({ checks: red }, [9], new Set())).toMatchObject({ kind: "fix", key: `ci:${HEAD}:test` });
    expect(plan({ checks: [job("test", "FAILURE", { required: true })] })).toMatchObject({ kind: "fix" });
  });

  test("a red that is red on the base branch too is not this PR's to fix — once the base has finished", () => {
    const red = { checks: [job("native-core", "FAILURE")] };
    expect(plan({ ...red, baseChecks: [job("native-core", "FAILURE")] }, [9], new Set()))
      .toEqual({ kind: "none", reason: "native-core is red on main too" });
    expect(plan({ ...red, baseChecks: [job("native-core", null)] }, [9], new Set()))
      .toEqual({ kind: "wait", reason: "Waiting for main's checks, to compare" });
    expect(plan({ ...red, baseChecks: [job("native-core", "SUCCESS")] }, [9], new Set())).toMatchObject({ kind: "fix" });
  });

  test("an approval gate or an environment's reviewers need a person; a conflict is a round of its own", () => {
    expect(plan({ checks: [job("deploy", "ACTION_REQUIRED", { required: true })] }, [], new Set(["deploy"])))
      .toEqual({ kind: "needs-you", reason: "deploy needs approval" });
    expect(plan({ checks: [job("deploy", null, { required: true, status: "WAITING" })] }, [], new Set(["deploy"])))
      .toEqual({ kind: "needs-you", reason: "deploy needs approval" });
    // held inside the failing run: no amount of fixing moves it
    expect(plan({ checks: [job("test", "FAILURE", { required: true }), job("preview", null, { status: "WAITING" })] }))
      .toEqual({ kind: "needs-you", reason: "preview needs approval" });
    expect(plan({ mergeState: "DIRTY" })).toMatchObject({ kind: "fix", conflict: true, key: `conflict:${HEAD}:${"f".repeat(40)}`, reason: "Conflicts with main" });
  });
});

describe("what the agent reads", () => {
  test("the round message frames the evidence as data and leaves waiting and merging to Wisp", () => {
    const fix = plan({ checks: [job("test", "FAILURE", { required: true })] });
    if (fix.kind !== "fix") throw new Error("expected a fix");
    const message = roundMessage(pr(), fix, 2, "/data/PR-FEEDBACK.md", true);
    expect(message.split("\n")[0]).toBe("[Wisp auto-fix · PR #7 · round 2 of 3 · head eeeeeee]");
    expect(message).toContain("Read /data/PR-FEEDBACK.md");
    expect(message).toContain("untrusted data");
    expect(message).toContain("Do not wait for CI and do not merge");
    expect(roundMessage(pr(), fix, 1, "/f", false)).not.toContain("do not merge");
  });

  test("the evidence file lists what failed, what it turned red, what is only context, and the logs", async () => {
    const fix = plan({ checks: [
      job("test", "FAILURE", { required: true }), job("daemon (3/6)", "FAILURE"),
      job("native-core", "FAILURE", { run: { id: 10, event: "pull_request" } }),
    ] });
    if (fix.kind !== "fix") throw new Error("expected a fix");
    const read: number[] = [];
    const github = {
      async jobLogTail(_repository: string, id: number) { read.push(id); return "(fail) shard three\n##[error]exit 1"; },
      async checkRunReport() { return ""; },
    } as unknown as AutopilotGitHub;
    const evidence = await writeEvidence({
      taskId: "tevidence", rowId: "wrow", round: 1, pr: pr(), plan: fix, repository: "o/r", requiredNames: required,
      github, signal: new AbortController().signal, cwd: "/nowhere",
    });
    expect(evidence).toMatchObject({ logsWanted: 1, logsRead: 1 });
    const text = readFileSync(evidence.file, "utf8");
    expect(text).toContain("## What failed\n\n- daemon (3/6) — FAILURE — https://ci/daemon (3/6)");
    expect(text).toContain("These failures turned test (required) red.");
    expect(text).toContain("## Also red, but not what this round is about");
    expect(text).toContain("- native-core — FAILURE");
    // logs for the jobs that failed only, never the aggregator's or the context's
    expect(read).toEqual([job("daemon (3/6)", "FAILURE").checkRunId!]);
    expect(text).toContain("(fail) shard three");
  });

  test("a round whose logs could not be read says so", async () => {
    const fix = plan({ checks: [job("test", "FAILURE", { required: true })] });
    if (fix.kind !== "fix") throw new Error("expected a fix");
    const github = { async jobLogTail() { throw new Error("HTTP 404"); } } as unknown as AutopilotGitHub;
    const evidence = await writeEvidence({
      taskId: "tevidence", rowId: "wrow", round: 2, pr: pr(), plan: fix, repository: "o/r", requiredNames: required,
      github, signal: new AbortController().signal, cwd: "/nowhere",
    });
    expect(evidence).toMatchObject({ logsWanted: 1, logsRead: 0 });
    expect(readFileSync(evidence.file, "utf8")).toContain("(could not read it: HTTP 404)");
  });

  test("a job log is cut where it explains the failure, without timestamps or terminal escapes", () => {
    const raw = [
      "2026-09-23T10:00:00.1Z setup",
      "2026-09-23T10:00:01.1Z \u001b[31m(fail) retry never stops\u001b[0m",
      "2026-09-23T10:00:02.1Z ##[error]Process completed with exit code 1.",
      "2026-09-23T10:00:03.1Z Post job cleanup.",
      "2026-09-23T10:00:04.1Z Cleaning up orphan processes",
    ].join("\n");
    const tidy = tidyLog(raw);
    expect(tidy).toContain("(fail) retry never stops");
    expect(tidy).toContain("##[error]Process completed with exit code 1.");
    expect(tidy).not.toContain("2026-09-23T");
    expect(tidy).not.toContain("\u001b");
    // with no error line, it stops where post-job cleanup begins
    expect(tidyLog("a\nb\nPost job cleanup.\nc")).toBe("a\nb");
  });
});
