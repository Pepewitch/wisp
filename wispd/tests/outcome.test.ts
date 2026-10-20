import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BUILTIN_ADAPTERS,
  createIncrementalOutcomeReducer,
  foldIncrementalOutcome,
  formatUsage,
  parseOutput,
} from "../src/adapters";

const fixture = (name: string): string => readFileSync(join(import.meta.dir, "fixtures", name), "utf8");

describe("incremental outcome reducers", () => {
  test("legacy whole-log parsing and line-at-a-time reduction share the same facts", () => {
    for (const [name, fixtureName] of [
      ["claude", "claude-init.jsonl"],
      ["droid", "droid-init.jsonl"],
      ["codex", "codex-first-turn.jsonl"],
      ["cursor", "cursor-accumulated-result.jsonl"],
    ] as const) {
      const def = BUILTIN_ADAPTERS[name]!;
      const raw = fixture(fixtureName);
      const reducer = createIncrementalOutcomeReducer(def)!;
      for (const line of raw.split("\n")) reducer.pushStdoutLine(line);
      expect(reducer.outcome("legacy"), name).toEqual(parseOutput(def, raw));
    }
  });

  test("recorder-v1 codex requires terminal positive settlement", () => {
    const def = BUILTIN_ADAPTERS.codex!;
    const interrupted = [
      `{"type":"thread.started","thread_id":"thread-1"}`,
      `{"type":"turn.started"}`,
      `{"type":"item.completed","item":{"type":"agent_message","text":"not yet settled"}}`,
    ].join("\n");

    expect(foldIncrementalOutcome(def, interrupted, "", "legacy")!.outcome).toMatchObject({
      result: "not yet settled",
      isError: false,
    });
    expect(foldIncrementalOutcome(def, interrupted, "", "recorder-v1")!.outcome).toMatchObject({
      result: null,
      isError: true,
    });

    const completed = `${interrupted}\n{"type":"turn.completed","usage":{"input_tokens":5}}`;
    expect(foldIncrementalOutcome(def, completed, "", "recorder-v1")!.outcome).toMatchObject({
      result: "not yet settled",
      isError: false,
      usage: { input_tokens: 5 },
    });
  });

  test("a persisted checkpoint resumes without losing ordering or error precedence", () => {
    const def = BUILTIN_ADAPTERS.droid!;
    const reducer = createIncrementalOutcomeReducer(def)!;
    reducer.pushStdoutLine(`{"type":"system","subtype":"init","session_id":"session-1","model":"model-1"}`);
    reducer.pushStdoutLine(`{"type":"error","source":"cli","message":"secondary"}`);
    const resumed = createIncrementalOutcomeReducer(def, reducer.checkpoint())!;
    resumed.pushStdoutLine(`{"type":"error","source":"agent_loop","message":"primary"}`);
    resumed.pushStdoutLine(
      `{"type":"completion","session_id":"session-1","finalText":"failed","isError":true,"usage":{"input_tokens":9}}`,
    );
    resumed.pushStderrLine("stderr fallback");

    expect(resumed.outcome("recorder-v1")).toMatchObject({
      result: "failed",
      session: "session-1",
      model: "model-1",
      isError: true,
      usage: { input_tokens: 9 },
    });
    expect(resumed.errorDetail()).toBe("primary");
  });

  test("malformed and partial frames do not erase an earlier checkpoint", () => {
    const def = BUILTIN_ADAPTERS.claude!;
    const reducer = createIncrementalOutcomeReducer(def)!;
    reducer.pushStdoutLine(`{"type":"system","session_id":"session-2","model":"model-2","skills":["review"]}`);
    reducer.pushStdoutLine(`{"type":"result"`);

    expect(reducer.outcome()).toMatchObject({
      result: null,
      session: "session-2",
      model: "model-2",
      skills: ["review"],
    });
  });

  test("a turn's usage adds up every result event, even when the last one reports zero", () => {
    const def = BUILTIN_ADAPTERS.claude!;
    const { outcome, errorDetail } = foldIncrementalOutcome(def, fixture("claude-retried-result.jsonl"))!;

    expect(outcome.isError).toBe(true);
    expect(errorDetail).toBe("API Error: Unable to connect to API (ENOTFOUND)");
    expect(formatUsage(def, outcome.usage)).toEqual({
      inputTokens: 10,
      outputTokens: 2000,
      cachedInputTokens: 98000,
      cacheWriteTokens: 2500,
    });
    // The raw blob keeps its shape: nested counts add, strings stay, lists join.
    expect(outcome.usage).toMatchObject({
      server_tool_use: { web_search_requests: 0 },
      cache_creation: { ephemeral_1h_input_tokens: 2500 },
      service_tier: "standard",
      iterations: [],
    });
    // Context is still the last real call's prompt, not the sum and not the zero retry.
    expect(outcome.context).toEqual({ usedTokens: 4 + 50000 + 500 });
  });

  test("summed usage survives a checkpoint between result events", () => {
    const def = BUILTIN_ADAPTERS.claude!;
    const [first, second] = fixture("claude-retried-result.jsonl")
      .trim()
      .split("\n")
      .filter((line) => line.includes(`"type":"result"`));
    const tick = `{"type":"result","is_error":false,"result":"tick","usage":{"input_tokens":1,"output_tokens":5,"cache_read_input_tokens":null}}`;

    const reducer = createIncrementalOutcomeReducer(def)!;
    reducer.pushStdoutLine(first!);
    const resumed = createIncrementalOutcomeReducer(def, reducer.checkpoint())!;
    resumed.pushStdoutLine(second!);
    resumed.pushStdoutLine(tick);
    expect(formatUsage(def, resumed.outcome().usage)).toMatchObject({
      inputTokens: 11,
      outputTokens: 2005,
      cachedInputTokens: 98000,
    });

    // A checkpoint written before usage was summed kept it on the result event only.
    const legacy = { ...reducer.checkpoint(), usage: null, resultEvent: JSON.parse(first!) };
    const fromLegacy = createIncrementalOutcomeReducer(def, legacy)!;
    fromLegacy.pushStdoutLine(tick);
    expect(formatUsage(def, fromLegacy.outcome().usage)).toMatchObject({ inputTokens: 11, outputTokens: 2005 });
  });

  test("without a declared result type the last line's usage still stands alone", () => {
    const def = { bin: "custom", exec: [], parse: { format: "json" as const, result: "text", usage: "usage" } };
    const raw = [`{"text":"a","usage":{"input_tokens":7}}`, `{"text":"b","usage":{"input_tokens":3}}`].join("\n");
    expect(foldIncrementalOutcome(def, raw)!.outcome.usage).toEqual({ input_tokens: 3 });
  });
});
