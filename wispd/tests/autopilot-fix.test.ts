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
    reviews: [], threads: [], threadsTruncated: false, comments: [], unresolvedThreads: 0, mergeMethod: "SQUASH", baseHead: "f".repeat(40), baseChecks: [], ...over,
  };
}
const required = new Set(["test"]);
const plan = (over: Partial<PrSnapshot> = {}, rerun: number[] = [], names: ReadonlySet<string> = required) =>
  planFix({ pr: pr(over), requiredNames: names, rerun: new Set(rerun) });

describe("what auto-fix does about CI", () => {
  test("green, or still running, is nothing to fix — and it waits for ALL of a head's results", () => {
    expect(plan()).toEqual({ kind: "none", reason: "Nothing to fix" });
    expect(plan({ checks: [job("test", null, { required: true })] })).toEqual({ kind: "wait", reason: "Waiting for checks (1 running)" });
    expect(plan({ checks: [] })).toEqual({ kind: "wait", reason: "Waiting for test to report" });
    // with every check counting, a suite that has not reported yet is one of them…
    expect(plan({ actionsSuitesPending: 2, checks: [job("test", "FAILURE")] }, [], new Set())).toEqual({ kind: "wait", reason: "Waiting for checks to start" });
    // …but a run held for an environment's reviewers is not something to wait out
    expect(plan({ actionsSuitesPending: 1, actionsSuitesWaiting: 1 }, [], new Set())).toMatchObject({ kind: "none" });
    // with required checks, a slow run that does not count never holds a red one back
    expect(plan({ actionsSuitesPending: 1, checks: [job("test", "FAILURE", { required: true }), job("native-core", null, { run: { id: 10, event: "pull_request" } })] }))
      .toMatchObject({ kind: "fix", reason: "test failed" });
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
    expect(result).toMatchObject({ kind: "fix", reason: "test, daemon (3/6) failed", summary: "test, daemon (3/6) failing", conflict: false, key: `ci:${HEAD}:${encodeURIComponent("daemon (3/6)")},test` });
    if (result.kind !== "fix") throw new Error("expected a fix");
    expect(result.failing.map((check) => check.name)).toEqual(["test"]);
    expect(result.leaves.map((check) => check.name)).toEqual(["test", "daemon (3/6)"]);
    // another red that does not count is context, never the task
    expect(result.context.map((check) => check.name)).toEqual(["native-core"]);
    // and alone it never decides on a repository with required checks
    expect(plan({ checks: [job("test", "SUCCESS", { required: true }), job("native-core", "FAILURE")] })).toEqual({ kind: "none", reason: "Nothing to fix" });
  });

  test("a required job that is not an aggregator is its own evidence, and an optional red beside it cannot hide it", () => {
    const names = new Set(["build"]);
    const checks = [job("build", "FAILURE", { required: true }), job("lint", "FAILURE")];
    expect(plan({ checks }, [], names)).toMatchObject({ kind: "fix", reason: "build, lint failed", key: `ci:${HEAD}:build,lint` });
    // lint is red on main, build is not: still this PR's to fix
    expect(plan({ checks, baseChecks: [job("lint", "FAILURE")] }, [], names)).toMatchObject({ kind: "fix", reason: "build, lint failed" });
    // both red on main: main's, and named by the check that decides
    expect(plan({ checks, baseChecks: [job("lint", "FAILURE"), job("build", "FAILURE")] }, [], names))
      .toEqual({ kind: "none", reason: "build is red on main too" });
    // one leaf settles it: a base job still running elsewhere is not waited for
    expect(plan({ checks, baseChecks: [job("lint", null), job("build", "SUCCESS")] }, [], names)).toMatchObject({ kind: "fix" });
  });

  test("fail-fast's cancelled jobs are neither rerun nor evidence when a real failure caused them", () => {
    const checks = [
      job("unit (1)", "CANCELLED"), job("unit (2)", "CANCELLED"), job("build", "FAILURE", { required: true }),
      job("unit (3)", "CANCELLED"), job("unit (4)", "CANCELLED"), job("unit (5)", "FAILURE"),
    ];
    const result = plan({ checks }, [], new Set(["build"]));
    expect(result).toMatchObject({ kind: "fix", reason: "build, unit (5) failed" });
    if (result.kind !== "fix") throw new Error("expected a fix");
    expect(result.leaves.map((check) => check.name)).toEqual(["build", "unit (5)"]);
  });

  test("where every check counts, fail-fast's cancelled jobs still stay out of the round", () => {
    const checks = [...[1, 2, 3, 4, 5, 6, 7].map((n) => job(`unit (${n})`, "CANCELLED")), job("unit (8)", "FAILURE")];
    const result = plan({ checks }, [9], new Set());
    expect(result).toMatchObject({ kind: "fix", reason: "unit (8) failed", key: `ci:${HEAD}:${encodeURIComponent("unit (8)")}` });
    if (result.kind !== "fix") throw new Error("expected a fix");
    expect(result.context).toEqual([]);
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
    const content = { ci: fix, items: [], summary: fix.summary };
    const message = roundMessage({ ...content, pr: pr(), round: 2, file: "/data/PR-FEEDBACK.md", autoMerge: true, signature: "— droid via Wisp <!-- wisp:task=t1 -->" });
    expect(message.split("\n")[0]).toBe("[Wisp auto-fix · PR #7 · round 2 of 3 · head eeeeeee]");
    expect(message).toContain("Read /data/PR-FEEDBACK.md");
    expect(message).toContain("untrusted data");
    expect(message).toContain("Do not wait for CI and do not merge");
    expect(message).toContain("End every comment or reply you post on GitHub with: — droid via Wisp <!-- wisp:task=t1 -->");
    expect(roundMessage({ ...content, pr: pr(), round: 1, file: "/f", autoMerge: false, signature: "" })).not.toContain("do not merge");
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
      taskId: "tevidence", rowId: "wrow", round: 1, pr: pr(), ci: fix, items: [], summary: fix.summary, repository: "o/r", requiredNames: required,
      github, signal: new AbortController().signal, cwd: "/nowhere", signature: "",
    });
    expect(evidence).toMatchObject({ logsWanted: 2, logsRead: 2 });
    const text = readFileSync(evidence.file, "utf8");
    expect(text).toContain("## What failed\n\n- test (required) — FAILURE — https://ci/test\n- daemon (3/6) — FAILURE — https://ci/daemon (3/6)");
    expect(text).toContain("test decides this round; the other jobs listed failed in the same workflow run");
    expect(text).toContain("## Also red, but not this round's");
    expect(text).toContain("- native-core — FAILURE");
    // logs for the round's own jobs, never the context's
    expect(read.sort()).toEqual([job("test", "FAILURE").checkRunId!, job("daemon (3/6)", "FAILURE").checkRunId!].sort());
    expect(text).toContain("(fail) shard three");
  });

  test("a round whose logs could not be read says so", async () => {
    const fix = plan({ checks: [job("test", "FAILURE", { required: true })] });
    if (fix.kind !== "fix") throw new Error("expected a fix");
    const github = { async jobLogTail() { throw new Error("HTTP 404"); } } as unknown as AutopilotGitHub;
    const evidence = await writeEvidence({
      taskId: "tevidence", rowId: "wrow", round: 2, pr: pr(), ci: fix, items: [], summary: fix.summary, repository: "o/r", requiredNames: required,
      github, signal: new AbortController().signal, cwd: "/nowhere", signature: "",
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
