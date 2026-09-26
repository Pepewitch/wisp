import { describe, expect, test } from "bun:test";
import {
  actionsRunId,
  checkVerdicts,
  latestRelease,
  previousRelease,
  rerunAdvice,
  settleFailures,
  versionArgument,
  type CheckRun,
  type CheckVerdict,
  type WorkflowRunState,
} from "../scripts/release-github";

function checkRun(name: string, overrides: Partial<CheckRun> = {}): CheckRun {
  return {
    name,
    status: "completed",
    conclusion: "success",
    started_at: "2026-09-25T10:00:00Z",
    html_url: "https://github.com/Pepewitch/wisp/actions/runs/123/job/1",
    app: { slug: "github-actions" },
    ...overrides,
  };
}

describe("checkVerdicts", () => {
  test("the latest github-actions run of each required check wins", () => {
    const verdicts = checkVerdicts(
      [
        checkRun("test", { conclusion: "failure", started_at: "2026-09-25T10:00:00Z" }),
        checkRun("test", { conclusion: "success", started_at: "2026-09-25T11:00:00Z" }),
        checkRun("supply-chain", { status: "in_progress", conclusion: null }),
      ],
      ["test", "supply-chain", "linux-contract"],
    );
    expect(verdicts.map((verdict) => verdict.state)).toEqual(["passed", "pending", "missing"]);
  });

  test("a check from another app does not count", () => {
    const verdicts = checkVerdicts([checkRun("test", { app: { slug: "dependabot" } })], ["test"]);
    expect(verdicts[0]!.state).toBe("missing");
  });

  test("a completed failure reports its conclusion", () => {
    const verdicts = checkVerdicts([checkRun("test", { conclusion: "failure" })], ["test"]);
    expect(verdicts[0]).toMatchObject({ state: "failed", detail: "failure" });
  });
});

describe("settleFailures", () => {
  const failed: CheckVerdict = {
    name: "test",
    state: "failed",
    detail: "failure",
    url: "https://github.com/Pepewitch/wisp/actions/runs/123/job/1",
  };

  function runState(state: WorkflowRunState): (runId: string) => WorkflowRunState {
    return (runId) => {
      expect(runId).toBe("123");
      return state;
    };
  }

  test("a failed check whose run is running again is pending", () => {
    const [verdict] = settleFailures([failed], runState({ status: "in_progress", run_attempt: 2 }));
    expect(verdict).toMatchObject({ state: "pending", detail: "rerun in progress" });
  });

  test("a first-attempt failure stays failed", () => {
    const [verdict] = settleFailures([failed], runState({ status: "completed", run_attempt: 1 }));
    expect(verdict).toMatchObject({ state: "failed", attempt: 1 });
  });

  test("a repeated failure records the attempt", () => {
    const [verdict] = settleFailures([failed], runState({ status: "completed", run_attempt: 2 }));
    expect(verdict).toMatchObject({ state: "failed", attempt: 2 });
  });

  test("other verdicts pass through without a lookup", () => {
    const passed: CheckVerdict = { name: "supply-chain", state: "passed", detail: "success", url: null };
    const verdicts = settleFailures([passed], () => {
      throw new Error("must not be called");
    });
    expect(verdicts).toEqual([passed]);
  });
});

describe("rerunAdvice", () => {
  const failed = (attempt?: number): CheckVerdict => ({
    name: "test",
    state: "failed",
    detail: "failure",
    url: "https://github.com/Pepewitch/wisp/actions/runs/123/job/1",
    attempt,
  });

  test("a first failure gets one rerun command", () => {
    const advice = rerunAdvice([failed()]);
    expect(advice).toContain("gh run rerun 123 --failed");
    expect(advice).not.toContain("failed again");
  });

  test("a repeated failure stops the release instead of another rerun", () => {
    const advice = rerunAdvice([failed(2)]);
    expect(advice).toContain("failed again after a rerun");
    expect(advice).toContain("Do not rerun");
    expect(advice).not.toContain("gh run rerun");
  });
});

describe("actionsRunId", () => {
  test("reads the run id from a check URL", () => {
    expect(actionsRunId("https://github.com/Pepewitch/wisp/actions/runs/36128051553/job/7")).toBe("36128051553");
    expect(actionsRunId(null)).toBeNull();
    expect(actionsRunId("https://example.com/")).toBeNull();
  });
});

describe("release ordering", () => {
  const tags = ["v0.6.2", "v0.6.10", "v0.5.9", "v0.4.0-alpha.13"];

  test("previousRelease orders by semver, not by tag date", () => {
    expect(previousRelease(tags, "0.6.10")).toBe("0.6.2");
    expect(previousRelease(tags, "0.5.9")).toBe("0.4.0-alpha.13");
    expect(previousRelease(tags, "0.4.0-alpha.13")).toBeNull();
  });

  test("latestRelease picks the highest version", () => {
    expect(latestRelease(tags)).toBe("0.6.10");
    expect(latestRelease([])).toBeNull();
  });
});

describe("versionArgument", () => {
  test("accepts a version with or without the v prefix", () => {
    expect(versionArgument(["0.6.3"], "usage")).toBe("0.6.3");
    expect(versionArgument(["v0.6.3"], "usage")).toBe("0.6.3");
  });

  test("refuses a missing version or a flag in its place", () => {
    expect(() => versionArgument([], "usage")).toThrow("usage");
    expect(() => versionArgument(["--dry-run"], "usage")).toThrow("usage");
  });
});
