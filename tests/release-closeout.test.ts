import { describe, expect, test } from "bun:test";
import {
  candidateRunFor,
  gateOutcome,
  parseReceipt,
  passedSourceChecks,
  receiptArtifactName,
  recoveryCandidates,
  releasePullRequest,
  releaseRunForTag,
  tapProblems,
  type ReleaseJob,
  type TapState,
  type WorkflowRun,
} from "../scripts/release-closeout";
import { RELEASE_JOBS, SOURCE_CHECK_LABELS } from "../scripts/release-ledger";
import type { CheckRun } from "../scripts/release-github";

function workflowRun(partial: Partial<WorkflowRun>): WorkflowRun {
  return {
    id: 1,
    html_url: `https://github.com/Pepewitch/wisp/actions/runs/${partial.id ?? 1}`,
    event: "push",
    head_branch: "main",
    head_sha: "abc",
    conclusion: "success",
    run_attempt: 1,
    created_at: "2026-09-25T11:10:00Z",
    updated_at: "2026-09-25T11:12:00Z",
    ...partial,
  };
}

describe("releaseRunForTag", () => {
  const push = workflowRun({ id: 10, head_branch: "v0.6.3", head_sha: "sha1" });
  const runs = [
    push,
    workflowRun({ id: 11, event: "workflow_dispatch", head_branch: "main" }),
    workflowRun({ id: 12, head_branch: "v0.6.3", head_sha: "other" }),
    workflowRun({ id: 13, head_branch: "v0.6.4", head_sha: "sha1" }),
  ];

  test("picks the tag push run for exactly this commit", () => {
    expect(releaseRunForTag(runs, "v0.6.3", "sha1")).toBe(push);
    expect(releaseRunForTag(runs, "v0.6.3", "missing")).toBeNull();
    expect(releaseRunForTag(runs, "v0.6.9", "sha1")).toBeNull();
  });
});

describe("candidateRunFor", () => {
  const pushed = "2026-09-25T11:30:00Z";
  const passed = workflowRun({ id: 30, head_sha: "sha1", updated_at: "2026-09-25T11:20:00Z" });

  test("links the newest exact-main run when it passed before the tag was pushed", () => {
    const runs = [
      workflowRun({ id: 29, head_sha: "sha1", conclusion: "failure", updated_at: "2026-09-25T11:15:00Z" }),
      passed,
      workflowRun({ id: 31, head_sha: "other" }),
      workflowRun({ id: 32, head_sha: "sha1", head_branch: "feature" }),
      workflowRun({ id: 33, head_sha: "sha1", event: "workflow_dispatch" }),
    ];
    expect(candidateRunFor(runs, "sha1", pushed)).toEqual({ run: passed, problem: null });
  });

  test("a newer failed run is not recorded as a pass", () => {
    const failed = workflowRun({ id: 31, head_sha: "sha1", conclusion: "failure", updated_at: "2026-09-25T11:25:00Z" });
    const { run, problem } = candidateRunFor([passed, failed], "sha1", pushed);
    expect(run).toBeNull();
    expect(problem).toContain("(https://github.com/Pepewitch/wisp/actions/runs/31) ended failure");
  });

  test("a run still going, cancelled, or finished after the tag push is left for a person", () => {
    const newest = (partial: Partial<WorkflowRun>) =>
      candidateRunFor([passed, workflowRun({ id: 31, head_sha: "sha1", ...partial })], "sha1", pushed);
    expect(newest({ conclusion: null })).toMatchObject({ run: null, problem: expect.stringContaining("has not finished") });
    expect(newest({ conclusion: "cancelled" }).problem).toContain("ended cancelled");
    expect(newest({ updated_at: "2026-09-25T11:31:00Z" }).problem).toContain("finished after the tag was pushed");
    expect(candidateRunFor([], "sha1", pushed).problem).toBe("no exact-main release candidate run exists for sha1");
  });
});

describe("recoveryCandidates", () => {
  const tagRun = "2026-09-25T11:00:00Z";

  test("offers successful dispatch runs after the tag's run, newest first", () => {
    const runs = [
      workflowRun({ id: 19, event: "workflow_dispatch", created_at: "2026-09-25T11:20:00Z" }),
      workflowRun({ id: 20, event: "workflow_dispatch", created_at: "2026-09-25T11:30:00Z" }),
      workflowRun({ id: 21, event: "workflow_dispatch", conclusion: "failure", created_at: "2026-09-25T11:40:00Z" }),
      workflowRun({ id: 22, event: "push", created_at: "2026-09-25T11:50:00Z" }),
    ];
    expect(recoveryCandidates(runs, tagRun).map((entry) => entry.id)).toEqual([20, 19]);
  });

  test("a recovery that predates the tag's run cannot have promoted it", () => {
    const earlier = workflowRun({ id: 5, event: "workflow_dispatch", created_at: "2026-09-20T09:00:00Z" });
    expect(recoveryCandidates([earlier], tagRun)).toEqual([]);
  });
});

describe("gateOutcome", () => {
  const jobs = (overrides: Partial<Record<(typeof RELEASE_JOBS)[number], string | null>> = {}): ReleaseJob[] =>
    RELEASE_JOBS.map((name) => ({ name, conclusion: name in overrides ? (overrides[name] ?? null) : "success" }));

  test("a fully green run needs no recovery", () => {
    expect(gateOutcome(jobs())).toEqual({ needsRecovery: false, problems: [] });
  });

  test("a failed promote alone defers to a recovery run", () => {
    expect(gateOutcome(jobs({ promote: "failure" }))).toEqual({ needsRecovery: true, problems: [] });
  });

  test("a failed publication job blocks the closeout", () => {
    const outcome = gateOutcome(jobs({ publish: "failure" }));
    expect(outcome.problems.join("\n")).toContain("publish ended failure");
  });

  test("a job the workflow no longer has is reported, not recorded", () => {
    const outcome = gateOutcome(jobs().filter((job) => job.name !== "promote"));
    expect(outcome.problems.join("\n")).toContain('no "promote" job');
  });
});

describe("parseReceipt", () => {
  const receipt = {
    schemaVersion: 1,
    result: "promoted",
    tag: "v0.6.3",
    version: "0.6.3",
    releaseCommit: "abc",
    tapCommit: "def",
    completedAt: "2026-09-26T00:00:00.000Z",
    channelUrl: "https://example.com/desktop.json",
    daemonChannelUrl: "https://example.com/daemon.json",
  };

  test("accepts a completed promotion receipt", () => {
    expect(parseReceipt(receipt)).toMatchObject({ tag: "v0.6.3", tapCommit: "def" });
  });

  test("refuses a dry run or a changed shape", () => {
    expect(() => parseReceipt({ ...receipt, result: "dry-run" })).toThrow("promotion receipt");
    expect(() => parseReceipt({ ...receipt, schemaVersion: 2 })).toThrow("promotion receipt");
    expect(() => parseReceipt({ ...receipt, tapCommit: 42 })).toThrow("promotion receipt");
  });
});

describe("receiptArtifactName", () => {
  test("prefers the latest attempt's unexpired artifact for the run", () => {
    const artifacts = [
      { name: "release-promotion-100-1", expired: true },
      { name: "release-promotion-100-2", expired: false },
      { name: "release-promotion-200-1", expired: false },
      { name: "release-linux-assets", expired: false },
    ];
    expect(receiptArtifactName(artifacts, 100)).toBe("release-promotion-100-2");
    expect(receiptArtifactName(artifacts, 200)).toBe("release-promotion-200-1");
    expect(receiptArtifactName(artifacts, 300)).toBeNull();
  });
});

describe("tapProblems", () => {
  const DARWIN_SHA = "a".repeat(64);
  const DESKTOP_SHA = "b".repeat(64);
  const state: TapState = {
    daemonChannel: JSON.stringify({ version: "0.6.3" }),
    desktopChannel: JSON.stringify({ version: "0.6.3" }),
    formula: `url "https://github.com/Pepewitch/wisp/releases/download/v0.6.3/wisp-v0.6.3-darwin-arm64.tar.gz"\nsha256 "${DARWIN_SHA}"`,
    cask: `version "0.6.3"\nsha256 "${DESKTOP_SHA}"`,
    darwinSums: `${DARWIN_SHA}  wisp-v0.6.3-darwin-arm64.tar.gz\n${"c".repeat(64)}  release-manifest-darwin-arm64.json`,
    desktopSums: `${DESKTOP_SHA}  wisp-desktop-v0.6.3-darwin-arm64.tar.gz`,
  };

  test("accepts a converged tap", () => {
    expect(tapProblems("0.6.3", state)).toEqual([]);
  });

  test("names every channel, recipe, and checksum that disagrees", () => {
    const problems = tapProblems("0.6.3", {
      ...state,
      daemonChannel: JSON.stringify({ version: "0.6.2" }),
      formula: state.formula.replace(DARWIN_SHA, "f".repeat(64)),
      cask: state.cask.replace('version "0.6.3"', 'version "0.6.2"'),
    });
    expect(problems.join("\n")).toContain("daemon update channel serves \"0.6.2\"");
    expect(problems.join("\n")).toContain("Formula's sha256");
    expect(problems.join("\n")).toContain("Cask serves \"0.6.2\"");
  });

  test("flags a Formula that still points at the previous release", () => {
    const formula = state.formula.replaceAll("v0.6.3", "v0.6.2");
    expect(tapProblems("0.6.3", { ...state, formula }).join("\n")).toContain("does not install this release");
  });
});

describe("passedSourceChecks", () => {
  function checkRun(name: string, conclusion: string | null = "success"): CheckRun {
    return {
      name,
      status: "completed",
      conclusion,
      started_at: "2026-09-25T10:00:00Z",
      html_url: null,
      app: { slug: "github-actions" },
    };
  }

  test("lists the passed checks in ledger order", () => {
    const { labels, missing } = passedSourceChecks(SOURCE_CHECK_LABELS.map(([check]) => checkRun(check)));
    expect(labels).toEqual(SOURCE_CHECK_LABELS.map(([, label]) => label));
    expect(missing).toEqual([]);
  });

  test("a skipped promotion dry-run is normal on a release-only PR", () => {
    const { labels, missing } = passedSourceChecks(
      SOURCE_CHECK_LABELS.filter(([check]) => check !== "public-promotion-dry-run").map(([check]) => checkRun(check)),
    );
    expect(labels).not.toContain("public-promotion dry-run");
    expect(missing).toEqual([]);
  });

  test("a core check that did not pass must be verified by hand", () => {
    const { labels, missing } = passedSourceChecks([
      ...SOURCE_CHECK_LABELS.map(([check]) => checkRun(check)),
      checkRun("test", "failure"),
    ]);
    expect(labels).not.toContain("test");
    expect(missing).toEqual(["test"]);
  });
});

describe("releasePullRequest", () => {
  test("picks the PR that merged the commit to main", () => {
    const pulls = [
      { number: 1, merged_at: null, base: { ref: "main" } },
      { number: 2, merged_at: "2026-09-25T11:06:07Z", base: { ref: "main" } },
      { number: 3, merged_at: "2026-09-25T11:06:07Z", base: { ref: "feature" } },
    ];
    expect(releasePullRequest(pulls)).toBe(2);
    expect(releasePullRequest([])).toBeNull();
  });
});
