import { describe, expect, test } from "bun:test";
import type { PrCheck } from "../src/autopilot/checks";
import { roundMessage } from "../src/autopilot/evidence";
import { planFix } from "../src/autopilot/fix";
import { tidyLog, type PrSnapshot } from "../src/autopilot/github";

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
const plan = (over: Partial<PrSnapshot> = {}, rerun: string[] = [], names: ReadonlySet<string> = required) =>
  planFix({ pr: pr(over), requiredNames: names, rerun: new Set(rerun) });

describe("what auto-fix does about CI", () => {
  test("green, or still running, is nothing to fix — and it waits for ALL of a head's results", () => {
    expect(plan()).toEqual({ kind: "none", reason: "Nothing to fix" });
    expect(plan({ checks: [job("test", null, { required: true })] })).toEqual({ kind: "wait", reason: "Waiting for checks (1 running)" });
    expect(plan({ actionsSuitesPending: 2, checks: [] })).toEqual({ kind: "wait", reason: "Waiting for checks to start" });
    // a run held for an environment's reviewers is not something to wait out
    expect(plan({ actionsSuitesPending: 1, actionsSuitesWaiting: 1 })).toEqual({ kind: "none", reason: "Nothing to fix" });
  });

  test("a required red is sent with every failing job as evidence, the deciding one first", () => {
    // wisp's shape: `test` is an aggregator; the shard that failed holds the log
    const result = plan({ checks: [job("test", "FAILURE", { required: true }), job("daemon (3/6)", "FAILURE"), job("web (1/2)", "SUCCESS")] });
    expect(result).toMatchObject({ kind: "fix", reason: "test failed", summary: "test failing", conflict: false, key: `ci:${HEAD}:test` });
    if (result.kind !== "fix") throw new Error("expected a fix");
    expect(result.evidence.map((check) => check.name)).toEqual(["test", "daemon (3/6)"]);
    // a non-required red never decides on a repository with required checks
    expect(plan({ checks: [job("test", "SUCCESS", { required: true }), job("native-core", "FAILURE")] })).toEqual({ kind: "none", reason: "Nothing to fix" });
  });

  test("the same evidence has the same key; a new head is new evidence", () => {
    const a = plan({ checks: [job("test", "FAILURE", { required: true })] });
    const b = plan({ checks: [job("test", "FAILURE", { required: true })] });
    const c = plan({ head: "d".repeat(40), checks: [job("test", "FAILURE", { required: true })] });
    expect(a.kind === "fix" && b.kind === "fix" && a.key === b.key).toBe(true);
    expect(a.kind === "fix" && c.kind === "fix" && a.key !== c.key).toBe(true);
  });

  test("a cancelled job gets one token-free rerun; after that a person decides", () => {
    const cancelled = [job("test", "CANCELLED", { required: true })];
    expect(plan({ checks: cancelled })).toMatchObject({ kind: "rerun", reason: "Rerunning test" });
    expect(plan({ checks: cancelled }, [`${HEAD}:test`])).toEqual({ kind: "needs-you", reason: "test did not finish — rerun it" });
    // never behind anyone's back: deployments, non-PR runs, other apps' checks
    expect(plan({ checks: [job("test", "CANCELLED", { required: true, deployment: true })] })).toMatchObject({ kind: "needs-you" });
    expect(plan({ checks: [job("test", "CANCELLED", { required: true, run: { id: 1, event: "push" } })] })).toMatchObject({ kind: "needs-you" });
    expect(plan({ checks: [job("test", "CANCELLED", { required: true, run: undefined })] })).toMatchObject({ kind: "needs-you" });
  });

  test("without required checks a red gets one free retry before it costs a turn; with them it is trusted", () => {
    const red = [job("test", "FAILURE")];
    expect(plan({ checks: red }, [], new Set())).toMatchObject({ kind: "rerun" });
    expect(plan({ checks: red }, [`${HEAD}:test`], new Set())).toMatchObject({ kind: "fix", key: `ci:${HEAD}:test` });
    expect(plan({ checks: [job("test", "FAILURE", { required: true })] })).toMatchObject({ kind: "fix" });
  });

  test("a red that is red on the base branch too is not this PR's to fix", () => {
    const result = plan({
      checks: [job("native-core", "FAILURE")], baseChecks: [job("native-core", "FAILURE")],
    }, [`${HEAD}:native-core`], new Set());
    expect(result).toEqual({ kind: "none", reason: "native-core is red on main too" });
  });

  test("an approval gate needs a person; a conflict is a round of its own", () => {
    expect(plan({ checks: [job("deploy", "ACTION_REQUIRED", { required: true })] }, [], new Set(["deploy"])))
      .toEqual({ kind: "needs-you", reason: "deploy needs approval" });
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
