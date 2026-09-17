import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BUILTIN_ADAPTERS,
  CONTEXT_TRACKERS,
  foldIncrementalOutcome,
  readContextPoint,
  type AdapterDef,
} from "../src/adapters";

/**
 * CONTEXT_TRACKERS — the one number a header can show without asking the
 * harness for it. What is pinned here is the rule every tracker implements:
 * the prompt of the LAST model call is the context, and a turn's usage blob
 * (which sums every call) is not that number.
 *
 * Events are written inline rather than captured: a tracker is a pure function
 * of one event, the shapes are three fields deep, and the token values are
 * chosen to make "summed instead of last" and "added instead of nested" fail
 * loudly. The two real captures that already carry the shape are folded too.
 */

const claude = BUILTIN_ADAPTERS.claude!;
const codex = BUILTIN_ADAPTERS.codex!;
const opencode = BUILTIN_ADAPTERS.opencode!;
const droid = BUILTIN_ADAPTERS.droid!;
const cursor = BUILTIN_ADAPTERS.cursor!;

const fixture = (name: string): string => readFileSync(join(import.meta.dir, "fixtures", name), "utf8");

/** One claude assistant event: the three prompt fields are DISJOINT on the wire. */
const claudeCall = (
  input: number,
  cacheRead: number,
  cacheCreate: number,
  parentToolUseId: string | null = null,
): Record<string, unknown> => ({
  type: "assistant",
  parent_tool_use_id: parentToolUseId,
  message: {
    role: "assistant",
    usage: {
      input_tokens: input,
      cache_read_input_tokens: cacheRead,
      cache_creation_input_tokens: cacheCreate,
      output_tokens: 700,
    },
  },
});

describe("claude-stream-json", () => {
  test("the prompt is the sum of the three disjoint fields", () => {
    expect(readContextPoint(claude, claudeCall(32, 467_277, 655))).toEqual({ usedTokens: 467_964 });
  });

  test("a SUBAGENT's call is not this session's context, however recent it is", () => {
    // A subagent carries its own conversation and its events ride the same
    // stream with usage attached, so last-wins would otherwise believe it.
    expect(readContextPoint(claude, claudeCall(2, 0, 0, "toolu_01child"))).toBeNull();
  });

  test("a compaction reports its own result, because that turn makes no model call", () => {
    const boundary = {
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: { trigger: "manual", pre_tokens: 468_951, post_tokens: 9472 },
    };
    expect(readContextPoint(claude, boundary)).toEqual({ usedTokens: 9472 });
  });

  test("an all-zero call is absence, not a session that shrank to nothing", () => {
    expect(readContextPoint(claude, claudeCall(0, 0, 0))).toBeNull();
    expect(readContextPoint(claude, { type: "assistant", message: {} })).toBeNull();
    expect(readContextPoint(claude, { type: "system", subtype: "compact_boundary" })).toBeNull();
  });

  test("the reducer keeps the LAST call, and a compaction mid-turn wins over what preceded it", () => {
    const stdout = [
      JSON.stringify(claudeCall(32, 100_000, 500)),
      JSON.stringify(claudeCall(32, 200_000, 500)),
      JSON.stringify(claudeCall(9, 0, 0, "toolu_01child")), // a subagent, ignored
      JSON.stringify({ type: "result", subtype: "success", result: "done", session_id: "s-1" }),
    ].join("\n");
    expect(foldIncrementalOutcome(claude, stdout)!.outcome.context).toEqual({ usedTokens: 200_532 });

    const compacted = `${stdout}\n${JSON.stringify({
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: { post_tokens: 9472 },
    })}`;
    expect(foldIncrementalOutcome(claude, compacted)!.outcome.context).toEqual({ usedTokens: 9472 });
  });
});

describe("codex-jsonl", () => {
  test("input_tokens alone — codex nests the cached count INSIDE it", () => {
    // Adding the two would double-count the whole conversation.
    const event = {
      type: "turn.completed",
      usage: { total_tokens: 166_710, input_tokens: 166_151, cached_input_tokens: 165_248, output_tokens: 559 },
    };
    expect(readContextPoint(codex, event)).toEqual({ usedTokens: 166_151 });
  });

  test("the captured first turn folds to its final prompt", () => {
    expect(foldIncrementalOutcome(codex, fixture("codex-first-turn.jsonl"))!.outcome.context).toEqual({
      usedTokens: 13_186,
    });
  });
});

describe("opencode-json", () => {
  test("the last step is the last model call", () => {
    // The captured tool turn steps 8,556 → 9,128 → 9,518 (input), and its
    // final step reads nothing from cache.
    const folded = foldIncrementalOutcome(opencode, fixture("opencode-tool-turn.jsonl"))!;
    expect(folded.outcome.context).toEqual({ usedTokens: 9518 });
    // the SUM of those steps is what usage reports, and it is a bigger number
    expect(folded.outcome.usage).toBeTruthy();
  });

  test("a step with no tokens block says nothing", () => {
    expect(readContextPoint(opencode, { type: "step_finish", part: {} })).toBeNull();
    expect(readContextPoint(opencode, { type: "text", part: { text: "hi" } })).toBeNull();
  });
});

describe("the harnesses that cannot answer", () => {
  test("droid and cursor declare no tracker, so their SUMMED usage is never mistaken for context", () => {
    expect(droid.contextFormat).toBeUndefined();
    expect(cursor.contextFormat).toBeUndefined();
    // droid's real completion blob: 20m cache reads over one turn's 261 calls
    const completion = {
      type: "completion",
      usage: { input_tokens: 1_331_021, cache_read_input_tokens: 20_095_847, output_tokens: 158_037 },
    };
    expect(readContextPoint(droid, completion)).toBeNull();
  });

  test("every builtin tracker name keys into the table", () => {
    for (const [name, def] of Object.entries(BUILTIN_ADAPTERS)) {
      if (def.contextFormat) expect(CONTEXT_TRACKERS[def.contextFormat], name).toBeFunction();
    }
  });

  test("an unknown tracker throws rather than blanking the number", () => {
    const bogus = { ...claude, contextFormat: "no-such-tracker" } as AdapterDef;
    expect(() => readContextPoint(bogus, claudeCall(1, 2, 3))).toThrow(/not a known tracker/);
  });
});
