// A Claude turn whose result lists denied tool calls: only a denial of its
// last tool call means it stopped for the person; one the agent went past
// leaves a finished turn done.
import { describe, expect, test } from "bun:test";
import { BUILTIN_ADAPTERS } from "../src/adapters";
import { parseOutput } from "../src/adapters/parse";

const claude = BUILTIN_ADAPTERS.claude!;

describe("claude permission denials", () => {
  const toolUse = (id: string) => `{"type":"assistant","message":{"content":[{"type":"text","text":"running"},{"type":"tool_use","id":"${id}","name":"Bash","input":{}}]}}`;
  const denied = (...ids: string[]) =>
    `{"type":"result","result":"answer","session_id":"s","permission_denials":[${ids.map((id) => `{"tool_name":"Bash","tool_use_id":"${id}","tool_input":{}}`).join(",")}]}`;

  test("claude: a denied tool call the agent went past does not hold the finished turn", () => {
    // what a long turn looks like: a safety check refused one command, the agent did it another way and finished
    const raw = [toolUse("toolu_a"), toolUse("toolu_denied"), toolUse("toolu_b"), `{"type":"assistant","message":{"content":[{"type":"text","text":"done"}]}}`, denied("toolu_denied")].join("\n");
    expect(parseOutput(claude, raw).needsInput).toBe(false);
  });

  test("claude: a denial of the turn's last tool call still waits for the person", () => {
    const raw = [toolUse("toolu_a"), toolUse("toolu_denied"), `{"type":"assistant","message":{"content":[{"type":"text","text":"May I run it?"}]}}`, denied("toolu_a", "toolu_denied")].join("\n");
    expect(parseOutput(claude, raw).needsInput).toBe(true);
  });

  test("claude: denials that name no tool call, or a stream with none, keep the plain rule", () => {
    expect(parseOutput(claude, [toolUse("toolu_a"), `{"type":"result","result":"x","permission_denials":[{"tool":"Bash"}]}`].join("\n")).needsInput).toBe(true);
    expect(parseOutput(claude, denied("toolu_gone")).needsInput).toBe(true);
  });
});
