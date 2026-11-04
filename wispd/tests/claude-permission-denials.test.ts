// A Claude turn whose result lists denied tool calls: a denial in the main
// agent's last batch of calls may be what it stopped to ask about, so it
// holds the turn for the person; one the agent went past leaves a finished
// turn done.
import { describe, expect, test } from "bun:test";
import { BUILTIN_ADAPTERS } from "../src/adapters";
import { createIncrementalOutcomeReducer, type OutcomeCheckpointV1 } from "../src/adapters/outcome";
import { parseOutput } from "../src/adapters/parse";

const claude = BUILTIN_ADAPTERS.claude!;

/** One assistant event: a model response's tool calls, as stream-json writes them. */
const calls = (message: string, ids: string[], parent: string | null = null) =>
  JSON.stringify({
    type: "assistant",
    parent_tool_use_id: parent,
    message: { id: message, content: ids.map((id) => ({ type: "tool_use", id, name: "Bash", input: {} })) },
  });
const text = (words: string) => JSON.stringify({ type: "assistant", message: { id: `m-${words}`, content: [{ type: "text", text: words }] } });
const result = (...denied: string[]) =>
  JSON.stringify({
    type: "result",
    result: "answer",
    session_id: "s",
    permission_denials: denied.map((id) => ({ tool_name: "Bash", tool_use_id: id, tool_input: {} })),
  });
const needsInput = (...lines: string[]) => parseOutput(claude, lines.join("\n")).needsInput;

describe("claude permission denials", () => {
  test("a denied call the agent went past, with more calls after it, leaves the finished turn done", () => {
    // turn 508's shape: one command refused by a safety check, then an hour of other work
    expect(needsInput(calls("m1", ["a"]), calls("m2", ["denied"]), calls("m3", ["b"]), text("done"), result("denied"))).toBe(false);
  });

  test("a denial of the last call, followed only by words, waits for the person", () => {
    expect(needsInput(calls("m1", ["a"]), calls("m2", ["denied"]), text("May I run it?"), result("a", "denied"))).toBe(true);
  });

  test("a denial anywhere in the last batch of parallel calls holds, whatever their order", () => {
    // stream-json writes each call of one response as its own event under the same message id
    expect(needsInput(calls("m1", ["a"]), calls("m2", ["denied"]), calls("m2", ["read"]), text("May I push?"), result("denied"))).toBe(true);
    expect(needsInput(calls("m1", ["a"]), calls("m2", ["read", "denied"]), text("May I push?"), result("denied"))).toBe(true);
  });

  test("a subagent still calling tools does not move the main agent past its denial", () => {
    expect(needsInput(calls("m1", ["task"]), calls("m2", ["denied"]), calls("sub1", ["sub-a"], "task"), text("May I?"), result("denied"))).toBe(true);
  });

  test("the last result decides, as for usage", () => {
    // a background notification cycle after the agent went past its denial
    expect(needsInput(calls("m1", ["denied"]), result("denied"), calls("m2", ["b"]), result("denied"))).toBe(false);
  });

  test("denials that name no call, or a stream with no call of the main agent, keep the plain rule", () => {
    expect(needsInput(calls("m1", ["a"]), JSON.stringify({ type: "result", result: "x", permission_denials: [{ tool: "Bash" }] }))).toBe(true);
    expect(needsInput(result("gone"))).toBe(true);
    expect(needsInput(calls("sub1", ["sub-a"], "task"), result("gone"))).toBe(true);
  });

  test("the batch survives a checkpoint, and an older checkpoint without it keeps the plain rule", () => {
    const first = createIncrementalOutcomeReducer(claude);
    for (const line of [calls("m1", ["denied"]), calls("m2", ["b"])]) first.pushStdoutLine(line);
    const resumed = createIncrementalOutcomeReducer(claude, first.checkpoint());
    resumed.pushStdoutLine(result("denied"));
    expect(resumed.outcome().needsInput).toBe(false);

    const { lastToolBatch: _batch, needsInputHeld: _held, ...older } = first.checkpoint();
    const fromOlder = createIncrementalOutcomeReducer(claude, older as OutcomeCheckpointV1);
    fromOlder.pushStdoutLine(result("denied"));
    expect(fromOlder.outcome().needsInput).toBe(true);
  });
});
