import { describe, expect, test } from "bun:test";
import {
  BUILTIN_ADAPTERS,
  createEventFormatter,
  EVENT_FORMATTERS,
  formatEvent,
  type AdapterDef,
} from "../src/adapters";
import { fixture, fixtureLine } from "./fixtures";

// formatEvent lives in the adapter layer (a prior audit): the caller passes the
// task's adapter def and its named event formatter carries the wire knowledge.
const claude = BUILTIN_ADAPTERS.claude!;
const droid = BUILTIN_ADAPTERS.droid!;
const codex = BUILTIN_ADAPTERS.codex!;
const cursor = BUILTIN_ADAPTERS.cursor!;

/** What `wisp log` would print for a whole captured turn. */
function renderTurn(name: string, def: AdapterDef): string[] {
  return fixture(name)
    .split("\n")
    .map((l) => formatEvent(l, def))
    .filter((l): l is string => l !== null);
}

describe("formatEvent", () => {
  test("claude tool_use renders as an arrow line", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Bash", input: { command: "ls" } }] },
    });
    expect(formatEvent(line, claude)).toBe(`→ Bash({"command":"ls"})`);
  });

  test("subagent activity is marked", () => {
    const line = JSON.stringify({
      type: "assistant",
      parent_tool_use_id: "toolu_123",
      message: { content: [{ type: "text", text: "sub working" }] },
    });
    expect(formatEvent(line, claude)).toBe("  [sub] sub working");
  });

  test("droid tool_call and completion", () => {
    expect(formatEvent(`{"type":"tool_call","toolName":"Execute","parameters":{"command":"echo hi"}}`, droid)).toBe(
      `→ Execute({"command":"echo hi"})`,
    );
    expect(formatEvent(`{"type":"completion","finalText":"done"}`, droid)).toBe("✓ turn complete");
  });

  /**
   * Terminal events are settlement markers, never a recap: their text repeats
   * prose the stream already carried (claude/droid: the last message exactly;
   * cursor: the whole turn fused — all byte-verified on real logs), so printing
   * it again duplicates. Only an error result still prints — its text may be
   * content that never streamed.
   */
  test("successful terminal events are markers, not recaps", () => {
    expect(formatEvent(`{"type":"result","subtype":"success","is_error":false,"result":"all done"}`, claude)).toBe(
      "✓ turn complete",
    );
    expect(formatEvent(`{"type":"completion","finalText":"done"}`, droid)).toBe("✓ turn complete");
    expect(
      formatEvent(`{"type":"result","subtype":"success","is_error":false,"result":"fused turn text"}`, cursor),
    ).toBe("✓ turn complete");
  });

  test("an error result still prints its text — it may be content that never streamed", () => {
    // claude's is_error:true result keeps subtype "success" (the
    // claude-unknown-model fixture), so the branch reads is_error, not subtype
    expect(
      formatEvent(`{"type":"result","subtype":"success","is_error":true,"result":"Invalid model: bogus"}`, claude),
    ).toBe("✗ Invalid model: bogus");
    expect(formatEvent(`{"type":"result","subtype":"success","is_error":true,"result":"boom"}`, cursor)).toBe(
      "✗ boom",
    );
  });

  test("noise events are dropped, non-json passes through", () => {
    expect(formatEvent(`{"type":"usage","tokens":1}`, droid)).toBeNull();
    expect(formatEvent(`{"type":"rate_limit_event"}`, claude)).toBeNull();
    expect(formatEvent("", claude)).toBeNull();
    expect(formatEvent("plain stderr text", claude)).toBe("plain stderr text");
  });

  /**
   * `~` is the thinking marker: the conversation groups those lines into an
   * expandable "Thinking" row, which is how you tell a long thought from a
   * stuck turn. Every shape below came from a real log, never from docs.
   */
  test("droid reasoning becomes a ~ line, carrying its text", () => {
    expect(formatEvent(`{"type":"reasoning","text":"Let me read the brief first."}`, droid)).toBe(
      "~ Let me read the brief first.",
    );
    expect(formatEvent(JSON.stringify({ type: "reasoning", text: "\nFirst thought\n\n- supporting detail\n" }), droid)).toBe(
      "~ First thought\n~\n~ - supporting detail",
    );
    // an empty one is not a thought worth a row
    expect(formatEvent(`{"type":"reasoning","text":""}`, droid)).toBeNull();
  });

  test("human Droid rendering drops only adjacent byte-identical reasoning events", () => {
    const render = createEventFormatter(droid);
    const first = JSON.stringify({ type: "reasoning", id: "r1", text: "\nInspect the image." });
    const update = JSON.stringify({ type: "reasoning", id: "r1", text: "\nInspect the image carefully." });
    expect(render(first)).toBe("~ Inspect the image.");
    expect(render(first)).toBeNull();
    expect(render(update)).toBe("~ Inspect the image carefully."); // same id, changed content is real
    expect(render(`{"type":"message","role":"assistant","text":"visible"}`)).toBe("visible");
    expect(render(first)).toBe("~ Inspect the image."); // an intervening event resets adjacency
    const noId = JSON.stringify({ type: "reasoning", text: "Repeated but has no identity." });
    expect(render(noId)).toBe("~ Repeated but has no identity.");
    expect(render(noId)).toBe("~ Repeated but has no identity."); // ambiguity is preserved, never guessed away
  });

  test("claude thinking marks the turn alive even though its text is encrypted", () => {
    // verified against 167 real thinking blocks: `thinking` is always "" and
    // the content lives in `signature`, so the bare marker is the whole signal
    const encrypted = `{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"","signature":"CAIS6w"}]}}`;
    expect(formatEvent(encrypted, claude)).toBe("~");
    // and if a build ever populates it, the text rides along
    const withText = `{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"weighing options","signature":"x"}]}}`;
    expect(formatEvent(withText, claude)).toBe("~ weighing options");
  });

  test("codex reasoning stays dropped — its shape has never been captured", () => {
    expect(formatEvent(`{"type":"item.completed","item":{"type":"reasoning"}}`, codex)).toBeNull();
  });

  test("init shows session id for both builtins", () => {
    expect(formatEvent(`{"type":"system","subtype":"init","session_id":"abc"}`, claude)).toBe("· session abc");
    expect(formatEvent(`{"type":"system","subtype":"init","session_id":"d-1"}`, droid)).toBe("· session d-1");
    expect(formatEvent(`{"type":"thread.started","thread_id":"01a0"}`, codex)).toBe("· session 01a0");
    expect(formatEvent(`{"type":"system","subtype":"init","session_id":"c-1"}`, cursor)).toBe("· session c-1");
  });

  describe("cursor (slice 9 — shapes binary-verified against cursor-agent 2026.08.11)", () => {
    test("assistant text renders, tool_call derives the tool's name from its variant key", () => {
      const text = JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "looking now" }] },
        session_id: "c-1",
      });
      expect(formatEvent(text, cursor)).toBe("looking now");

      const started = JSON.stringify({
        type: "tool_call",
        subtype: "started",
        call_id: "tc1",
        tool_call: { shellToolCall: { command: "ls -la" } },
        session_id: "c-1",
      });
      expect(formatEvent(started, cursor)).toBe(`→ shell({"command":"ls -la"})`);

      const completed = JSON.stringify({
        type: "tool_call",
        subtype: "completed",
        call_id: "tc1",
        tool_call: { readToolCall: { path: "/tmp/x" } },
        session_id: "c-1",
      });
      expect(formatEvent(completed, cursor)).toBe(`← read({"path":"/tmp/x"})`);
    });

    test("a tool_call whose payload shape moved still says SOMETHING, never nothing", () => {
      const line = JSON.stringify({ type: "tool_call", subtype: "started", tool_call: {}, session_id: "c-1" });
      expect(formatEvent(line, cursor)).toBe("→ tool({})");
    });

    test("result is a settlement marker; housekeeping events stay silent", () => {
      expect(formatEvent(`{"type":"result","subtype":"success","is_error":false,"result":"OK"}`, cursor)).toBe(
        "✓ turn complete",
      );
      expect(formatEvent(`{"type":"system","subtype":"task_notification","task_id":"t"}`, cursor)).toBeNull();
      expect(formatEvent(`{"type":"approval"}`, cursor)).toBeNull();
    });

    // Real cursor-agent 2026.08.31 output (tests/fixtures/README.md): the turn
    // says something, runs a command, says something else — and the result
    // event carries ALL of it fused ("…now.done"). The human feed must show
    // each prose line once, in place, and never the fused blob.
    test("a whole captured turn renders each message once, the fused result never", () => {
      const lines = renderTurn("cursor-accumulated-result.jsonl", cursor);
      expect(lines).toHaveLength(6);
      expect(lines[0]).toBe("· session 093d92b3-24d8-5488-a85e-5c731561410d");
      expect(lines[1]).toBe("I'll run that echo command now.");
      expect(lines[2]).toStartWith("→ shell(");
      expect(lines[3]).toStartWith("← shell(");
      expect(lines[4]).toBe("done");
      expect(lines[5]).toBe("✓ turn complete");
      expect(lines.some((l) => l.includes("now.done"))).toBe(false);
    });
  });

  // rendered from real captured output (tests/fixtures/README.md)
  describe("codex", () => {
    test("a whole first turn reads as an activity feed", () => {
      expect(renderTurn("codex-first-turn.jsonl", codex)).toEqual([
        "· session cf851ea9-c5ab-5f68-9ae8-badc06afd3ec",
        "papaya",
        "✓ turn complete",
      ]);
    });

    test("a resume turn shows the command it ran and the command's output", () => {
      expect(renderTurn("codex-resume-turn.jsonl", codex)).toEqual([
        "· session cf851ea9-c5ab-5f68-9ae8-badc06afd3ec",
        "I’ll run the requested command, then answer with the earlier word.",
        `→ /bin/zsh -lc 'echo hi'`,
        "← [exit 0] hi ",
        "papaya",
        "✓ turn complete",
      ]);
    });

    test("a failed turn names the failure — never a silent feed", () => {
      const lines = renderTurn("codex-failed-turn.jsonl", codex);
      expect(lines[1]).toStartWith("✗ Model metadata for `no-such-model-xyz` not found.");
      expect(lines[lines.length - 1]).toStartWith("✗ turn failed: ");
      expect(lines[lines.length - 1]).toContain("model is not supported");
    });

    test("noise is dropped; reasoning and item.updated do not clutter the feed", () => {
      expect(formatEvent(`{"type":"turn.started"}`, codex)).toBeNull();
      expect(formatEvent(`{"type":"item.completed","item":{"type":"reasoning","text":"hmm"}}`, codex)).toBeNull();
      expect(
        formatEvent(`{"type":"item.updated","item":{"type":"command_execution","command":"ls"}}`, codex),
      ).toBeNull();
      // item.started only pre-echoes commands
      expect(formatEvent(`{"type":"item.started","item":{"type":"agent_message"}}`, codex)).toBeNull();
    });

    test("item types this build never captured live still show up, not vanish", () => {
      expect(formatEvent(`{"type":"item.completed","item":{"type":"web_search","query":"bun spawn"}}`, codex)).toBe(
        `→ web_search({"type":"web_search","query":"bun spawn"})`,
      );
    });

    test("a turn.failed with an unexpected error shape still prints the error", () => {
      expect(formatEvent(`{"type":"turn.failed","error":{"code":429}}`, codex)).toBe(`✗ turn failed: {"code":429}`);
    });

    test("codex events mean nothing to the other formatters", () => {
      expect(formatEvent(fixtureLine("codex-first-turn.jsonl", 0), claude)).toBeNull();
      expect(formatEvent(fixtureLine("codex-first-turn.jsonl", 2), droid)).toBeNull();
    });
  });

  test("one harness's events are not rendered through another's formatter", () => {
    // droid's completion means nothing to claude's formatter — dropped as noise
    expect(formatEvent(`{"type":"completion","finalText":"done"}`, claude)).toBeNull();
    expect(formatEvent(`{"type":"result","result":"done"}`, droid)).toBeNull();
  });

  test("a code-built def naming an unknown formatter throws loudly (validate catches it at load; this is the belt-and-braces path)", () => {
    const bad: AdapterDef = { bin: "x", exec: [], parse: { format: "json" }, events: "nope" };
    expect(() => formatEvent(`{"type":"result","result":"done"}`, bad)).toThrow(
      `adapter events 'nope' is not a known event formatter (known: ${Object.keys(EVENT_FORMATTERS).join(", ")})`,
    );
  });

  test("no event formatter (text harness, unknown adapter): json passes through raw", () => {
    const textDef: AdapterDef = { bin: "x", exec: [], parse: { format: "text" } };
    expect(formatEvent(`{"result":"echo","session_id":"fake-1"}`, textDef)).toBe(
      `{"result":"echo","session_id":"fake-1"}`,
    );
    expect(formatEvent(`{"result":"echo"}`)).toBe(`{"result":"echo"}`);
    expect(formatEvent("plain line", textDef)).toBe("plain line");
  });
});
