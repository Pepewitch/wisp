import { describe, expect, test } from "bun:test";
import { classifyCheck, countingChecks, missingRequired, type PrCheck } from "../src/autopilot/checks";
import { FRESH_HEAD_MS, mergeGate, type GateInput } from "../src/autopilot/gate";
import { mergeMethod, parseRequiredChecks, parseSnapshot, type PrReview, type PrSnapshot } from "../src/autopilot/github";
import { parseVerdict } from "../src/autopilot/verdict";

const HEAD = "a".repeat(40);
const OLD = "b".repeat(40);
const NOW = Date.parse("2026-09-23T12:00:00Z");

function check(name: string, conclusion: string | null, over: Partial<PrCheck> = {}): PrCheck {
  return { name, status: conclusion === null ? "IN_PROGRESS" : "COMPLETED", conclusion, required: false, url: "", ...over };
}
function review(over: Partial<PrReview>): PrReview {
  return { author: "owner", association: "OWNER", bot: false, state: "COMMENTED", body: "", commit: HEAD, submittedAt: "2026-09-23T11:00:00Z", ...over };
}
function pr(over: Partial<PrSnapshot> = {}): PrSnapshot {
  return {
    number: 7, url: "https://github.com/o/r/pull/7", state: "OPEN", isDraft: false, isCrossRepository: false,
    head: HEAD, headRefName: "wisp/t1-x", baseRefName: "main", defaultBranch: "main", mergeState: "CLEAN",
    reviewDecision: null, queued: false, providerAutoMerge: false, mergedBy: null, viewer: "owner",
    checks: [check("test", "SUCCESS")], actionsSuitesPending: 0, reviews: [], unresolvedThreads: 0, mergeMethod: "SQUASH",
    ...over,
  };
}
function gate(over: Partial<GateInput> & { pr?: PrSnapshot } = {}) {
  return mergeGate({
    pr: pr(), requiredNames: new Set(), allowedBases: new Set(["main"]),
    headFirstSeenMs: NOW - FRESH_HEAD_MS - 1, nowMs: NOW, published: { ok: true }, ...over,
  });
}

describe("verdict lines", () => {
  test("every form the owner's reviewers have written reads correctly, and anything else fails closed", () => {
    expect(parseVerdict("Verdict: APPROVE — no blocking findings.\n\n## What the PR does")).toBe("approve");
    expect(parseVerdict("**Verdict: APPROVE — …**")).toBe("approve");
    expect(parseVerdict("**Verdict: request changes** — the retry never stops")).toBe("blocking");
    expect(parseVerdict("Verdict: REQUEST_CHANGES")).toBe("blocking");
    expect(parseVerdict("Verdict: CHANGES REQUEST")).toBe("blocking");
    expect(parseVerdict("Verdict: changes requested")).toBe("blocking");
    expect(parseVerdict("## Verdict\n\n**CHANGES REQUESTED** — two findings")).toBe("blocking");
    expect(parseVerdict("## Verdict\nApproved")).toBe("approve");
    expect(parseVerdict("Verdict: looks mostly fine")).toBe("unparseable");
    // an approving word does not outweigh a request for changes, or a condition
    expect(parseVerdict("Verdict: Approve with changes requested")).toBe("blocking");
    expect(parseVerdict("Verdict: APPROVE after the blocking issue below is fixed")).toBe("unparseable");
    expect(parseVerdict("Verdict: Approved? No — request changes")).toBe("blocking");
    expect(parseVerdict("Verdict: BLOCKING — two issues")).toBe("blocking");
    // a verdict is read wherever it sits, not only on the first line
    expect(parseVerdict("# Review of #267\n\n**Verdict:** CHANGES REQUESTED")).toBe("blocking");
    expect(parseVerdict("## Verdict")).toBe("unparseable");
    expect(parseVerdict("Nice work, one nit below.")).toBeNull();
    expect(parseVerdict("   \n")).toBeNull();
  });
});

describe("check classification", () => {
  test("a result is pass, fix, hold, or pending — and an unknown conclusion holds", () => {
    expect(["SUCCESS", "NEUTRAL", "SKIPPED"].map((c) => classifyCheck(check("x", c)))).toEqual(["pass", "pass", "pass"]);
    expect(["FAILURE", "TIMED_OUT", "STARTUP_FAILURE"].map((c) => classifyCheck(check("x", c)))).toEqual(["fix", "fix", "fix"]);
    expect(["CANCELLED", "STALE", "ACTION_REQUIRED", "SOMETHING_NEW"].map((c) => classifyCheck(check("x", c)))).toEqual(["hold", "hold", "hold", "hold"]);
    expect(classifyCheck(check("x", null))).toBe("pending");
    // commit statuses carry the outcome in `status`
    expect(["SUCCESS", "FAILURE", "ERROR", "PENDING", "EXPECTED"].map((s) => classifyCheck({ name: "ci/x", status: s, conclusion: null, required: false, url: "" })))
      .toEqual(["pass", "fix", "fix", "pending", "pending"]);
  });

  test("with required checks only they count; with none every check counts; missing required ones are named", () => {
    const checks = [check("test", "SUCCESS", { required: true }), check("native-core", "FAILURE")];
    expect(countingChecks(checks, new Set(["test"])).map((c) => c.name)).toEqual(["test"]);
    expect(countingChecks(checks, new Set()).map((c) => c.name)).toEqual(["test", "native-core"]);
    expect(missingRequired(checks, new Set(["test", "supply-chain"]))).toEqual(["supply-chain"]);
  });
});

describe("the merge gate", () => {
  test("a clean, green, published PR merges", () => {
    expect(gate()).toEqual({ kind: "merge" });
    expect(gate({ pr: pr({ mergeState: "HAS_HOOKS" }) })).toEqual({ kind: "merge" });
  });

  test("a draft or a PR onto another base never merges", () => {
    expect(gate({ pr: pr({ isDraft: true }) })).toMatchObject({ kind: "needs-you", reason: expect.stringContaining("Draft") });
    expect(gate({ pr: pr({ baseRefName: "wisp/parent" }) })).toEqual({ kind: "needs-you", reason: "Targets wisp/parent; auto-merge only merges into main" });
    expect(gate({ pr: pr({ baseRefName: "develop" }), allowedBases: new Set(["main", "develop"]) })).toEqual({ kind: "merge" });
  });

  test("a fresh head is not believed green until its checks had time to appear", () => {
    const fresh = { headFirstSeenMs: NOW - 1000 };
    expect(gate({ ...fresh, pr: pr({ checks: [] }) })).toEqual({ kind: "wait", reason: "Waiting for checks to start" });
    expect(gate({ pr: pr({ actionsSuitesPending: 2, checks: [] }) })).toEqual({ kind: "wait", reason: "Waiting for checks to start" });
    expect(gate({ pr: pr({ actionsSuitesPending: 1, checks: [check("test", null)] }) })).toEqual({ kind: "wait", reason: "Waiting for checks (1 running)" });
    // a head nobody timed is as fresh as it gets
    expect(gate({ headFirstSeenMs: Number.NaN })).toEqual({ kind: "wait", reason: "Waiting for checks to start" });
  });

  test("red, held, and pending checks each say what they are", () => {
    expect(gate({ pr: pr({ checks: [check("test", "FAILURE")] }) })).toEqual({ kind: "needs-you", reason: "test failed" });
    expect(gate({ pr: pr({ checks: [check("test", "CANCELLED")] }) })).toEqual({ kind: "needs-you", reason: "test did not finish — rerun it" });
    expect(gate({ pr: pr({ checks: [check("deploy", "ACTION_REQUIRED")] }) })).toEqual({ kind: "needs-you", reason: "deploy needs approval" });
    expect(gate({ pr: pr({ checks: [check("test", null)] }) })).toEqual({ kind: "wait", reason: "Waiting for checks (1 running)" });
    const many = [check("a", "FAILURE"), check("b", "FAILURE"), check("c", "FAILURE")];
    expect(gate({ pr: pr({ checks: many }) })).toEqual({ kind: "needs-you", reason: "a, b and 1 more failed" });
  });

  test("UNSTABLE merges only when every red check is outside the required set", () => {
    const checks = [check("test", "SUCCESS", { required: true }), check("native-core", "FAILURE")];
    expect(gate({ pr: pr({ mergeState: "UNSTABLE", checks }), requiredNames: new Set(["test"]) })).toEqual({ kind: "merge" });
    // no required checks: the absence of rules is read strictly
    expect(gate({ pr: pr({ mergeState: "UNSTABLE", checks }) })).toEqual({ kind: "needs-you", reason: "native-core failed" });
    // and UNSTABLE there is GitHub seeing a red check Wisp did not: never mergeable
    expect(gate({ pr: pr({ mergeState: "UNSTABLE" }) })).toEqual({ kind: "needs-you", reason: "GitHub reports a failing check" });
    // a required check that has not reported yet is waited for, not assumed
    expect(gate({ pr: pr({ checks: [check("native-core", "SUCCESS")] }), requiredNames: new Set(["test"]) }))
      .toEqual({ kind: "wait", reason: "Waiting for test to report" });
  });

  test("BLOCKED is explained from what GitHub reports, never guessed as an approval wait", () => {
    expect(gate({ pr: pr({ mergeState: "BLOCKED", unresolvedThreads: 2 }) })).toEqual({ kind: "needs-you", reason: "2 unresolved conversations" });
    expect(gate({ pr: pr({ mergeState: "BLOCKED", reviewDecision: "REVIEW_REQUIRED" }) })).toEqual({ kind: "wait", reason: "Waiting for an approving review", slow: true });
    expect(gate({ pr: pr({ mergeState: "BLOCKED" }) })).toEqual({ kind: "needs-you", reason: "Blocked by a branch rule" });
    expect(gate({ pr: pr({ mergeState: "DIRTY" }) })).toEqual({ kind: "needs-you", reason: "Conflicts with main" });
    expect(gate({ pr: pr({ mergeState: "UNKNOWN" }) })).toMatchObject({ kind: "wait" });
  });

  test("a reviewer who blocked must pass the current head; an approval on an older head is not enough", () => {
    const blocked = review({ body: "Verdict: CHANGES REQUESTED — retry never stops", commit: OLD, submittedAt: "2026-09-23T10:00:00Z" });
    expect(gate({ pr: pr({ reviews: [blocked] }) })).toEqual({ kind: "wait", reason: "Waiting for the reviewer to pass aaaaaaa", slow: true });
    const passedOld = review({ body: "Verdict: APPROVE", commit: OLD, submittedAt: "2026-09-23T10:30:00Z" });
    expect(gate({ pr: pr({ reviews: [blocked, passedOld] }) })).toMatchObject({ kind: "wait" });
    const passedHead = review({ body: "Verdict: APPROVE", commit: HEAD, submittedAt: "2026-09-23T11:00:00Z" });
    expect(gate({ pr: pr({ reviews: [blocked, passedHead] }) })).toEqual({ kind: "merge" });
    // an approval from somebody else does not answer this reviewer's block
    expect(gate({ pr: pr({ reviews: [blocked, { ...passedHead, author: "someone" }] }) })).toMatchObject({ kind: "wait" });
  });

  test("a formal change request is never overridden by an approving line in its own body", () => {
    const formal = review({ author: "colleague", association: "MEMBER", state: "CHANGES_REQUESTED", body: "Verdict: APPROVE" });
    expect(gate({ pr: pr({ reviews: [formal] }) })).toEqual({ kind: "needs-you", reason: "Changes requested by @colleague" });
  });

  test("approvals and plain feedback never block; unreadable verdicts and empty change requests need a person", () => {
    expect(gate({ pr: pr({ reviews: [review({ body: "Verdict: APPROVE — nits below" })] }) })).toEqual({ kind: "merge" });
    expect(gate({ pr: pr({ reviews: [review({ body: "One nit on naming." })] }) })).toEqual({ kind: "merge" });
    expect(gate({ pr: pr({ reviews: [review({ body: "Verdict: mostly fine" })] }) }))
      .toEqual({ kind: "needs-you", reason: "Couldn't read a review's verdict line" });
    expect(gate({ pr: pr({ reviews: [review({ author: "colleague", association: "MEMBER", state: "CHANGES_REQUESTED", body: "" })] }) }))
      .toEqual({ kind: "needs-you", reason: "Changes requested by @colleague with no comments" });
  });

  test("untrusted, dismissed, and pending reviews carry no weight", () => {
    const noise = [
      review({ author: "stranger", association: "NONE", body: "Verdict: CHANGES REQUESTED" }),
      review({ author: "github-actions", bot: true, body: "Verdict: CHANGES REQUESTED" }),
      review({ author: null, association: "NONE", body: "Verdict: CHANGES REQUESTED" }),
      review({ state: "DISMISSED", body: "Verdict: CHANGES REQUESTED" }),
      review({ state: "PENDING", body: "Verdict: CHANGES REQUESTED" }),
    ];
    expect(gate({ pr: pr({ reviews: noise }) })).toEqual({ kind: "merge" });
    // an installed app is trusted even though its association is NONE
    expect(gate({ pr: pr({ reviews: [review({ author: "review-bot", association: "NONE", bot: true, state: "CHANGES_REQUESTED", body: "fix x" })] }) }))
      .toEqual({ kind: "needs-you", reason: "Changes requested by @review-bot" });
  });

  test("the worktree is checked last, and its reason is shown as is", () => {
    expect(gate({ published: { ok: false, reason: "Worktree has unpushed commits" } }))
      .toEqual({ kind: "needs-you", reason: "Worktree has unpushed commits" });
  });
});

describe("reading GitHub", () => {
  const raw = (over: Record<string, unknown> = {}) => ({
    data: {
      viewer: { login: "owner" },
      repository: {
        defaultBranchRef: { name: "main" }, squashMergeAllowed: true, mergeCommitAllowed: true, rebaseMergeAllowed: true, viewerDefaultMergeMethod: "MERGE",
        pullRequest: {
          number: 7, url: "https://github.com/o/r/pull/7", state: "OPEN", isDraft: false, isCrossRepository: false, mergedBy: null,
          headRefOid: HEAD, headRefName: "wisp/t1-x", baseRefName: "main", mergeStateStatus: "CLEAN", reviewDecision: null,
          mergeQueueEntry: null, autoMergeRequest: null,
          reviewThreads: { nodes: [{ isResolved: true }, { isResolved: false }] },
          reviews: { nodes: [{ state: "COMMENTED", body: "Verdict: APPROVE", submittedAt: "2026-09-23T11:00:00Z", authorAssociation: "OWNER", author: { login: "owner", __typename: "User" }, commit: { oid: HEAD } }] },
          commits: { nodes: [{ commit: {
            oid: HEAD,
            checkSuites: { nodes: [{ status: "COMPLETED", workflowRun: { databaseId: 1 } }, { status: "QUEUED", workflowRun: null }] },
            statusCheckRollup: { contexts: { nodes: [
              { __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS", detailsUrl: "u", isRequired: true },
              { __typename: "StatusContext", context: "ci/legacy", state: "PENDING", targetUrl: "v", isRequired: false },
            ] } },
          } }] },
          ...over,
        },
      },
    },
  });

  test("one document becomes one snapshot, and a queued non-Actions suite is not waited on", () => {
    const snapshot = parseSnapshot(raw());
    expect(snapshot).toMatchObject({ number: 7, head: HEAD, defaultBranch: "main", mergeMethod: "SQUASH", unresolvedThreads: 1, actionsSuitesPending: 0, viewer: "owner" });
    expect(snapshot.checks).toEqual([
      { name: "test", status: "COMPLETED", conclusion: "SUCCESS", required: true, url: "u" },
      { name: "ci/legacy", status: "PENDING", conclusion: null, required: false, url: "v" },
    ]);
    expect(snapshot.reviews[0]).toMatchObject({ author: "owner", commit: HEAD, bot: false });
  });

  test("a head that moved between the PR row and its checks is refused, not paired", () => {
    expect(() => parseSnapshot(raw({ headRefOid: OLD }))).toThrow("PR changed during the check");
    // and a head with no commit row at all is not a head with no checks
    expect(() => parseSnapshot(raw({ commits: { nodes: [] } }))).toThrow("PR changed during the check");
  });

  test("more checks than one page holds is refused rather than half-read", () => {
    const base = raw();
    const commit = (base.data.repository.pullRequest as { commits: { nodes: { commit: Record<string, unknown> }[] } }).commits.nodes[0]!.commit;
    (commit.statusCheckRollup as { contexts: Record<string, unknown> }).contexts.pageInfo = { hasNextPage: true };
    expect(() => parseSnapshot(base)).toThrow("Too many checks");
  });

  test("merge method prefers squash, then the only allowed method, then the viewer's default", () => {
    expect(mergeMethod({ squashMergeAllowed: true, mergeCommitAllowed: true })).toBe("SQUASH");
    expect(mergeMethod({ squashMergeAllowed: false, rebaseMergeAllowed: true })).toBe("REBASE");
    expect(mergeMethod({ mergeCommitAllowed: true, rebaseMergeAllowed: true, viewerDefaultMergeMethod: "REBASE" })).toBe("REBASE");
  });

  test("required checks come from classic protection and rulesets, and an off switch means none", () => {
    const branch = { protection: { required_status_checks: { enforcement_level: "everyone", contexts: ["test"], checks: [{ context: "supply-chain" }] } } };
    const rules = [{ type: "required_status_checks", parameters: { required_status_checks: [{ context: "browser-security" }] } }, { type: "deletion" }];
    expect(parseRequiredChecks(branch, rules)).toEqual(["browser-security", "supply-chain", "test"]);
    expect(parseRequiredChecks({ protection: { required_status_checks: { enforcement_level: "off", contexts: ["x"] } } }, [])).toEqual([]);
  });
});
