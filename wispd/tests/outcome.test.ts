import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BUILTIN_ADAPTERS,
  createIncrementalOutcomeReducer,
  foldIncrementalOutcome,
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
});
