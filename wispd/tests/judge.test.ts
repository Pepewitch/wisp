import { describe, expect, test } from "bun:test";
import type { PrSnapshot } from "../src/autopilot/github";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import {
  JEV_MODEL, JEV_URL, PASS_WAIT_MS, jevBody, jevClient, jevKey, judgedHead, judgeLogPath, judgeLook, judgeUndecided, judgeUsage, listsFindings, needsChanges, sentText, writeJudgeLog,
  type JudgeAnswer, type JudgeCandidate, type Judged, type JudgeLogEntry,
} from "../src/autopilot/judge";

const HEAD = "a".repeat(40);
const answer = (over: Partial<JudgeAnswer> = {}): JudgeAnswer => ({ kind: "needs_changes", confidence: 0.97, probabilities: { needs_changes: 0.97 }, model: JEV_MODEL, inputTokens: 900, ...over });
const candidate = (over: Partial<JudgeCandidate> = {}): JudgeCandidate => {
  const fp = over.fp ?? "2026-09-24T10:00:00Z";
  return { id: "comment:IC_1", fp, order: fp, text: "**Medium**: the retry never stops", postedAs: "comment", bot: true, author: "reviewer", url: "https://gh/c/1", ...over };
};

function fakeFetch(respond: (init: RequestInit) => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init! });
    return respond(init!);
  }) as typeof fetch;
  return { calls, fetcher };
}

describe("what is sent to Jev", () => {
  test("only the text, whether a bot wrote it, and where it was posted, to a pinned model", () => {
    expect(jevBody({ text: "Please fix the leak.", bot: true, postedAs: "review" })).toMatchObject({
      model: "jev-1.13.0",
      state: { author: "a bot", posted_as: "the body of a pull request review", text: "Please fix the leak." },
      questions: { kind: { type: "choice", criteria: expect.objectContaining({ needs_changes: expect.any(String), minor_only: expect.any(String), all_clear: expect.any(String), status: expect.any(String), reply: expect.any(String) }) } },
    });
    const long = jevBody({ text: "x".repeat(20_000), bot: false, postedAs: "comment" }) as { state: { text: string; author: string } };
    expect(long.state.author).toBe("a person");
    expect(long.state.text.length).toBeLessThan(8_100);
    expect(long.state.text.endsWith("…(truncated)")).toBe(true);
    // never half a character: an emoji straddling the cut goes whole
    expect(sentText(`${"x".repeat(7_999)}🚀tail`)).toBe(`${"x".repeat(7_999)}\n…(truncated)`);
  });

  test("the client sends the key as a bearer token and reads a typed answer", async () => {
    const { calls, fetcher } = fakeFetch(() => Response.json({
      model: "jev-1.13.0", usage: { input_tokens: 812, output_tokens: 40 },
      answers: { kind: { type: "choice", choice: "minor_only", confidence: 0.88, probabilities: { minor_only: 0.88, needs_changes: 0.1 } } },
    }));
    const judged = await jevClient("jev_secret", fetcher)({ text: "nit: rename", bot: true, postedAs: "comment" }, new AbortController().signal);
    expect(judged).toEqual({ kind: "minor_only", confidence: 0.88, probabilities: { minor_only: 0.88, needs_changes: 0.1 }, model: "jev-1.13.0", inputTokens: 812 });
    expect(calls[0]!.url).toBe(JEV_URL);
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer jev_secret");
    // nothing but the documented body: no repository, PR number or login
    expect(Object.keys(JSON.parse(String(calls[0]!.init.body)))).toEqual(["model", "state", "questions"]);
  });

  test("an approval is asked only whether it lists findings, and the answer maps to its own kinds", async () => {
    expect(jevBody({ text: "Verdict: APPROVE", bot: false, postedAs: "review", question: "findings" })).toMatchObject({
      questions: { findings: { type: "choice", criteria: { none: expect.any(String), one: expect.any(String), several: expect.any(String) } } },
    });
    expect(Object.keys((jevBody({ text: "x", bot: false, postedAs: "review", question: "findings" }) as { questions: object }).questions)).toEqual(["findings"]);
    const { fetcher } = fakeFetch(() => Response.json({ model: JEV_MODEL, usage: { input_tokens: 600 }, answers: { findings: { type: "choice", choice: "several", confidence: 0.99, probabilities: { several: 0.99 } } } }));
    expect(await jevClient("k", fetcher)({ text: "x", bot: false, postedAs: "review", question: "findings" }, new AbortController().signal)).toMatchObject({ kind: "several_findings", confidence: 0.99 });
    // an answer to the other question is no answer to this one
    const wrong = fakeFetch(() => Response.json({ answers: { kind: { choice: "needs_changes", confidence: 1 } } }));
    await expect(jevClient("k", wrong.fetcher)({ text: "x", bot: false, postedAs: "review", question: "findings" }, new AbortController().signal)).rejects.toThrow("unexpected shape");
    expect(listsFindings({ kind: "one_finding", confidence: 0.9, model: JEV_MODEL })).toBe(true);
    expect(listsFindings({ kind: "several_findings", confidence: 0.5, model: JEV_MODEL })).toBe(false);
    expect(listsFindings({ kind: "no_findings", confidence: 1, model: JEV_MODEL })).toBe(false);
  });

  test("an HTTP error or an answer it cannot read is an error, never a guess", async () => {
    const signal = new AbortController().signal;
    const request = { text: "x", bot: true, postedAs: "comment" } as const;
    await expect(jevClient("k", fakeFetch(() => new Response("no", { status: 401 })).fetcher)(request, signal)).rejects.toThrow("Jev answered HTTP 401");
    await expect(jevClient("k", fakeFetch(() => Response.json({ answers: { kind: { choice: "ship_it", confidence: 1 } } })).fetcher)(request, signal)).rejects.toThrow("unexpected shape");
  });
});

describe("when the judge decides", () => {
  test("the key saved in Settings wins over the environment's", () => {
    expect(jevKey({ jevApiKey: "saved" }, { TYPESAFE_API_KEY: "env" })).toEqual({ key: "saved", source: "settings" });
    expect(jevKey({}, { JEV_API_KEY: "env" })).toEqual({ key: "env", source: "environment" });
    expect(jevKey({}, {})).toBeNull();
  });

  test("only a confident needs_changes asks for a round", () => {
    expect(needsChanges({ kind: "needs_changes", confidence: 0.6, model: JEV_MODEL })).toBe(true);
    expect(needsChanges({ kind: "needs_changes", confidence: 0.59, model: JEV_MODEL })).toBe(false);
    expect(needsChanges({ kind: "minor_only", confidence: 1, model: JEV_MODEL })).toBe(false);
    expect(needsChanges(undefined)).toBe(false);
  });

  test("each version is judged once; a failure is logged and asked again next look", async () => {
    const asked: string[] = [];
    const logged: JudgeLogEntry[] = [];
    let fail = true;
    const client = async (request: { text: string }) => {
      asked.push(request.text);
      if (request.text === "flaky" && fail) throw new Error("Jev answered HTTP 529");
      return answer();
    };
    const run = async (candidates: JudgeCandidate[], judged?: Record<string, Judged>) => (await judgeUndecided({
      candidates, judged, client, pr: { number: 7, head: HEAD }, log: (entry) => logged.push(entry), signal: new AbortController().signal, now: () => new Date("2026-09-24T10:05:00Z"),
    })).judged;
    const first = await run([candidate(), candidate({ id: "comment:IC_2", text: "flaky" })]);
    expect(first).toEqual({ "comment:IC_1": { fp: "2026-09-24T10:00:00Z", kind: "needs_changes", confidence: 0.97, model: JEV_MODEL } });
    expect(logged.map((entry) => entry.error ?? entry.answer?.kind)).toEqual(expect.arrayContaining(["needs_changes", "Jev answered HTTP 529"]));
    expect(logged.find((entry) => entry.answer)).toMatchObject({ pr: 7, head: HEAD, item: "comment:IC_1", text: "**Medium**: the retry never stops", inputTokens: 900, prompt: "review-kind/2" });
    fail = false;
    asked.length = 0;
    const second = await run([candidate(), candidate({ id: "comment:IC_2", text: "flaky" })], first);
    // IC_1's version was answered: only the failed one is asked again
    expect(asked).toEqual(["flaky"]);
    expect(Object.keys(second)).toEqual(["comment:IC_1", "comment:IC_2"]);
    // an edit is a new version
    asked.length = 0;
    await run([candidate({ fp: "2026-09-24T11:00:00Z" })], second);
    expect(asked).toHaveLength(1);
  });

  test("a look asks about at most six, the newest first", async () => {
    const asked: string[] = [];
    const many = Array.from({ length: 9 }, (_, index) => candidate({ id: `comment:IC_${index}`, fp: `2026-09-24T10:0${index}:00Z` }));
    await judgeUndecided({
      candidates: many, judged: undefined, client: async (request) => { asked.push(request.text); return answer(); },
      pr: { number: 7, head: HEAD }, log: () => {}, signal: new AbortController().signal, now: () => new Date(),
    });
    expect(asked).toHaveLength(6);
  });

  test("a failing version backs off 1, 2, 4 … minutes on its own, and says when auto-merge should stop waiting", async () => {
    const checkpoint: Parameters<typeof judgeLook>[0]["checkpoint"] = {};
    let now = Date.parse("2026-09-24T10:00:00Z");
    const asked: string[] = [];
    const look = (candidates: JudgeCandidate[]) => judgeLook({
      candidates, checkpoint, pr: { number: 7, head: HEAD }, log: () => {}, signal: new AbortController().signal, now: () => new Date(now),
      client: async (request) => { asked.push(request.text); if (request.text === "bad") throw new Error("Jev answered HTTP 400"); return answer(); },
    });
    const bad = candidate({ id: "comment:IC_BAD", text: "bad" });
    expect((await look([bad])).gaveUp).toEqual([]);
    expect(checkpoint.judgeMisses).toEqual({ "comment:IC_BAD": { fp: bad.fp, count: 1, retryAt: "2026-09-24T10:01:00.000Z" } });
    // inside its backoff it is not asked; a new comment is, at once
    now += 30_000;
    asked.length = 0;
    await look([bad, candidate({ id: "comment:IC_NEW", text: "new", fp: "2026-09-24T10:00:30Z" })]);
    expect(asked).toEqual(["new"]);
    now += 60_000;
    await look([bad]);
    now += 2 * 60_000;
    expect((await look([bad])).gaveUp).toEqual(["comment:IC_BAD"]);
    now += 4 * 60_000;
    // a failure after the limit is not "giving up" again
    expect((await look([bad])).gaveUp).toEqual([]);
  });

  describe("what the answers say about merging this head", () => {
    const since = Date.parse("2026-09-24T09:00:00Z");
    const times = { sinceMs: since, firstSeenMs: since, nowMs: since + 60_000 };
    const pr = (over: Partial<PrSnapshot> = {}) => ({ head: HEAD, reviews: [], comments: [], checks: [], ...over }) as unknown as PrSnapshot;
    const look = (entries: [JudgeCandidate, Judged["kind"]][], unanswered: JudgeCandidate[] = []) => ({
      candidates: [...entries.map(([c]) => c), ...unanswered],
      judged: Object.fromEntries(entries.map(([c, kind]) => [c.id, { fp: c.fp, kind, confidence: 0.9, model: JEV_MODEL }])),
      misses: {},
    });

    test("a finding about this head needs you, unless the bot approved this head since", () => {
      expect(judgedHead(look([[candidate(), "needs_changes"]]), pr(), times)).toEqual({ problems: [{ author: "reviewer", url: "https://gh/c/1" }], awaited: [], pending: false });
      const approval = { author: "reviewer", commit: HEAD, submittedAt: "2026-09-24T10:30:00Z", state: "APPROVED", body: "" };
      expect(judgedHead(look([[candidate(), "needs_changes"]]), pr({ reviews: [approval] as never }), times).problems).toEqual([]);
    });

    test("a finding about an earlier head waits for the bot to speak on this one, in any form, for at most 20 minutes", () => {
      const later = { ...times, sinceMs: Date.parse("2026-09-24T10:10:00Z"), firstSeenMs: Date.parse("2026-09-24T10:10:00Z"), nowMs: Date.parse("2026-09-24T10:11:00Z") };
      const stale = look([[candidate(), "needs_changes"]]);
      expect(judgedHead(stale, pr(), later)).toEqual({ problems: [], awaited: ["reviewer"], pending: false });
      // a review of this head in any state, a new comment, or its own check finishing is its pass
      expect(judgedHead(stale, pr({ reviews: [{ author: "reviewer", commit: HEAD, state: "COMMENTED", body: "", submittedAt: "2026-09-24T10:12:00Z" }] as never }), later).awaited).toEqual([]);
      // a comment since counts only when the judge read it as a verdict: "review in progress…" is not a pass
      const progress = candidate({ id: "comment:IC_5", fp: "2026-09-24T10:12:00Z" });
      const withComment = (kind: Judged["kind"]) => {
        const base = look([[candidate({ postedAs: "review", id: "review:PRR_0", commit: "b".repeat(40) }), "needs_changes"], [progress, kind]]);
        return judgedHead(base, pr(), later).awaited;
      };
      expect(withComment("status")).toEqual(["reviewer"]);
      expect(withComment("all_clear")).toEqual([]);
      // a bot that keeps a summary comment has passed when the summary changes, not when its check
      // finishes: it may finish a moment before the rewrite lands
      const done = { checks: [{ name: "review", app: "reviewer", status: "COMPLETED", conclusion: "SUCCESS" }] as never };
      expect(judgedHead(stale, pr(done), later).awaited).toEqual(["reviewer"]);
      // a bot that only reviews has no summary to wait for: its check finishing is its pass
      const reviewsOnly = look([[candidate({ id: "review:PRR_0", postedAs: "review", commit: "b".repeat(40) }), "needs_changes"]]);
      expect(judgedHead(reviewsOnly, pr(done), later).awaited).toEqual([]);
      expect(judgedHead(reviewsOnly, pr({ checks: [{ name: "review", app: "reviewer", status: "IN_PROGRESS", conclusion: null }] as never }), later).awaited).toEqual(["reviewer"]);
      // a bot that never speaks again is not waited on forever
      expect(judgedHead(stale, pr(), { ...later, nowMs: later.firstSeenMs + PASS_WAIT_MS }).awaited).toEqual([]);
    });

    test("each channel speaks through its latest verdict; a status board or an old review edited late says nothing", () => {
      const summary = candidate({ id: "comment:IC_2", fp: "2026-09-24T11:00:00Z" });
      const review = candidate({ id: "review:PRR_1", fp: "2026-09-24T12:00:00Z", order: "2026-09-24T10:30:00Z", postedAs: "review", commit: HEAD });
      // an all-clear summary does not hide the same bot's finding in a review
      expect(judgedHead(look([[review, "needs_changes"], [summary, "all_clear"]]), pr(), times).problems).toHaveLength(1);
      // within a channel the newest verdict wins, by submission for reviews, and a status board is not a verdict
      const newerReview = candidate({ id: "review:PRR_2", fp: "2026-09-24T11:00:00Z", postedAs: "review", commit: HEAD });
      const board = candidate({ id: "comment:IC_3", fp: "2026-09-24T13:00:00Z" });
      expect(judgedHead(look([[review, "needs_changes"], [newerReview, "all_clear"], [board, "status"]]), pr(), times)).toEqual({ problems: [], awaited: [], pending: false });
      // a review names its commit: an earlier head's finding is awaited, whatever its time
      const oldReview = candidate({ id: "review:PRR_3", postedAs: "review", commit: "b".repeat(40) });
      expect(judgedHead(look([[oldReview, "needs_changes"]]), pr(), times).awaited).toEqual(["reviewer"]);
    });

    test("an approval's findings never hold the merge or make the judge pending", () => {
      const approval = candidate({ id: "review:PRR_A", postedAs: "review", commit: HEAD, question: "findings", fp: "2026-09-24T12:00:00Z" });
      expect(judgedHead({ candidates: [approval], judged: { "review:PRR_A": { fp: approval.fp, kind: "several_findings", confidence: 1, model: JEV_MODEL } }, misses: {} }, pr(), times))
        .toEqual({ problems: [], awaited: [], pending: false });
      expect(judgedHead({ candidates: [approval], judged: {}, misses: {} }, pr(), times).pending).toBe(false);
    });

    test("pending only while a channel's newest words have no answer and have not failed too often", () => {
      const fresh = candidate({ id: "comment:IC_4", fp: "2026-09-24T12:00:00Z" });
      expect(judgedHead(look([[candidate(), "all_clear"]], [fresh]), pr(), times).pending).toBe(true);
      const failed = { ...look([[candidate(), "all_clear"]], [fresh]), misses: { "comment:IC_4": { fp: fresh.fp, count: 3, retryAt: "2026-09-24T12:30:00Z" } } };
      expect(judgedHead(failed, pr(), times).pending).toBe(false);
      // an older unanswered word under a newer answered one is not worth a wait
      expect(judgedHead(look([[fresh, "all_clear"]], [candidate()]), pr(), times).pending).toBe(false);
    });
  });
});

describe("the call log", () => {
  const entry = (over: Partial<JudgeLogEntry> = {}): JudgeLogEntry => ({
    at: "2026-09-24T10:00:00.000Z", pr: 7, head: HEAD, item: "comment:IC_1", fp: "t", author: "reviewer", postedAs: "comment",
    prompt: "review-kind/2", ms: 812, text: "the retry never stops", inputTokens: 1_000, costUsd: 0.000042,
    answer: { kind: "needs_changes", confidence: 0.97, probabilities: {}, model: JEV_MODEL }, ...over,
  });

  test("every call lands beside the round evidence, private to the user, and is counted for the month", () => {
    const before = judgeUsage(new Date("2026-09-24T12:00:00Z"));
    writeJudgeLog("tjudge", "wrow", entry());
    writeJudgeLog("tjudge", "wrow", entry({ answer: undefined, inputTokens: undefined, costUsd: undefined, error: "Jev answered HTTP 529" }));
    const file = judgeLogPath("tjudge", "wrow");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const lines = readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(lines).toMatchObject([{ text: "the retry never stops", answer: { kind: "needs_changes" } }, { error: "Jev answered HTTP 529" }]);
    // never the key: the log is built from the entry alone
    expect(readFileSync(file, "utf8")).not.toContain("Bearer");
    const after = judgeUsage(new Date("2026-09-24T12:00:00Z"));
    expect(after).toMatchObject({ month: "2026-09", calls: before.calls + 2, errors: before.errors + 1, inputTokens: before.inputTokens + 1_000 });
    expect(after.costUsd).toBeCloseTo(after.inputTokens * 0.042 / 1_000_000, 12);
  });

  test("a full log rolls over once, so it never grows without bound", () => {
    const file = judgeLogPath("tjudge", "wroll");
    writeJudgeLog("tjudge", "wroll", entry());
    writeFileSync(file, "x".repeat(2 * 1024 * 1024 + 1));
    writeJudgeLog("tjudge", "wroll", entry());
    expect(existsSync(file.replace(/\.jsonl$/, ".1.jsonl"))).toBe(true);
    expect(statSync(file).size).toBeLessThan(10_000);
  });
});

// Runs only with a real key in the environment of this one test file; the
// shared setup clears it for every other test.
const LIVE_KEY = process.env.WISP_TEST_JEV_API_KEY;
describe.skipIf(!LIVE_KEY)("live Jev", () => {
  test("a medium finding reads as needs_changes; a preview link as status", async () => {
    const client = jevClient(LIVE_KEY!);
    const signal = AbortSignal.timeout(30_000);
    expect((await client({ text: "**🟡 Medium** — the retry loop never stops, so a dead endpoint hangs the worker.", bot: true, postedAs: "comment" }, signal)).kind).toBe("needs_changes");
    expect((await client({ text: "**Preview:** https://pr12.example.dev — deployed from 3f2c1a9.", bot: true, postedAs: "comment" }, signal)).kind).toBe("status");
    const approval = "Verdict: APPROVE — no blocking findings.\n\n1. **Non-blocking** — the download is not cancelled with the request.\n2. **Non-blocking** — a dropped queued request is still decoded.";
    expect((await client({ text: approval, bot: false, postedAs: "review", question: "findings" }, signal)).kind).toBe("several_findings");
    expect((await client({ text: "Verdict: APPROVE — no blocking findings. Findings: none.", bot: false, postedAs: "review", question: "findings" }, signal)).kind).toBe("no_findings");
  });
});
