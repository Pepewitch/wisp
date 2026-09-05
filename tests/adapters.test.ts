import { describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import {
  BUILTIN_ADAPTERS,
  buildArgv,
  buildAttachArgv,
  errorDetail,
  ERROR_STRATEGIES,
  EVENT_FORMATTERS,
  formatUsage,
  isLimitError,
  isTransientError,
  loadAdapters,
  PARSE_STRATEGIES,
  parseOutput,
  USAGE_FORMATTERS,
  validateAdapters,
  type AdapterDef,
} from "../src/adapters";
import { ADAPTERS_PATH } from "../src/config";
import { fixture } from "./fixtures";

/** Exact-message assertions for the fail-at-boot errors (a prior audit). */
function thrownMessage(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  throw new Error("expected function to throw, but it returned");
}

const droid = BUILTIN_ADAPTERS.droid!;
const claude = BUILTIN_ADAPTERS.claude!;
const codex = BUILTIN_ADAPTERS.codex!;

describe("buildArgv", () => {
  test("first turn: no resume/model flags", () => {
    expect(buildArgv(droid, { prompt: "do it" })).toEqual([
      "droid", "exec", "-o", "stream-json", "--skip-permissions-unsafe", "do it",
    ]);
  });

  test("resume and model flags are substituted", () => {
    const argv = buildArgv(droid, { prompt: "next", session: "s-123", model: "opus" });
    expect(argv).toEqual([
      "droid", "exec", "-o", "stream-json", "--skip-permissions-unsafe", "-s", "s-123", "-m", "opus", "next",
    ]);
  });

  // P5b: droid uses `-r`; codex uses its `-c model_reasoning_effort=…` config override.
  test("droid effort template is appended when an effort is set", () => {
    expect(buildArgv(droid, { prompt: "go", model: "kimi-k3", effort: "medium" })).toEqual([
      "droid", "exec", "-o", "stream-json", "--skip-permissions-unsafe", "-m", "kimi-k3", "-r", "medium", "go",
    ]);
  });

  test("effort is omitted when unset, and for adapters with no effort template", () => {
    expect(buildArgv(droid, { prompt: "go" })).not.toContain("-r");
    // cursor declares no effort template (its effort is a bracket override on
    // the model id) — but keep the synthetic form too: the no-template path
    // must stay honest even for a def that once had one
    const noEffort: AdapterDef = { ...claude, effort: undefined };
    const argv = buildArgv(noEffort, { prompt: "go", effort: "high" });
    expect(argv).not.toContain("--effort");
    expect(argv).not.toContain("high");
  });

  test("claude effort uses --effort (claude-code 2.1.246 gained the flag)", () => {
    expect(claude.effort).toEqual(["--effort", "{effort}"]);
    const argv = buildArgv(claude, { prompt: "go", effort: "xhigh" });
    expect(argv).toContain("--effort");
    expect(argv[argv.indexOf("--effort") + 1]).toBe("xhigh");
    expect(argv[argv.length - 1]).toBe("go");
  });

  // slice 9: cursor's argv is the print-mode + bypass + trust shape read off
  // cursor-agent 2026.08.11's --help; it has no effort template at all
  test("cursor: print-mode stream-json with force + trust, model via --model, resume via --resume", () => {
    const cursor = BUILTIN_ADAPTERS.cursor!;
    expect(buildArgv(cursor, { prompt: "do it" })).toEqual([
      "cursor-agent", "-p", "--output-format", "stream-json", "-f", "--trust", "do it",
    ]);
    expect(buildArgv(cursor, { prompt: "next", session: "chat-1", model: "cursor-grok-4.6-high" })).toEqual([
      "cursor-agent", "-p", "--output-format", "stream-json", "-f", "--trust",
      "--resume", "chat-1", "--model", "cursor-grok-4.6-high", "next",
    ]);
    // an effort set in config is recorded but never reaches the harness (P5b's warning names it)
    const argv = buildArgv(cursor, { prompt: "go", effort: "high" });
    expect(argv.join(" ")).not.toContain("high");
  });

  // The picker offers these instead of asking for a guess. Each list was read
  // off the CLI itself (see AdapterDef.effortLevels) and they genuinely
  // differ — droid alone has dynamic/off, claude alone lacks none/minimal.
  test("each adapter declares the effort levels its CLI actually accepts", () => {
    expect(droid.effortLevels).toEqual(["none", "dynamic", "off", "minimal", "low", "medium", "high", "xhigh", "max"]);
    expect(claude.effortLevels).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(codex.effortLevels).toEqual(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
    // every declared level must be one the adapter can actually forward
    for (const def of [droid, claude, codex]) expect(def.effort).toBeDefined();
  });

  // The ONE documented exception to "never hardcode a model id": claude-code
  // enumerates no models and validates no --model string, so there is nothing
  // to probe. It must stay claude-only.
  test("only claude carries a curated staticModels list", () => {
    expect(claude.staticModels).toEqual([
      "claude-fable-5-1",
      "claude-opus-5",
      "claude-sonnet-5",
      "claude-haiku-4-5-20251001",
    ]);
    expect(droid.staticModels).toBeUndefined();
    expect(codex.staticModels).toBeUndefined();
    // a harness that CAN be probed must never carry one
    expect(claude.modelDiscovery).toBeUndefined();
  });

  test("codex effort uses the model_reasoning_effort config key", () => {
    expect(codex.effort).toEqual(["-c", "model_reasoning_effort={effort}"]);
    expect(buildArgv(codex, { prompt: "go", effort: "xhigh" })).toEqual([
      "codex",
      "exec",
      "--json",
      "--dangerously-bypass-approvals-and-sandbox",
      "-c",
      "model_reasoning_effort=xhigh",
      "go",
    ]);
  });

  test("claude resume", () => {
    const argv = buildArgv(claude, { prompt: "go", session: "abc" });
    expect(argv).toContain("--resume");
    expect(argv).toContain("abc");
    expect(argv[argv.length - 1]).toBe("go");
  });

  test("attach argv substitutes session; droid has none yet", () => {
    expect(buildAttachArgv(claude, "xyz")).toEqual(["claude", "--resume", "xyz"]);
    expect(buildAttachArgv(codex, "xyz")).toEqual(["codex", "resume", "xyz"]);
    expect(buildAttachArgv(droid, "xyz")).toBeNull();
  });

  // S3 (spike ts7efd): the image slot sits immediately before the prompt
  // positional, after resume/model/effort; stdin-envelope harnesses omit the
  // positional entirely (the prompt rides the NDJSON line)
  describe("image attachments", () => {
    test("codex: the template inserts immediately before the prompt, -- mandatory", () => {
      expect(buildArgv(codex, { prompt: "look", images: ["/t/red.png"] })).toEqual([
        "codex", "exec", "--json", "--dangerously-bypass-approvals-and-sandbox",
        "-i", "/t/red.png", "--", "look",
      ]);
    });

    test("codex multi-file: one -i, all paths, then --", () => {
      expect(buildArgv(codex, { prompt: "look", images: ["/t/a.png", "/t/b.jpg"] })).toEqual([
        "codex", "exec", "--json", "--dangerously-bypass-approvals-and-sandbox",
        "-i", "/t/a.png", "/t/b.jpg", "--", "look",
      ]);
    });

    test("codex resume+model+images: the image slot stays immediately before the prompt", () => {
      expect(buildArgv(codex, { prompt: "again", session: "s-1", model: "gpt-5.6-luna", images: ["/t/a.png"] })).toEqual([
        "codex", "exec", "--json", "--dangerously-bypass-approvals-and-sandbox",
        "resume", "s-1", "-m", "gpt-5.6-luna", "-i", "/t/a.png", "--", "again",
      ]);
    });

    test("claude with images: the prompt leaves argv for the stdin envelope", () => {
      const argv = buildArgv(claude, { prompt: "look at this", images: ["/t/a.png"] });
      expect(argv).not.toContain("look at this");
      expect(argv.slice(-2)).toEqual(["--input-format", "stream-json"]);
    });

    test("claude resume with images keeps --resume/--model and drops the prompt", () => {
      expect(buildArgv(claude, { prompt: "again", session: "sess-1", model: "opus", images: ["/t/a.png"] })).toEqual([
        "claude", "-p", "--output-format", "stream-json", "--verbose", "--forward-subagent-text", "--dangerously-skip-permissions",
        "--resume", "sess-1", "--model", "opus", "--input-format", "stream-json",
      ]);
    });

    test("no images: nothing changes unless the runner explicitly enables a live channel", () => {
      expect(buildArgv(codex, { prompt: "plain" })).not.toContain("-i");
      const argv = buildArgv(claude, { prompt: "plain" });
      expect(argv[argv.length - 1]).toBe("plain");
      expect(argv).not.toContain("--input-format");
      expect(buildArgv(claude, { prompt: "plain", live: true }).slice(-2)).toEqual([
        "--input-format",
        "stream-json",
      ]);
    });

    test("images for a def with no image field insert nothing (the API rejects these earlier)", () => {
      expect(buildArgv(droid, { prompt: "plain", images: ["/t/a.png"] })).toEqual([
        "droid", "exec", "-o", "stream-json", "--skip-permissions-unsafe", "plain",
      ]);
    });

    test("a code-built def with an unknown imageInput strategy throws loudly", () => {
      const bad: AdapterDef = { bin: "x", exec: [], parse: { format: "text" }, imageInput: "nope" };
      expect(() => buildArgv(bad, { prompt: "go", images: ["/t/a.png"] })).toThrow(
        "adapter imageInput 'nope' is not a known strategy (known: claude-stream-json)",
      );
    });
  });

  // codex's resume is a subcommand, not a flag — these argvs are exactly the
  // ones run live against codex-cli 0.149.0 (tests/fixtures/README.md)
  describe("codex", () => {
    test("first turn", () => {
      expect(buildArgv(codex, { prompt: "Reply with exactly the word: papaya" })).toEqual([
        "codex", "exec", "--json", "--dangerously-bypass-approvals-and-sandbox",
        "Reply with exactly the word: papaya",
      ]);
    });

    test("resume: the subcommand lands after exec's flags, before the model flag", () => {
      expect(buildArgv(codex, { prompt: "next", session: "cf851ea9-c5ab-5f68-9ae8-badc06afd3ec" })).toEqual([
        "codex", "exec", "--json", "--dangerously-bypass-approvals-and-sandbox",
        "resume", "cf851ea9-c5ab-5f68-9ae8-badc06afd3ec", "next",
      ]);
    });

    test("resume with the policy model", () => {
      expect(buildArgv(codex, { prompt: "next", session: "s-1", model: "gpt-5.6-luna" })).toEqual([
        "codex", "exec", "--json", "--dangerously-bypass-approvals-and-sandbox",
        "resume", "s-1", "-m", "gpt-5.6-luna", "next",
      ]);
    });

    test("model without a session (first turn)", () => {
      expect(buildArgv(codex, { prompt: "go", model: "gpt-5.6-luna" })).toEqual([
        "codex", "exec", "--json", "--dangerously-bypass-approvals-and-sandbox", "-m", "gpt-5.6-luna", "go",
      ]);
    });
  });
});

describe("parseOutput (stream-json)", () => {
  test("claude: picks the result event, ignores trailing non-result lines", () => {
    const raw = [
      `{"type":"system","subtype":"init","session_id":"early"}`,
      `{"type":"assistant","message":{"content":[{"type":"text","text":"working"}]}}`,
      `{"type":"result","result":"all done","session_id":"s-final","permission_denials":[]}`,
      `{"type":"usage","tokens":5}`,
    ].join("\n");
    const p = parseOutput(claude, raw);
    expect(p.result).toBe("all done");
    expect(p.session).toBe("s-final");
    expect(p.needsInput).toBe(false);
  });

  test("claude: non-empty permission_denials means needs-input", () => {
    const raw = `{"type":"result","result":"waiting","session_id":"s","permission_denials":[{"tool":"Bash"}]}`;
    expect(parseOutput(claude, raw).needsInput).toBe(true);
  });

  test("droid: completion event with finalText", () => {
    const raw = [
      `{"type":"system","subtype":"init","session_id":"d-1"}`,
      `{"type":"tool_call","toolName":"Execute","parameters":{"command":"ls"}}`,
      `{"type":"completion","finalText":"ok","session_id":"d-1","numTurns":1}`,
    ].join("\n");
    const p = parseOutput(droid, raw);
    expect(p.result).toBe("ok");
    expect(p.session).toBe("d-1");
  });

  // slice 9: the cursor transcript shape, binary-verified against
  // cursor-agent 2026.08.11's bundle — init carries the model, the result
  // line carries session + usage (with cursor's shorter cache key). But its
  // TEXT is the whole turn's assistant prose fused with no separator (found
  // on 2026.08.31 output; fixture cursor-accumulated-result.jsonl), so the
  // conclusion is DERIVED from the assistant events, never field-mapped.
  test("cursor: conclusion is the LAST assistant text, not the result event's fused blob", () => {
    const cursor = BUILTIN_ADAPTERS.cursor!;
    const raw = [
      `{"type":"system","subtype":"init","apiKeySource":"login","cwd":"/tmp/wt","session_id":"chat-1","model":"Grok 4.6","permissionMode":"default"}`,
      `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"on it"}]},"session_id":"chat-1"}`,
      `{"type":"tool_call","subtype":"started","call_id":"t1","tool_call":{"shellToolCall":{"command":"ls"}},"session_id":"chat-1"}`,
      `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"done"}]},"session_id":"chat-1"}`,
      `{"type":"result","subtype":"success","is_error":false,"duration_ms":1200,"result":"on itdone","session_id":"chat-1","usage":{"input_tokens":100,"output_tokens":5,"cache_read_tokens":40,"cache_creation_input_tokens":10}}`,
    ].join("\n");
    const p = parseOutput(cursor, raw);
    expect(p.result).toBe("done"); // not "on itdone"
    expect(p.session).toBe("chat-1");
    expect(p.model).toBe("Grok 4.6");
    expect(p.needsInput).toBe(false);
    // snake-tokens gained the cache_read_tokens fallback for exactly this wire
    expect(formatUsage(cursor, p.usage)).toEqual({
      inputTokens: 100,
      outputTokens: 5,
      cachedInputTokens: 40,
      cacheWriteTokens: 10,
    });
  });

  test("cursor: a turn with no assistant text falls back to the raw result field", () => {
    const cursor = BUILTIN_ADAPTERS.cursor!;
    // not an observed shape — a successful turn always ends on prose — but if
    // a future build stops re-streaming the final message, the field mapping's
    // old answer is a better fallback than none
    const raw = [
      `{"type":"system","subtype":"init","session_id":"chat-9","model":"Grok 4.6"}`,
      `{"type":"result","subtype":"success","is_error":false,"result":"spoken nowhere","session_id":"chat-9"}`,
    ].join("\n");
    const p = parseOutput(cursor, raw);
    expect(p.result).toBe("spoken nowhere");
    expect(p.session).toBe("chat-9");
  });

  test("cursor: an interrupted turn still salvages the session for resume", () => {
    const cursor = BUILTIN_ADAPTERS.cursor!;
    const raw = [
      `{"type":"system","subtype":"init","session_id":"chat-2","model":"Grok 4.6"}`,
      `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"working…"}]},"session_id":"chat-2"}`,
    ].join("\n");
    const p = parseOutput(cursor, raw);
    expect(p.result).toBeNull();
    expect(p.session).toBe("chat-2");
    expect(p.model).toBe("Grok 4.6");
  });

  // cursor 2026.08.25 drifted the usage blob to camelCase (captured live
  // from the image-delivery probe turn): the same facts under new keys must
  // normalize identically, not fall to null
  test("cursor: 08.25's camelCase usage blob normalizes the same", () => {
    const cursor = BUILTIN_ADAPTERS.cursor!;
    expect(
      formatUsage(cursor, { inputTokens: 6371, outputTokens: 216, cacheReadTokens: 512, cacheWriteTokens: 64 }),
    ).toEqual({ inputTokens: 6371, outputTokens: 216, cachedInputTokens: 512, cacheWriteTokens: 64 });
  });

  test("cursor: images deliver by path (read-tool-path, live-verified 2026-08-31)", () => {
    const cursor = BUILTIN_ADAPTERS.cursor!;
    expect(cursor.imageDelivery).toBe("read-tool-path");
    // and never the other two forms — mutual exclusion survives the def
    expect(cursor.image).toBeUndefined();
    expect(cursor.imageInput).toBeUndefined();
  });

  test("interrupted turn: no result event, session salvaged from early events", () => {
    const raw = [
      `{"type":"system","subtype":"init","session_id":"salvage-me"}`,
      `{"type":"assistant","message":{"content":[{"type":"text","text":"working…"}]}}`,
    ].join("\n");
    const p = parseOutput(claude, raw);
    expect(p.result).toBeNull();
    expect(p.session).toBe("salvage-me");
  });

  test("garbage output yields nulls, not throws", () => {
    const p = parseOutput(claude, "segfault\nnot json at all");
    expect(p.result).toBeNull();
    expect(p.session).toBeNull();
  });

  test("every builtin's named strategies and formatters resolve", () => {
    for (const [name, def] of Object.entries(BUILTIN_ADAPTERS)) {
      if (def.parse.strategy) expect(PARSE_STRATEGIES[def.parse.strategy], name).toBeFunction();
      if (def.events) expect(EVENT_FORMATTERS[def.events], name).toBeFunction();
      if (def.errors) expect(ERROR_STRATEGIES[def.errors], name).toBeFunction();
      if (def.usageFormat) expect(USAGE_FORMATTERS[def.usageFormat], name).toBeFunction();
    }
  });

  test("text format returns tail", () => {
    const textDef: AdapterDef = { bin: "x", exec: [], parse: { format: "text" } };
    expect(parseOutput(textDef, "hello\nworld\n")).toEqual({
      result: "hello\nworld",
      session: null,
      needsInput: false,
      isError: false,
      model: null,
      usage: null,
      skills: null,
    });
  });
});

// Sanitized `codex exec --json` output, not a hand-written approximation:
// this proves the strategy against the observed harness shape.
describe("parseOutput (codex, captured fixtures)", () => {
  test("first turn: session from thread.started, result from the agent_message", () => {
    const p = parseOutput(codex, fixture("codex-first-turn.jsonl"));
    expect(p.session).toBe("cf851ea9-c5ab-5f68-9ae8-badc06afd3ec");
    expect(p.result).toBe("papaya");
    expect(p.needsInput).toBe(false);
  });

  test("resume turn: the LAST agent_message wins, command/preamble items do not", () => {
    const p = parseOutput(codex, fixture("codex-resume-turn.jsonl"));
    // the turn also contains a chatty first message and a command_execution
    // item whose output is "hi\n" — neither is the turn's result
    expect(p.result).toBe("papaya");
    expect(p.session).toBe("cf851ea9-c5ab-5f68-9ae8-badc06afd3ec"); // same thread across turns
  });

  test("failed turn: no result (so the runner fails loudly), session still salvaged", () => {
    const p = parseOutput(codex, fixture("codex-failed-turn.jsonl"));
    expect(p.result).toBeNull();
    expect(p.session).toBe("010c5312-6e66-56b1-91aa-ff594327d3bd");
  });

  test("turn.failed after the agent spoke still yields no result", () => {
    const raw = [
      `{"type":"thread.started","thread_id":"t-1"}`,
      `{"type":"turn.started"}`,
      `{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"on it"}}`,
      `{"type":"turn.failed","error":{"message":"usage limit reached"}}`,
    ].join("\n");
    expect(parseOutput(codex, raw)).toEqual({
      result: null,
      session: "t-1",
      needsInput: false,
      isError: true,
      model: null,
      usage: null,
      skills: null,
    });
  });

  test("interrupted mid-turn: session salvaged, no result", () => {
    const raw = `{"type":"thread.started","thread_id":"t-2"}\n{"type":"turn.started"}\n{"type":"ite`;
    expect(parseOutput(codex, raw)).toEqual({
      result: null,
      session: "t-2",
      needsInput: false,
      isError: false,
      model: null,
      usage: null,
      skills: null,
    });
  });

  test("garbage yields nulls, not throws", () => {
    expect(parseOutput(codex, "zsh: killed\n")).toEqual({
      result: null,
      session: null,
      needsInput: false,
      isError: false,
      model: null,
      usage: null,
      skills: null,
    });
  });

  test("an unknown strategy on a hand-built def throws instead of parsing empty", () => {
    const def: AdapterDef = { bin: "x", exec: [], parse: { format: "json", strategy: "nope" } };
    expect(thrownMessage(() => parseOutput(def, "{}"))).toBe(
      `adapter parse.strategy 'nope' is not a known strategy (known: ${Object.keys(PARSE_STRATEGIES).join(", ")})`,
    );
  });
});

// Sanitized cursor-agent 2026.08.31 output (tests/fixtures/README.md): a turn that
// speaks, runs a command, speaks again — and whose result event carries ALL
// of it fused ("I'll run that echo command now.done"). The same contract the
// codex fixtures pin: parse is tested against captured reality.
describe("parseOutput (cursor, captured fixtures)", () => {
  const cursor = BUILTIN_ADAPTERS.cursor!;

  test("the conclusion is the last assistant message, not the fused result blob", () => {
    const p = parseOutput(cursor, fixture("cursor-accumulated-result.jsonl"));
    expect(p.result).toBe("done");
    expect(p.session).toBe("093d92b3-24d8-5488-a85e-5c731561410d");
    expect(p.model).toBe("Cursor Grok 4.6 High"); // the init event's displayName
    expect(p.needsInput).toBe(false);
    // the result event's usage blob, camelCased since 2026.08.25
    expect(formatUsage(cursor, p.usage)).toEqual({
      inputTokens: 23328,
      outputTokens: 126,
      cachedInputTokens: 10112,
      cacheWriteTokens: 0,
    });
  });
});

describe("usage capture (Theme B)", () => {
  test("claude: usage rides the result event", () => {
    const raw =
      `{"type":"assistant","session_id":"s-1","message":{"content":[{"text":"done"}]}}\n` +
      `{"type":"result","session_id":"s-1","result":"done","usage":{"input_tokens":41200,"output_tokens":2100}}\n`;
    const p = parseOutput(claude, raw);
    expect(p.result).toBe("done");
    expect(p.usage).toEqual({ input_tokens: 41_200, output_tokens: 2_100 });
  });

  test("droid: usage rides the completion event", () => {
    const raw =
      `{"type":"system","subtype":"init","session_id":"s-2","model":"claude-opus-5"}\n` +
      `{"type":"completion","session_id":"s-2","finalText":"done","usage":{"input_tokens":10,"factory_credits":0.3}}\n`;
    const p = parseOutput(droid, raw);
    expect(p.usage).toEqual({ input_tokens: 10, factory_credits: 0.3 });
  });

  test("an interrupted turn (no result line) has no usage", () => {
    const p = parseOutput(claude, `{"type":"assistant","session_id":"s-3","message":{"content":[{"text":"partial"}]}}\n`);
    expect(p.usage).toBeNull();
  });

  test("a scalar usage field is not a blob", () => {
    const raw = `{"type":"result","result":"done","usage":"lots"}\n`;
    expect(parseOutput(claude, raw).usage).toBeNull();
  });

  test("codex: turn.completed carries the usage blob (captured fixture)", () => {
    expect(parseOutput(codex, fixture("codex-first-turn.jsonl")).usage).toEqual({
      input_tokens: 13_186,
      cached_input_tokens: 9_984,
      cache_write_input_tokens: 0,
      output_tokens: 6,
      reasoning_output_tokens: 0,
    });
    // a failed turn's stream has no turn.completed → no usage, no crash
    expect(parseOutput(codex, fixture("codex-failed-turn.jsonl")).usage).toBeNull();
  });
});

describe("USAGE_FORMATTERS (Theme B)", () => {
  test("snake-tokens maps the harness's fields and drops money", () => {
    const out = USAGE_FORMATTERS["snake-tokens"]!({
      input_tokens: 41_200,
      output_tokens: 2_100,
      cache_read_input_tokens: 24_800_000,
      cache_creation_input_tokens: 900,
      total_cost_usd: 1.23,
      factory_credits: 4.2,
      ttft_ms: 800,
      service_tier: "standard",
    });
    expect(out).toEqual({
      inputTokens: 41_200,
      outputTokens: 2_100,
      cachedInputTokens: 24_800_000,
      cacheWriteTokens: 900,
      // money fields never cross into the summary (the summary numbers tokens)
    });
    expect(out).not.toHaveProperty("totalCostUsd");
  });

  test("codex-usage maps codex's names including reasoning", () => {
    expect(
      USAGE_FORMATTERS["codex-usage"]!({
        input_tokens: 20_295,
        cached_input_tokens: 83_712,
        output_tokens: 2_603,
        reasoning_output_tokens: 900,
        cache_write_input_tokens: 100,
      }),
    ).toEqual({
      inputTokens: 20_295,
      cachedInputTokens: 83_712,
      outputTokens: 2_603,
      reasoningTokens: 900,
      cacheWriteTokens: 100,
    });
  });

  test("garbage, non-numbers, and no numbers at all degrade to null or omission", () => {
    expect(formatUsage(BUILTIN_ADAPTERS.droid!, null)).toBeNull();
    expect(formatUsage(BUILTIN_ADAPTERS.droid!, "text")).toBeNull();
    expect(USAGE_FORMATTERS["snake-tokens"]!({ total_cost_usd: 0.01 })).toBeNull();
    expect(USAGE_FORMATTERS["codex-usage"]!({ input_tokens: "many", output_tokens: 5 })).toEqual({
      outputTokens: 5,
    });
  });

  test("a def with no usageFormat serves null; an unknown name throws", () => {
    const noFormat: AdapterDef = { bin: "x", exec: [], parse: { format: "text" } };
    expect(formatUsage(noFormat, { input_tokens: 1 })).toBeNull();
    const bad: AdapterDef = { ...noFormat, usageFormat: "nope" };
    expect(thrownMessage(() => formatUsage(bad, { input_tokens: 1 }))).toBe(
      "adapter usageFormat 'nope' is not a known formatter (known: snake-tokens, codex-usage)",
    );
  });
});

// P5e: a failed turn must name its actual cause, not just "turn exited 1".
// Each harness's failure shape was captured live with an unknown model (the
// cheap stand-in that exercises the same reporting path as a mid-turn limit);
// see tests/fixtures/README.md.
describe("errorDetail (captured fixtures)", () => {
  const CLAUDE_UNKNOWN_MODEL =
    "There's an issue with the selected model (bogus-model). It may not exist or you may not have access to it. Run --model to pick a different model.";
  const CODEX_UNKNOWN_MODEL = "The 'no-such-model-xyz' model is not supported when using Codex with a ChatGPT account.";

  test("claude: the cause comes off the is_error result event, not the terse stderr log line", () => {
    const err = `[claude-code:unrecognized_model] {"model":"bogus-model","query_source":"sdk"}\n`;
    expect(errorDetail(claude, fixture("claude-unknown-model.jsonl"), err)).toBe(CLAUDE_UNKNOWN_MODEL);
  });

  test("claude: an assistant event with an API error code is error-bearing too", () => {
    const raw = [
      `{"type":"assistant","message":{"content":[{"type":"text","text":"rate limited — wait and retry"}]},"error":"rate_limit"}`,
    ].join("\n");
    expect(errorDetail(claude, raw, "")).toBe("rate limited — wait and retry");
  });

  test("claude: rate_limit_event telemetry is NOT a failure detail", () => {
    const raw = `{"type":"rate_limit_event","rate_limit_info":{"status":"allowed_warning","rateLimitType":"seven_day"}}`;
    expect(errorDetail(claude, raw, "")).toBeNull();
  });

  test("codex: the cause is on STDOUT (turn.failed), and the double-encoded API body is unwrapped", () => {
    // stderr on this capture held only "Reading additional input from stdin..."
    expect(errorDetail(codex, fixture("codex-failed-turn.jsonl"), "Reading additional input from stdin...\n")).toBe(
      CODEX_UNKNOWN_MODEL,
    );
  });

  test("codex: a mid-turn error item is the detail only when nothing terminal follows", () => {
    const warningFirst = [
      `{"type":"item.completed","item":{"id":"item_0","type":"error","message":"Model metadata for \`x\` not found."}}`,
      `{"type":"turn.failed","error":{"message":"The 'x' model is not supported."}}`,
    ].join("\n");
    expect(errorDetail(codex, warningFirst, "")).toBe("The 'x' model is not supported.");
    const crashAfterWarning = `{"type":"item.completed","item":{"id":"item_0","type":"error","message":"Model metadata for \`x\` not found."}}\n{"type":"turn.started"}\n{"type":"ite`;
    expect(errorDetail(codex, crashAfterWarning, "")).toBe("Model metadata for `x` not found.");
  });

  test("droid: pre-flight failure — stdout empty, cause is the FIRST stderr line (the tail is help noise)", () => {
    expect(errorDetail(droid, "", fixture("droid-unknown-model.stderr.txt"))).toBe("Invalid model: bogus-model");
  });

  test("droid: mid-turn failure — the last stdout error event wins over stderr", () => {
    // {"type":"error","message":…} is the shape droid's own stream-json
    // consumer collects, and "Unrecoverable 402: …" its 402 text (droid
    // 0.202.0 binary strings — not captured live: that would burn quota)
    const out = `{"type":"system","subtype":"init","session_id":"d-1"}\n{"type":"error","message":"Unrecoverable 402: usage limit reached"}\n`;
    expect(errorDetail(droid, out, "some stderr noise\n")).toBe("Unrecoverable 402: usage limit reached");
  });

  test("droid: the captured provider error outranks a trailing cli echo", () => {
    expect(errorDetail(droid, fixture("droid-transient-provider-error.jsonl"), "")).toBe(
      "Floating point NaN (not-a-number) is detected in generation. It's likely a model issue leading to overflow. Please contact Fireworks if it's a Fireworks-hosted model or check your model weights if it's a custom model.",
    );
    expect(errorDetail(droid, fixture("droid-transient-provider-error.jsonl"), "")).not.toBe(
      "Now the core S0 library files:",
    );
  });

  test("droid: an agent_loop error outranks a later cli error", () => {
    const out = [
      `{"type":"error","source":"agent_loop","message":"provider failed"}`,
      `{"type":"error","source":"cli","message":"partial generated text"}`,
    ].join("\n");
    expect(errorDetail(droid, out, "")).toBe("provider failed");
  });

  test("droid: errors without a source keep last-wins behavior", () => {
    const out = [
      `{"type":"error","message":"first failure"}`,
      `{"type":"error","message":"last failure"}`,
    ].join("\n");
    expect(errorDetail(droid, out, "")).toBe("last failure");
  });

  test("an adapter with no error strategy falls back to the stderr tail", () => {
    const def: AdapterDef = { bin: "x", exec: [], parse: { format: "text" } };
    expect(errorDetail(def, "irrelevant stdout", "line 1\nline 2\nboom line 3\n")).toBe("line 1 | line 2 | boom line 3");
    expect(errorDetail(def, "", "")).toBeNull();
  });

  test("garbage output yields null (then the tail), not throws", () => {
    expect(errorDetail(claude, "segfault\nnot json", "")).toBeNull();
    expect(errorDetail(claude, "segfault\nnot json", "real stderr\n")).toBe("real stderr");
  });

  test("an unknown strategy on a hand-built def throws instead of silently saying nothing", () => {
    const def: AdapterDef = { bin: "x", exec: [], parse: { format: "json" }, errors: "nope" };
    expect(thrownMessage(() => errorDetail(def, "", ""))).toBe(
      "adapter errors strategy 'nope' is not a known strategy (known: claude-stream-json, codex-jsonl, droid-stream-json)",
    );
  });
});

// P5e: limit/quota exhaustion is classified per adapter (each harness words
// it differently) so the runner can prefix state_detail with "limit: ".
// Marker wording: each CLI's own strings (tests/fixtures/README.md) — real
// Limits were not induced; markers came from the installed CLIs' own strings.
describe("limit classification", () => {
  test("claude: a limit-shaped result detail matches; an unknown-model detail does not", () => {
    // claude-code 2.1.240 strings: "usage limit reached", "You've reached your … limit"
    const limitOut = `{"type":"result","is_error":true,"subtype":"success","result":"Claude usage limit reached. Your limit will reset at 4pm.","session_id":"s"}\n`;
    const detail = errorDetail(claude, limitOut, "")!;
    expect(detail).toContain("usage limit reached");
    expect(isLimitError(claude, detail)).toBe(true);
    expect(isLimitError(claude, errorDetail(claude, fixture("claude-unknown-model.jsonl"), "")!)).toBe(false);
  });

  test("codex: a rate_limit_reached API body matches; an unknown-model detail does not", () => {
    // codex-cli 0.149.0 error kinds include rate_limit_reached; message from its strings
    const body = JSON.stringify({
      type: "error",
      status: 429,
      error: { type: "rate_limit_reached", message: "You've reached your usage limit. Increase your spend cap to continue." },
    });
    const limitOut = `{"type":"turn.failed","error":{"message":${JSON.stringify(body)}}}\n`;
    const detail = errorDetail(codex, limitOut, "")!;
    expect(detail).toBe("You've reached your usage limit. Increase your spend cap to continue.");
    expect(isLimitError(codex, detail)).toBe(true);
    expect(isLimitError(codex, errorDetail(codex, fixture("codex-failed-turn.jsonl"), "")!)).toBe(false);
  });

  test("droid: a 402 usage-limit error event matches; an unknown-model detail does not", () => {
    const detail = errorDetail(droid, `{"type":"error","message":"Unrecoverable 402: usage limit reached"}\n`, "")!;
    expect(isLimitError(droid, detail)).toBe(true);
    expect(isLimitError(droid, errorDetail(droid, "", fixture("droid-unknown-model.stderr.txt"))!)).toBe(false);
  });

  test("markers match case-insensitively", () => {
    expect(isLimitError(droid, "UNRECOVERABLE 402: USAGE LIMIT REACHED")).toBe(true);
  });

  test("an adapter with no limitMarkers never classifies", () => {
    const def: AdapterDef = { bin: "x", exec: [], parse: { format: "text" } };
    expect(isLimitError(def, "usage limit reached")).toBe(false);
  });
});

describe("transient classification", () => {
  test("droid: the captured NaN provider fault matches; an unknown-model detail does not", () => {
    const detail = errorDetail(droid, fixture("droid-transient-provider-error.jsonl"), "")!;
    expect(detail).toContain("Floating point NaN");
    expect(isTransientError(droid, detail)).toBe(true);
    expect(isTransientError(droid, errorDetail(droid, "", fixture("droid-unknown-model.stderr.txt"))!)).toBe(false);
  });

  test("markers match case-insensitively", () => {
    expect(isTransientError(droid, "FLOATING POINT NAN was detected")).toBe(true);
  });

  test("an adapter with no transientMarkers never classifies", () => {
    const def: AdapterDef = { bin: "x", exec: [], parse: { format: "text" } };
    expect(isTransientError(def, "Floating point NaN was detected")).toBe(false);
  });
});

// P5b: the model each turn ACTUALLY ran on, parsed from the harness's own
// events. droid/claude lines are sanitized captured init events (tests/fixtures/);
// codex provably reports none (0.149.0 fixtures + upstream exec_events.rs).
describe("parseOutput model capture (P5b)", () => {
  test("claude: model comes from the init event (sanitized captured line)", () => {
    const raw =
      fixture("claude-init.jsonl") +
      `{"type":"result","result":"all done","session_id":"s-1","permission_denials":[]}\n`;
    const p = parseOutput(claude, raw);
    expect(p.model).toBe("claude-opus-5"); // the model in the captured init event
    expect(p.result).toBe("all done");
  });

  test("droid: model comes from the init event (sanitized captured line)", () => {
    const raw = fixture("droid-init.jsonl") + `{"type":"completion","finalText":"ok","session_id":"d-1"}\n`;
    const p = parseOutput(droid, raw);
    expect(p.model).toBe("kimi-k3"); // the model in the captured init event
    expect(p.result).toBe("ok");
  });

  test("the model is captured even when the turn dies before any result (interrupted)", () => {
    const raw = [
      `{"type":"system","subtype":"init","session_id":"s","model":"opus-5"}`,
      `{"type":"assistant","message":{"content":[]}}`,
    ].join("\n");
    const p = parseOutput(claude, raw);
    expect(p.result).toBeNull();
    expect(p.model).toBe("opus-5");
  });

  test("a harness that puts the model only on its result event is covered too", () => {
    const def: AdapterDef = { bin: "x", exec: [], parse: { format: "json", resultType: "result", result: "result", model: "model" } };
    expect(parseOutput(def, `{"type":"result","result":"r","model":"m-1"}`).model).toBe("m-1");
  });

  test("codex: thread.started carries no model today (0.149.0 fixtures) — parse yields null, surfaces fall back to (requested)", () => {
    expect(parseOutput(codex, fixture("codex-first-turn.jsonl")).model).toBeNull();
    expect(parseOutput(codex, fixture("codex-resume-turn.jsonl")).model).toBeNull();
    expect(parseOutput(codex, fixture("codex-failed-turn.jsonl")).model).toBeNull();
  });

  test("codex: if a future thread.started adds a model field, it is captured without a wisp change", () => {
    const raw = [
      `{"type":"thread.started","thread_id":"t-9","model":"gpt-6"}`,
      `{"type":"turn.started"}`,
      `{"type":"item.completed","item":{"id":"i","type":"agent_message","text":"hi"}}`,
    ].join("\n");
    const p = parseOutput(codex, raw);
    expect(p.model).toBe("gpt-6");
    expect(p.result).toBe("hi");
  });

  test("adapters without parse.model report null rather than guessing", () => {
    const def: AdapterDef = { bin: "x", exec: [], parse: { format: "json", result: "result" } };
    expect(parseOutput(def, `{"result":"r","model":"m-1"}`).model).toBeNull();
  });
});

describe("validateAdapters (a prior audit)", () => {
  const validNew = {
    bin: "fake",
    exec: ["run"],
    parse: { format: "json", result: "result", session: "session_id" },
  };

  test("a valid new adapter loads alongside the builtins", () => {
    const out = validateAdapters({ fake: validNew });
    expect(out.fake).toEqual(validNew);
    expect(out.droid).toBe(BUILTIN_ADAPTERS.droid);
    expect(out.claude).toBe(BUILTIN_ADAPTERS.claude);
    expect(out.codex).toBe(BUILTIN_ADAPTERS.codex);
  });

  test("top level must be an object mapping names to defs", () => {
    expect(thrownMessage(() => validateAdapters([]))).toBe(
      "adapters.json: top level must be an object mapping adapter names to definitions, got array",
    );
    expect(thrownMessage(() => validateAdapters(null))).toBe(
      "adapters.json: top level must be an object mapping adapter names to definitions, got null",
    );
    expect(thrownMessage(() => validateAdapters("droid"))).toBe(
      "adapters.json: top level must be an object mapping adapter names to definitions, got string",
    );
  });

  test("an adapter def must be an object", () => {
    expect(thrownMessage(() => validateAdapters({ foo: "bar" }))).toBe(
      "adapters.json: adapter 'foo' must be an object, got string",
    );
  });

  test("a new adapter name requires bin, exec, and parse", () => {
    expect(thrownMessage(() => validateAdapters({ foo: { exec: [], parse: { format: "text" } } }))).toBe(
      "adapters.json: adapter 'foo' is missing required field 'bin' (must be a non-empty string)",
    );
    expect(thrownMessage(() => validateAdapters({ foo: { bin: "x", parse: { format: "text" } } }))).toBe(
      "adapters.json: adapter 'foo' is missing required field 'exec' (must be an array of strings)",
    );
    expect(thrownMessage(() => validateAdapters({ foo: { bin: "x", exec: [] } }))).toBe(
      'adapters.json: adapter \'foo\' is missing required field \'parse\' (must be an object with format "json" or "text")',
    );
  });

  test("field types are checked, naming adapter and field", () => {
    const base = { bin: "x", exec: [], parse: { format: "text" } };
    expect(thrownMessage(() => validateAdapters({ foo: { ...base, bin: 7 } }))).toBe(
      "adapters.json: adapter 'foo'.bin must be a non-empty string, got number",
    );
    expect(thrownMessage(() => validateAdapters({ foo: { ...base, bin: "" } }))).toBe(
      'adapters.json: adapter \'foo\'.bin must be a non-empty string, got ""',
    );
    expect(thrownMessage(() => validateAdapters({ foo: { ...base, exec: "run" } }))).toBe(
      "adapters.json: adapter 'foo'.exec must be an array of strings, got string",
    );
    expect(thrownMessage(() => validateAdapters({ foo: { ...base, exec: ["ok", 3] } }))).toBe(
      "adapters.json: adapter 'foo'.exec[1] must be a string, got number",
    );
    expect(thrownMessage(() => validateAdapters({ foo: { ...base, resume: "-s" } }))).toBe(
      "adapters.json: adapter 'foo'.resume must be an array of strings, got string",
    );
    expect(thrownMessage(() => validateAdapters({ foo: { ...base, model: { m: 1 } } }))).toBe(
      "adapters.json: adapter 'foo'.model must be an array of strings, got object",
    );
    expect(thrownMessage(() => validateAdapters({ foo: { ...base, effort: "high" } }))).toBe(
      "adapters.json: adapter 'foo'.effort must be an array of strings, got string",
    );
    expect(thrownMessage(() => validateAdapters({ foo: { ...base, allowEmptyResult: "yes" } }))).toBe(
      "adapters.json: adapter 'foo'.allowEmptyResult must be a boolean, got string",
    );
    expect(thrownMessage(() => validateAdapters({ foo: { ...base, attach: 42 } }))).toBe(
      "adapters.json: adapter 'foo'.attach must be an array of strings or null, got number",
    );
  });

  test("auth diagnostics are declarative, validated, and clearable", () => {
    const base = { bin: "x", exec: [], parse: { format: "text" } };
    const auth = { check: ["doctor", "--auth", "--json"], fix: "run x login", success: "json-ok" as const };
    expect(validateAdapters({ foo: { ...base, auth } }).foo!.auth).toEqual(auth);
    expect(validateAdapters({ droid: { auth: null } }).droid!.auth).toBeNull();
    expect(thrownMessage(() => validateAdapters({ foo: { ...base, auth: "status" } }))).toBe(
      "adapters.json: adapter 'foo'.auth must be an object or null, got string",
    );
    expect(thrownMessage(() => validateAdapters({ foo: { ...base, auth: { ...auth, check: [] } } }))).toBe(
      "adapters.json: adapter 'foo'.auth.check must contain at least one argument",
    );
    expect(thrownMessage(() => validateAdapters({ foo: { ...base, auth: { ...auth, fix: "" } } }))).toBe(
      "adapters.json: adapter 'foo'.auth.fix must be a non-empty string, got string",
    );
    expect(
      thrownMessage(() => validateAdapters({ foo: { ...base, auth: { ...auth, success: "guess" } } })),
    ).toBe('adapters.json: adapter \'foo\'.auth.success must be "exit-zero" or "json-ok", got "guess"');
  });

  test("events must name a builtin formatter", () => {
    const base = { bin: "x", exec: [], parse: { format: "json" } };
    expect(thrownMessage(() => validateAdapters({ foo: { ...base, events: "nope" } }))).toBe(
      'adapters.json: adapter \'foo\'.events must name a builtin event formatter (known: claude-stream-json, droid-stream-json, cursor-stream-json, codex-jsonl), got "nope"',
    );
    expect(thrownMessage(() => validateAdapters({ foo: { ...base, events: 7 } }))).toBe(
      "adapters.json: adapter 'foo'.events must name a builtin event formatter (known: claude-stream-json, droid-stream-json, cursor-stream-json, codex-jsonl), got number",
    );
    // a new harness can reuse an existing wire format by name — adapters.json only
    expect(validateAdapters({ foo: { ...base, events: "claude-stream-json" } }).foo!.events).toBe(
      "claude-stream-json",
    );
  });

  test("activity must name a builtin structured normalizer", () => {
    const base = { bin: "x", exec: [], parse: { format: "json" } };
    expect(thrownMessage(() => validateAdapters({ foo: { ...base, activity: "nope" } }))).toBe(
      'adapters.json: adapter \'foo\'.activity must name a builtin activity normalizer (known: claude-stream-json, droid-stream-json, cursor-stream-json, codex-jsonl) or null, got "nope"',
    );
    expect(thrownMessage(() => validateAdapters({ foo: { ...base, activity: 7 } }))).toBe(
      "adapters.json: adapter 'foo'.activity must name a builtin activity normalizer (known: claude-stream-json, droid-stream-json, cursor-stream-json, codex-jsonl) or null, got number",
    );
    expect(validateAdapters({ foo: { ...base, activity: "claude-stream-json" } }).foo!.activity).toBe(
      "claude-stream-json",
    );
    expect(validateAdapters({ droid: { activity: null } }).droid!.activity).toBeNull();
  });

  // slice 9: the default must be one of the offered models, or the picker
  // would claim a default it cannot select
  test("defaultModel must be a non-empty string from staticModels", () => {
    const base = { bin: "x", exec: [], parse: { format: "text" } as const };
    expect(thrownMessage(() => validateAdapters({ foo: { ...base, defaultModel: "" } }))).toBe(
      "adapters.json: adapter 'foo'.defaultModel must be a non-empty string, got string",
    );
    expect(
      thrownMessage(() => validateAdapters({ foo: { ...base, staticModels: ["a"], defaultModel: "b" } })),
    ).toBe(
      "adapters.json: adapter 'foo'.defaultModel 'b' is not in staticModels — the default must be one of the offered models",
    );
    expect(
      validateAdapters({ foo: { ...base, staticModels: ["a", "b"], defaultModel: "b" } }).foo!.defaultModel,
    ).toBe("b");
  });

  test("parse.strategy must name a builtin strategy", () => {
    const base = { bin: "x", exec: [] };
    expect(thrownMessage(() => validateAdapters({ foo: { ...base, parse: { format: "json", strategy: "nope" } } }))).toBe(
      `adapters.json: adapter 'foo'.parse.strategy must name a builtin parse strategy (known: ${Object.keys(PARSE_STRATEGIES).join(", ")}), got "nope"`,
    );
    expect(thrownMessage(() => validateAdapters({ foo: { ...base, parse: { format: "json", strategy: 7 } } }))).toBe(
      `adapters.json: adapter 'foo'.parse.strategy must name a builtin parse strategy (known: ${Object.keys(PARSE_STRATEGIES).join(", ")}), got number`,
    );
    // a new harness with codex's wire shape can reuse the strategy by name
    expect(
      validateAdapters({ foo: { ...base, parse: { format: "json", strategy: "codex-jsonl" } } }).foo!.parse,
    ).toEqual({ format: "json", strategy: "codex-jsonl" });
  });

  test("parse.strategy is loud about combinations it would silently ignore", () => {
    const base = { bin: "x", exec: [] };
    expect(
      thrownMessage(() => validateAdapters({ foo: { ...base, parse: { format: "text", strategy: "codex-jsonl" } } })),
    ).toBe('adapters.json: adapter \'foo\'.parse.strategy requires format "json", got "text"');
    expect(
      thrownMessage(() =>
        validateAdapters({
          foo: { ...base, parse: { format: "json", strategy: "codex-jsonl", result: "result", session: "id" } },
        }),
      ),
    ).toBe(
      'adapters.json: adapter \'foo\'.parse.strategy "codex-jsonl" parses the whole stream itself — remove result, session',
    );
  });

  test("usageFormat must name a builtin usage format (Theme B)", () => {
    const base = { bin: "x", exec: [], parse: { format: "text" } };
    expect(thrownMessage(() => validateAdapters({ foo: { ...base, usageFormat: "nope" } }))).toBe(
      'adapters.json: adapter \'foo\'.usageFormat must name a builtin usage formatter (known: snake-tokens, codex-usage), got "nope"',
    );
    expect(thrownMessage(() => validateAdapters({ foo: { ...base, usageFormat: 7 } }))).toBe(
      "adapters.json: adapter 'foo'.usageFormat must name a builtin usage formatter (known: snake-tokens, codex-usage), got number",
    );
    expect(validateAdapters({ foo: { ...base, usageFormat: "snake-tokens" } }).foo!.usageFormat).toBe("snake-tokens");
  });

  test("parse.usage joins the strategy conflict list (Theme B)", () => {
    const base = { bin: "x", exec: [] };
    expect(
      thrownMessage(() =>
        validateAdapters({ foo: { ...base, parse: { format: "json", strategy: "codex-jsonl", usage: "usage" } } }),
      ),
    ).toBe(
      'adapters.json: adapter \'foo\'.parse.strategy "codex-jsonl" parses the whole stream itself — remove usage',
    );
    expect(validateAdapters({ foo: { ...base, parse: { format: "json", usage: "usage" } } }).foo!.parse.usage).toBe(
      "usage",
    );
  });

  test("attach accepts null and string arrays", () => {
    const base = { bin: "x", exec: [], parse: { format: "text" } };
    expect(validateAdapters({ foo: { ...base, attach: null } }).foo!.attach).toBeNull();
    expect(validateAdapters({ foo: { ...base, attach: ["go", "{session}"] } }).foo!.attach).toEqual([
      "go",
      "{session}",
    ]);
  });

  test("the parse block is validated", () => {
    const base = { bin: "x", exec: [] };
    expect(thrownMessage(() => validateAdapters({ foo: { ...base, parse: null } }))).toBe(
      "adapters.json: adapter 'foo'.parse must be an object, got null",
    );
    expect(thrownMessage(() => validateAdapters({ foo: { ...base, parse: {} } }))).toBe(
      'adapters.json: adapter \'foo\'.parse.format is required ("json" or "text")',
    );
    expect(thrownMessage(() => validateAdapters({ foo: { ...base, parse: { format: "xml" } } }))).toBe(
      'adapters.json: adapter \'foo\'.parse.format must be "json" or "text", got "xml"',
    );
    expect(thrownMessage(() => validateAdapters({ foo: { ...base, parse: { format: 5 } } }))).toBe(
      'adapters.json: adapter \'foo\'.parse.format must be "json" or "text", got number',
    );
    expect(thrownMessage(() => validateAdapters({ foo: { ...base, parse: { format: "json", result: 9 } } }))).toBe(
      "adapters.json: adapter 'foo'.parse.result must be a string, got number",
    );
  });

  test("unknown keys warn and are dropped", () => {
    const warnings: string[] = [];
    const out = validateAdapters({ foo: { ...validNew, binn: "typo" } }, (m) => warnings.push(m));
    expect(warnings).toEqual([
      "adapters.json: adapter 'foo': unknown key 'binn' — ignoring (known: bin, auth, exec, resume, model, effort, effortLevels, staticModels, defaultModel, image, imageInput, imageDelivery, liveInput, allowEmptyResult, parse, events, activity, errors, limitMarkers, transientMarkers, attach, modelDiscovery, usageFormat, probe, skillDiscovery, compact, compactPrompt)",
    ]);
    expect("binn" in out.foo!).toBe(false);
  });

  test("image must be an array of strings containing a {path} placeholder (S3)", () => {
    const base = { bin: "x", exec: [], parse: { format: "text" } };
    expect(thrownMessage(() => validateAdapters({ foo: { ...base, image: "-i" } }))).toBe(
      "adapters.json: adapter 'foo'.image must be an array of strings or null, got string",
    );
    expect(thrownMessage(() => validateAdapters({ foo: { ...base, image: ["-i", "--"] } }))).toBe(
      'adapters.json: adapter \'foo\'.image must contain a {path} placeholder (e.g. ["-i", "{path}", "--"])',
    );
    expect(validateAdapters({ foo: { ...base, image: ["-i", "{path}", "--"] } }).foo!.image).toEqual([
      "-i",
      "{path}",
      "--",
    ]);
  });

  test("imageInput must name a builtin image-input strategy (S3)", () => {
    const base = { bin: "x", exec: [], parse: { format: "text" } };
    expect(thrownMessage(() => validateAdapters({ foo: { ...base, imageInput: "nope" } }))).toBe(
      'adapters.json: adapter \'foo\'.imageInput must name a builtin image-input strategy (known: claude-stream-json) or null, got "nope"',
    );
    expect(thrownMessage(() => validateAdapters({ foo: { ...base, imageInput: 7 } }))).toBe(
      "adapters.json: adapter 'foo'.imageInput must name a builtin image-input strategy (known: claude-stream-json) or null, got number",
    );
    expect(validateAdapters({ foo: { ...base, imageInput: "claude-stream-json" } }).foo!.imageInput).toBe(
      "claude-stream-json",
    );
  });

  test("the three image mechanisms are mutually exclusive — in one def, and across a builtin merge (S3, A1c)", () => {
    const base = { bin: "x", exec: [], parse: { format: "text" } };
    const both = { ...base, image: ["{path}"], imageInput: "claude-stream-json" };
    expect(thrownMessage(() => validateAdapters({ foo: both }))).toBe(
      "adapters.json: adapter 'foo': image and imageInput are mutually exclusive — an argv template, a stdin-envelope strategy, OR a prompt-path delivery, not more than one",
    );
    const argvAndPath = { ...base, image: ["{path}"], imageDelivery: "read-tool-path" };
    expect(thrownMessage(() => validateAdapters({ foo: argvAndPath }))).toContain(
      "adapter 'foo': image and imageDelivery are mutually exclusive",
    );
    // an override lands on the MERGED def: claude's builtin imageInput
    // conflicts with an image override, codex's builtin image with an
    // imageInput override, and droid's builtin imageDelivery with either —
    // never silently one of them
    expect(thrownMessage(() => validateAdapters({ claude: { image: ["{path}"] } }))).toContain(
      "adapter 'claude': image and imageInput are mutually exclusive",
    );
    expect(thrownMessage(() => validateAdapters({ codex: { imageInput: "claude-stream-json" } }))).toContain(
      "adapter 'codex': image and imageInput are mutually exclusive",
    );
    expect(thrownMessage(() => validateAdapters({ droid: { image: ["-i", "{path}"] } }))).toContain(
      "adapter 'droid': image and imageDelivery are mutually exclusive",
    );
  });

  test("imageDelivery must name a builtin delivery strategy (A1c)", () => {
    const base = { bin: "x", exec: [], parse: { format: "text" } };
    expect(thrownMessage(() => validateAdapters({ foo: { ...base, imageDelivery: "nope" } }))).toBe(
      'adapters.json: adapter \'foo\'.imageDelivery must name a builtin image-delivery strategy (known: read-tool-path) or null, got "nope"',
    );
    expect(thrownMessage(() => validateAdapters({ foo: { ...base, imageDelivery: 7 } }))).toContain(
      "must name a builtin image-delivery strategy (known: read-tool-path) or null, got number",
    );
  });

  test("the image fields merge field-wise over the builtins like every other template (S3)", () => {
    const replaced = validateAdapters({ codex: { image: ["--img", "{path}"] } });
    expect(replaced.codex!.image).toEqual(["--img", "{path}"]); // replaced wholesale
    expect(replaced.codex!.exec).toEqual(BUILTIN_ADAPTERS.codex!.exec); // inherited
    const untouched = validateAdapters({ droid: { model: ["-m", "{model}"] } });
    expect(untouched.codex!.image).toEqual(["-i", "{path}", "--"]); // the builtin survives unrelated overrides
    expect(untouched.claude!.imageInput).toBe("claude-stream-json");
    // droid's capability is neither argv nor stdin: it is a path in the prompt (A1c)
    expect(untouched.droid!.image).toBeUndefined();
    expect(untouched.droid!.imageInput).toBeUndefined();
    expect(untouched.droid!.imageDelivery).toBe("read-tool-path");
  });

  test("null clears a builtin's image capability field — the same opt-out contract as attach/modelDiscovery", () => {
    const cleared = validateAdapters({ codex: { image: null }, claude: { imageInput: null }, droid: { imageDelivery: null } });
    expect(cleared.codex!.image).toBeNull();
    expect(cleared.claude!.imageInput).toBeNull();
    expect(cleared.droid!.imageDelivery).toBeNull();
  });

  test("null makes switching a builtin's delivery form possible: clear the old, set the new", () => {
    // droid's builtin imageDelivery would collide with an image override on
    // the merged def; null it first and the mutual-exclusion check passes
    const switched = validateAdapters({ droid: { imageDelivery: null, image: ["-i", "{path}", "--"] } });
    expect(switched.droid!.imageDelivery).toBeNull();
    expect(switched.droid!.image).toEqual(["-i", "{path}", "--"]);
    // and a cleared field counts as ABSENT for mutual exclusion, not declared
    const nulledBoth = validateAdapters({ foo: { bin: "x", exec: [], parse: { format: "text" }, image: null, imageInput: null } });
    expect(nulledBoth.foo!.image).toBeNull();
    expect(nulledBoth.foo!.imageInput).toBeNull();
  });

  test("command overrides do not silently inherit a builtin live protocol", () => {
    const warnings: string[] = [];
    const overridden = validateAdapters(
      { droid: { exec: ["exec", "--custom-wrapper-flag"] } },
      (message) => warnings.push(message),
    );
    expect(overridden.droid!.liveInput).toBeNull();
    expect(warnings).toEqual([
      "adapters.json: adapter 'droid': overriding bin or exec disables inherited liveInput; set liveInput explicitly only after verifying the custom command's native protocol",
    ]);

    const verified = validateAdapters({
      droid: {
        exec: ["exec", "--custom-wrapper-flag"],
        liveInput: "droid-jsonrpc",
      },
    });
    expect(verified.droid!.liveInput).toBe("droid-jsonrpc");
  });

  test("explicit Codex live input rejects exec flags app-server cannot preserve", () => {
    expect(() =>
      validateAdapters({
        codex: {
          exec: ["exec", "--json", "--custom-wrapper-flag"],
          liveInput: "codex-app-server",
        },
      }),
    ).toThrow(
      "adapters.json: adapter 'codex'.liveInput 'codex-app-server' is incompatible with exec: --custom-wrapper-flag cannot be forwarded to codex app-server",
    );
  });

  test("errors must name a builtin error strategy", () => {
    const base = { bin: "x", exec: [], parse: { format: "json" } };
    expect(thrownMessage(() => validateAdapters({ foo: { ...base, errors: "nope" } }))).toBe(
      'adapters.json: adapter \'foo\'.errors must name a builtin error strategy (known: claude-stream-json, codex-jsonl, droid-stream-json), got "nope"',
    );
    expect(thrownMessage(() => validateAdapters({ foo: { ...base, errors: 7 } }))).toBe(
      "adapters.json: adapter 'foo'.errors must name a builtin error strategy (known: claude-stream-json, codex-jsonl, droid-stream-json), got number",
    );
    // a new harness with a known wire shape can reuse an error strategy by name
    expect(validateAdapters({ foo: { ...base, errors: "codex-jsonl" } }).foo!.errors).toBe("codex-jsonl");
  });

  test("limitMarkers must be an array of strings", () => {
    const base = { bin: "x", exec: [], parse: { format: "text" } };
    expect(thrownMessage(() => validateAdapters({ foo: { ...base, limitMarkers: "usage limit" } }))).toBe(
      "adapters.json: adapter 'foo'.limitMarkers must be an array of strings, got string",
    );
    expect(thrownMessage(() => validateAdapters({ foo: { ...base, limitMarkers: ["ok", 3] } }))).toBe(
      "adapters.json: adapter 'foo'.limitMarkers[1] must be a string, got number",
    );
    expect(validateAdapters({ foo: { ...base, limitMarkers: ["usage limit"] } }).foo!.limitMarkers).toEqual([
      "usage limit",
    ]);
  });

  test("transientMarkers must be an array of strings", () => {
    const base = { bin: "x", exec: [], parse: { format: "text" } };
    expect(thrownMessage(() => validateAdapters({ foo: { ...base, transientMarkers: "provider fault" } }))).toBe(
      "adapters.json: adapter 'foo'.transientMarkers must be an array of strings, got string",
    );
    expect(thrownMessage(() => validateAdapters({ foo: { ...base, transientMarkers: ["ok", 3] } }))).toBe(
      "adapters.json: adapter 'foo'.transientMarkers[1] must be a string, got number",
    );
    expect(validateAdapters({ foo: { ...base, transientMarkers: ["provider fault"] } }).foo!.transientMarkers).toEqual([
      "provider fault",
    ]);
  });

  test("unknown keys inside parse warn too", () => {
    const warnings: string[] = [];
    validateAdapters({ foo: { bin: "x", exec: [], parse: { format: "text", results: "r" } } }, (m) =>
      warnings.push(m),
    );
    expect(warnings).toEqual([
      "adapters.json: adapter 'foo'.parse: unknown key 'results' — ignoring (known: format, resultType, result, session, needsInput, model, usage, skills, strategy)",
    ]);
  });

  describe("merge contract: user defs merge field-wise over builtins", () => {
    test("omitted fields are inherited from the builtin", () => {
      const out = validateAdapters({ droid: { exec: ["exec", "-o", "json"] } });
      expect(out.droid!.exec).toEqual(["exec", "-o", "json"]); // replaced
      expect(out.droid!.bin).toBe("droid"); // inherited
      expect(out.droid!.resume).toEqual(["-s", "{session}"]); // inherited
      expect(out.droid!.parse).toEqual(BUILTIN_ADAPTERS.droid!.parse); // inherited
    });

    test("provided arrays replace wholesale — they are not concatenated", () => {
      const out = validateAdapters({ claude: { resume: ["--continue", "{session}"] } });
      expect(out.claude!.resume).toEqual(["--continue", "{session}"]);
      expect(out.claude!.exec).toEqual(BUILTIN_ADAPTERS.claude!.exec); // untouched
    });

    test("parse is one field: a user parse replaces the builtin's entirely", () => {
      const out = validateAdapters({ claude: { parse: { format: "text" } } });
      expect(out.claude!.parse).toEqual({ format: "text" });
    });

    test("explicit attach: null clears the builtin's attach", () => {
      const out = validateAdapters({ claude: { attach: null } });
      expect(out.claude!.attach).toBeNull();
      expect(out.claude!.bin).toBe("claude"); // everything else inherited
    });

    test("an override may omit required fields — it inherits them", () => {
      // the review's complaint: overriding one droid flag used to mean restating the whole def
      const out = validateAdapters({ droid: { model: ["--model", "{model}"] } });
      expect(out.droid!.model).toEqual(["--model", "{model}"]);
      expect(out.droid!.exec).toEqual(BUILTIN_ADAPTERS.droid!.exec);
    });

    test("errors/limitMarkers/transientMarkers merge field-wise like everything else", () => {
      const out = validateAdapters({
        droid: { limitMarkers: ["custom quota wording"], transientMarkers: ["custom transient wording"] },
      });
      expect(out.droid!.limitMarkers).toEqual(["custom quota wording"]); // replaced wholesale
      expect(out.droid!.transientMarkers).toEqual(["custom transient wording"]); // replaced wholesale
      expect(out.droid!.errors).toBe("droid-stream-json"); // inherited
    });

    test("overrides never mutate the builtins", () => {
      validateAdapters({ droid: { exec: ["changed"], parse: { format: "text" } } });
      expect(BUILTIN_ADAPTERS.droid!.exec).toEqual(["exec", "-o", "stream-json", "--skip-permissions-unsafe"]);
      expect(BUILTIN_ADAPTERS.droid!.parse.format).toBe("json");
    });

    test("a new name gets no merge — it must stand alone", () => {
      expect(thrownMessage(() => validateAdapters({ brandnew: { exec: [] } }))).toBe(
        "adapters.json: adapter 'brandnew' is missing required field 'bin' (must be a non-empty string)",
      );
    });
  });

  describe("loadAdapters", () => {
    test("no user file → builtins only", () => {
      // ADAPTERS_PATH does not exist in the isolated test home
      expect(Object.keys(loadAdapters()).sort()).toEqual(["claude", "codex", "cursor", "droid"]);
    });

    test("reads, validates, and merges ~/.wisp/adapters.json", () => {
      writeFileSync(ADAPTERS_PATH, JSON.stringify({ fake: validNew, droid: { model: ["--model", "{model}"] } }));
      try {
        const out = loadAdapters();
        expect(out.fake!.bin).toBe("fake");
        expect(out.droid!.model).toEqual(["--model", "{model}"]); // overridden
        expect(out.droid!.exec).toEqual(BUILTIN_ADAPTERS.droid!.exec); // inherited
      } finally {
        rmSync(ADAPTERS_PATH);
      }
    });

    test("fails at boot on malformed JSON, naming the file", () => {
      writeFileSync(ADAPTERS_PATH, "{ not json");
      try {
        expect(thrownMessage(() => loadAdapters())).toStartWith("adapters.json: invalid JSON — ");
      } finally {
        rmSync(ADAPTERS_PATH);
      }
    });

    test("fails at boot on a bad def, naming adapter and field", () => {
      writeFileSync(ADAPTERS_PATH, JSON.stringify({ fake: { bin: "bash" } }));
      try {
        expect(thrownMessage(() => loadAdapters())).toBe(
          "adapters.json: adapter 'fake' is missing required field 'exec' (must be an array of strings)",
        );
      } finally {
        rmSync(ADAPTERS_PATH);
      }
    });
  });
});
