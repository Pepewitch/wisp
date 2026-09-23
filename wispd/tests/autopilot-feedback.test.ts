import { describe, expect, test } from "bun:test";
import type { PrCheck } from "../src/autopilot/checks";
import { feedbackItems, feedbackKey, feedbackSummary, isMarked, keyParts, markerOf, pairedChecks, withDelivered, type FeedbackInput } from "../src/autopilot/feedback";
import type { PrComment, PrReview, PrSnapshot, PrThread } from "../src/autopilot/github";

const HEAD = "a".repeat(40);
const OWNER = "owner";

function comment(over: Partial<PrComment> = {}): PrComment {
  return { id: "IC_1", author: OWNER, association: "OWNER", bot: false, body: "Please rename this.", createdAt: "2026-09-24T10:00:00Z", editedAt: null, url: "https://gh/c/1", ...over };
}
function thread(over: Partial<PrThread> = {}, comments: PrComment[] = [comment({ id: "RC_1" })]): PrThread {
  return { id: "PRRT_1", resolved: false, outdated: false, path: "src/a.ts", line: 12, starter: comments[0] ?? null, comments, ...over };
}
function review(over: Partial<PrReview> = {}): PrReview {
  return {
    id: "PRR_1", author: OWNER, association: "OWNER", bot: false, state: "COMMENTED", body: "Verdict: not safe to merge\n\n1. the race",
    commit: HEAD, submittedAt: "2026-09-24T10:00:00Z", editedAt: null, url: "https://gh/r/1", ...over,
  };
}
function pr(over: Partial<PrSnapshot> = {}): PrSnapshot {
  return {
    number: 7, url: "https://github.com/o/r/pull/7", state: "OPEN", isDraft: false, isCrossRepository: false,
    head: HEAD, headRefName: "wisp/t-x", baseRefName: "main", defaultBranch: "main", mergeState: "BLOCKED",
    reviewDecision: null, queued: false, providerAutoMerge: false, mergedBy: null, viewer: OWNER,
    checks: [], actionsSuitesPending: 0, actionsSuitesWaiting: 0, reviews: [], threads: [], comments: [],
    unresolvedThreads: 0, mergeMethod: "SQUASH", baseHead: null, baseChecks: [], ...over,
  };
}
const check = (name: string, conclusion: string, app: string): PrCheck => ({ name, status: "COMPLETED", conclusion, required: false, url: `https://ci/${name}`, app });

const pushers = new Set(["colleague"]);
function items(over: Partial<PrSnapshot>, input: Partial<FeedbackInput> = {}) {
  return feedbackItems({
    pr: pr(over),
    trusts: ({ author, bot }) => author !== null && (author === OWNER || (bot && author !== "github-actions") || pushers.has(author)),
    self: (c) => isMarked(c.body),
    delivered: {},
    ...input,
  });
}

describe("whose words reach the agent", () => {
  test("the owner, bots, and people who can push; never github-actions, a ghost, or someone without write access", () => {
    expect(items({ threads: [thread()] }).map((item) => item.id)).toEqual(["thread:PRRT_1"]);
    expect(items({ threads: [thread({}, [comment({ author: "colleague", association: "MEMBER" })])] })).toHaveLength(1);
    // MEMBER alone is not trust: it can mean read or triage access
    expect(items({ threads: [thread({}, [comment({ author: "reader", association: "MEMBER" })])] })).toEqual([]);
    expect(items({ threads: [thread({}, [comment({ author: "copilot-pull-request-reviewer", bot: true })])] })).toHaveLength(1);
    expect(items({ threads: [thread({}, [comment({ author: "github-actions", bot: true })])] })).toEqual([]);
    expect(items({ threads: [thread({}, [comment({ author: null })])] })).toEqual([]);
    // an untrusted "approve" is nothing at all, and a trusted one is the gate's business
    expect(items({ reviews: [review({ author: "reader", association: "MEMBER", body: "Verdict: APPROVE" })] })).toEqual([]);
    expect(items({ reviews: [review({ body: "Verdict: APPROVE — no blocking findings." })] })).toEqual([]);
  });

  test("the agent's own posts are never fed back to it", () => {
    const own = comment({ body: `Addressed in abc1234.\n\n— droid via Wisp ${markerOf("t1")}` });
    expect(isMarked(own.body)).toBe(true);
    expect(items({ threads: [thread({}, [own])], comments: [own] })).toEqual([]);
    expect(items({ reviews: [review({ body: `Verdict: blocking ${markerOf("t2")}` })] })).toEqual([]);
    // the caller's window rule: the owner's account inside an unmarked turn
    expect(items({ comments: [comment()] }, { self: () => true })).toEqual([]);
  });
});

describe("what counts as an item", () => {
  test("a blocking or unreadable verdict, a change request with a body, or plain feedback; never an approval or an empty review", () => {
    expect(items({ reviews: [review()] })).toMatchObject([{ kind: "review", id: "review:PRR_1", fingerprint: "2026-09-24T10:00:00Z" }]);
    expect(items({ reviews: [review({ body: "Verdict: maybe?" })] })).toHaveLength(1);
    expect(items({ reviews: [review({ author: "colleague", association: "MEMBER", state: "CHANGES_REQUESTED", body: "Split this function." })] })).toHaveLength(1);
    expect(items({ reviews: [review({ body: "Looks fine, but consider a test for the empty case." })] })).toHaveLength(1);
    expect(items({ reviews: [review({ state: "APPROVED", body: "" })] })).toEqual([]);
    expect(items({ reviews: [review({ state: "APPROVED", body: "Nice work" })] })).toEqual([]);
    // an empty change request has nothing to act on: the gate says "needs you"
    expect(items({ reviews: [review({ state: "CHANGES_REQUESTED", body: "" })] })).toEqual([]);
    expect(items({ reviews: [review({ state: "DISMISSED" }), review({ id: "PRR_2", state: "PENDING" })] })).toEqual([]);
  });

  test("a conversation comment is feedback; a thank-you is not", () => {
    expect(items({ comments: [comment({ body: "Can you also update the docs?" })] })).toMatchObject([{ kind: "comment", id: "comment:IC_1" }]);
    expect(items({ comments: [comment({ body: "LGTM!" }), comment({ id: "IC_2", body: "thanks" })] })).toEqual([]);
  });

  test("a bot's status board is noise; its red check makes it feedback, once per head", () => {
    const board = comment({ id: "IC_9", author: "preview-bot", bot: true, association: "NONE", body: "Preview ready at https://…", editedAt: "2026-09-24T11:00:00Z" });
    expect(items({ comments: [board] })).toEqual([]);
    expect(items({ comments: [{ ...board, body: "Verdict: blocking — the migration drops a column" }] })).toHaveLength(1);
    const sticky = comment({ id: "IC_8", author: "pr-reviewer", bot: true, body: "## Findings\n1. a leak" });
    expect(items({ comments: [sticky], checks: [check("pr-reviewer", "SUCCESS", "pr-reviewer")] })).toEqual([]);
    const red = items({ comments: [sticky], checks: [check("pr-reviewer", "FAILURE", "pr-reviewer")] });
    expect(red).toMatchObject([{ kind: "comment", fingerprint: `head:${HEAD}`, check: { name: "pr-reviewer" } }]);
    // sent for this head: silent until a new head is red again
    const delivered = { "comment:IC_8": `head:${HEAD}` };
    expect(items({ comments: [sticky], checks: [check("pr-reviewer", "FAILURE", "pr-reviewer")] }, { delivered })).toEqual([]);
    expect(items({ head: "b".repeat(40), comments: [sticky], checks: [check("pr-reviewer", "FAILURE", "pr-reviewer")] }, { delivered })).toHaveLength(1);
    // and its check is not CI's to send as well
    expect([...pairedChecks(pr({ comments: [sticky], checks: [check("pr-reviewer", "FAILURE", "pr-reviewer"), check("test", "FAILURE", "github-actions")] }))]).toEqual(["pr-reviewer"]);
  });
});

describe("the ledger", () => {
  test("an item is sent once; a reply or an edit is new, and only the new words are marked fresh", () => {
    const first = items({ threads: [thread()] });
    const delivered = Object.fromEntries(first.map((item) => [item.id, item.fingerprint]));
    expect(items({ threads: [thread()] }, { delivered })).toEqual([]);
    const reply = comment({ id: "RC_2", body: "Still wrong: the null case.", createdAt: "2026-09-24T12:00:00Z" });
    const again = items({ threads: [thread({}, [comment({ id: "RC_1" }), reply])] }, { delivered });
    expect(again).toHaveLength(1);
    if (again[0]!.kind !== "thread") throw new Error("expected a thread");
    expect(again[0]!.fresh.map((c) => c.id)).toEqual(["RC_2"]);
    expect(again[0]!.comments.map((c) => c.id)).toEqual(["RC_1", "RC_2"]);
    const edited = items({ threads: [thread({}, [comment({ id: "RC_1", editedAt: "2026-09-24T13:00:00Z" })])] }, { delivered });
    expect(edited).toHaveLength(1);
  });

  test("a resolved thread nobody sent was settled by a person; one Wisp sent comes back on a newer trusted reply", () => {
    expect(items({ threads: [thread({ resolved: true })] })).toEqual([]);
    const delivered = { "thread:PRRT_1": "2026-09-24T10:00:00Z" };
    expect(items({ threads: [thread({ resolved: true })] }, { delivered })).toEqual([]);
    const stillWrong = comment({ id: "RC_2", body: "This is still wrong.", createdAt: "2026-09-24T12:00:00Z" });
    expect(items({ threads: [thread({ resolved: true }, [comment({ id: "RC_1" }), stillWrong])] }, { delivered }))
      .toMatchObject([{ kind: "thread", reopened: true }]);
    // an untrusted reply does not reopen it
    const drive = comment({ id: "RC_3", author: "reader", body: "+1 still wrong", createdAt: "2026-09-24T12:00:00Z" });
    expect(items({ threads: [thread({ resolved: true }, [comment({ id: "RC_1" }), drive])] }, { delivered })).toEqual([]);
  });

  test("the agent may resolve threads the owner or a bot started, never a colleague's", () => {
    expect(items({ threads: [thread()] })).toMatchObject([{ mayResolve: true }]);
    expect(items({ threads: [thread({}, [comment({ author: "copilot-pull-request-reviewer", bot: true })])] })).toMatchObject([{ mayResolve: true }]);
    expect(items({ threads: [thread({}, [comment({ author: "colleague", association: "MEMBER" })])] })).toMatchObject([{ mayResolve: false }]);
    expect(items({ threads: [thread({ outdated: true })] })).toMatchObject([{ thread: { outdated: true } }]);
  });

  test("a round's key names every item, so a Skip or a cancel marks exactly those handled", () => {
    const found = items({ threads: [thread()], reviews: [review()], comments: [comment({ id: "IC_5", body: "Docs too?" })] });
    expect(feedbackSummary(found)).toBe("1 review thread, 1 review, 1 comment");
    const key = `ci:${HEAD}:test|${feedbackKey(found)}`;
    const parts = keyParts(key);
    expect(parts.ci).toBe(`ci:${HEAD}:test`);
    expect(parts.delivered).toEqual({
      "thread:PRRT_1": "2026-09-24T10:00:00Z", "review:PRR_1": "2026-09-24T10:00:00Z", "comment:IC_5": "2026-09-24T10:00:00Z",
    });
    expect(keyParts(`conflict:${HEAD}:b`)).toEqual({ ci: `conflict:${HEAD}:b`, delivered: {} });
    // bounded, newest kept
    const big = withDelivered(Object.fromEntries(Array.from({ length: 250 }, (_, n) => [`comment:${n}`, "t"])), { "comment:new": "t" });
    expect(Object.keys(big)).toHaveLength(200);
    expect(big["comment:new"]).toBe("t");
    expect(big["comment:0"]).toBeUndefined();
  });
});
