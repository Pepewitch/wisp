import { describe, expect, test } from "bun:test";
import { BUILTIN_ADAPTERS, parseOutput } from "../src/adapters";
import { boundedOutput, MAX_INLINE_OUTPUT_CHARS } from "../src/adapters/live/bounded-output";
import { CodexLiveDriver } from "../src/adapters/live/codex";
import { DroidLiveDriver } from "../src/adapters/live/droid";
import { JsonLineBuffer, MAX_PROTOCOL_FRAME_CHARS } from "../src/adapters/live/json-lines";
import { JsonRpcPeer, type WritableRpcSink } from "../src/adapters/live/json-rpc";

class MemorySink implements WritableRpcSink {
  readonly lines: string[] = [];
  ended = false;

  write(data: string): void {
    this.lines.push(data.trimEnd());
  }

  flush(): void {}

  end(): void {
    this.ended = true;
  }
}

async function requestAt(sink: MemorySink, index: number): Promise<Record<string, any>> {
  while (sink.lines.length <= index) await Bun.sleep(0);
  return JSON.parse(sink.lines[index]!) as Record<string, any>;
}

describe("bounded live protocol transport", () => {
  test("JSON-RPC calls time out and late responses are ignored", async () => {
    const sink = new MemorySink();
    const peer = new JsonRpcPeer({
      sink,
      label: "test peer",
      timeoutMs: 10,
      errorMessage: () => "error",
    });
    const call = peer.call("never/replies", {});
    await expect(call).rejects.toThrow("test peer request 'never/replies' timed out after 10ms");
    expect(peer.handle({ id: 1, result: {} })).toBe(true);
    await peer.close();
    expect(sink.ended).toBe(true);
  });

  test("closing the peer rejects every pending call", async () => {
    const sink = new MemorySink();
    const peer = new JsonRpcPeer({
      sink,
      label: "test peer",
      timeoutMs: 1_000,
      errorMessage: () => "error",
    });
    const call = peer.call("pending", {});
    const rejection = call.catch((error: Error) => error);
    await peer.close();
    expect(await rejection).toEqual(new Error("test peer input is closed"));
  });

  test("a stalled sink cannot hold serialized writes open forever", async () => {
    let ended = false;
    const peer = new JsonRpcPeer({
      sink: {
        write: () => {},
        flush: () => new Promise<void>(() => {}),
        end: () => {
          ended = true;
        },
      },
      label: "stalled peer",
      timeoutMs: 10,
      errorMessage: () => "error",
    });

    await expect(peer.call("blocked", {})).rejects.toThrow(/timed out after 10ms/);
    await peer.close();
    expect(ended).toBe(true);
  });

  test("an oversized complete frame is dropped without disturbing its neighbours", () => {
    const dropped: number[] = [];
    const frames = new JsonLineBuffer({ maxFrameChars: 8, onDrop: (chars) => dropped.push(chars) });

    expect(frames.push(`ok\n${"x".repeat(9)}\nafter\n`)).toEqual(["ok", "after"]);
    expect(dropped).toEqual([9]);
  });

  test("an oversized partial resyncs at the next newline instead of killing the turn", () => {
    const dropped: number[] = [];
    const frames = new JsonLineBuffer({ maxFrameChars: 8, onDrop: (chars) => dropped.push(chars) });

    // The frame overflows before its newline ever arrives, so the buffer
    // cannot know its length up front — it discards until framing resyncs.
    expect(frames.push("x".repeat(9))).toEqual([]);
    expect(dropped).toEqual([]);
    expect(frames.push("yyy")).toEqual([]);
    expect(frames.push("zz\nnext\n")).toEqual(["next"]);
    expect(dropped).toEqual([14]);
  });

  test("a stream that ends mid-overflow reports the drop and emits no fragment", () => {
    const dropped: number[] = [];
    const frames = new JsonLineBuffer({ maxFrameChars: 8, onDrop: (chars) => dropped.push(chars) });

    frames.push("x".repeat(9));
    expect(frames.finish("yy")).toEqual([]);
    expect(dropped).toEqual([11]);
  });

  test("the default cap admits frames far larger than any inlined command output", () => {
    const dropped: number[] = [];
    const frames = new JsonLineBuffer({ onDrop: (chars) => dropped.push(chars) });
    const large = "x".repeat(2 * 1_048_576);

    expect(frames.push(`${large}\n`)).toEqual([large]);
    expect(dropped).toEqual([]);
    expect(MAX_PROTOCOL_FRAME_CHARS).toBeGreaterThan(large.length);
  });
});

describe("Codex live terminal events", () => {
  test("a failed completion emits one failed terminal with usage", async () => {
    const sink = new MemorySink();
    const events: Record<string, any>[] = [];
    let terminalCount = 0;
    const driver = new CodexLiveDriver({
      sink,
      def: BUILTIN_ADAPTERS.codex!,
      cwd: "/tmp",
      sessionId: null,
      model: null,
      effort: null,
      initialMessageId: "initial-message",
      initialInput: [{ type: "text", text: "hello", text_elements: [] }],
      emit: (event) => events.push(event),
      onTerminal: () => {
        terminalCount++;
      },
    });

    const initialize = await requestAt(sink, 0);
    driver.handle({ id: initialize.id, result: {} });
    expect((await requestAt(sink, 1)).method).toBe("initialized");
    const startThread = await requestAt(sink, 2);
    driver.handle({ id: startThread.id, result: { thread: { id: "thread-1" }, model: "gpt-test" } });
    const startTurn = await requestAt(sink, 3);
    driver.handle({ id: startTurn.id, result: { turn: { id: "turn-1" } } });
    await driver.ready;

    driver.handle({
      method: "thread/tokenUsage/updated",
      params: { turnId: "turn-1", tokenUsage: { last: { inputTokens: 7, outputTokens: 2 } } },
    });
    const failure = {
      method: "turn/completed",
      params: { turn: { id: "turn-1", status: "failed", error: { message: "quota exhausted" } } },
    };
    driver.handle(failure);
    driver.handle(failure);

    expect(events.filter((event) => event.type === "turn.completed")).toEqual([]);
    expect(events.filter((event) => event.type === "turn.failed")).toEqual([
      {
        type: "turn.failed",
        error: { message: "quota exhausted" },
        usage: { input_tokens: 7, output_tokens: 2 },
      },
    ]);
    const parsed = parseOutput(BUILTIN_ADAPTERS.codex!, events.map((event) => JSON.stringify(event)).join("\n"));
    expect(parsed).toMatchObject({
      isError: true,
      usage: { input_tokens: 7, output_tokens: 2 },
    });
    expect(terminalCount).toBe(1);
    await driver.close();
  });

  test("a command's inlined output is bounded before it reaches the log", async () => {
    const sink = new MemorySink();
    const events: Record<string, any>[] = [];
    const driver = new CodexLiveDriver({
      sink,
      def: BUILTIN_ADAPTERS.codex!,
      cwd: "/tmp",
      sessionId: null,
      model: null,
      effort: null,
      initialMessageId: "initial-message",
      initialInput: [{ type: "text", text: "hello", text_elements: [] }],
      emit: (event) => events.push(event),
      onTerminal: () => {},
    });

    const initialize = await requestAt(sink, 0);
    driver.handle({ id: initialize.id, result: {} });
    const startThread = await requestAt(sink, 2);
    driver.handle({ id: startThread.id, result: { thread: { id: "thread-1" } } });
    const startTurn = await requestAt(sink, 3);
    driver.handle({ id: startTurn.id, result: { turn: { id: "turn-1" } } });
    await driver.ready;

    const output = `${"head".repeat(50_000)}TAIL`;
    driver.handle({
      method: "item/completed",
      params: {
        item: { id: "exec-1", type: "commandExecution", command: "grep -r x .", aggregatedOutput: output, exitCode: 0 },
      },
    });

    const item = events.find((event) => event.type === "item.completed")!.item as Record<string, any>;
    const bounded = item.aggregated_output as string;
    expect(bounded.length).toBeLessThan(output.length);
    expect(bounded).toStartWith("head");
    // The tail survives: a command's error or exit banner is usually last.
    expect(bounded).toEndWith("TAIL");
    expect(bounded).toContain("characters elided");
    await driver.close();
  });
});

describe("bounded inlined tool output", () => {
  test("a string keeps both ends and names what was removed", () => {
    const bounded = boundedOutput(`${"head".repeat(20_000)}TAIL`, 400) as string;

    expect(bounded).toStartWith("head");
    expect(bounded).toEndWith("TAIL");
    expect(bounded).toContain("characters elided");
    expect(bounded.length).toBeLessThan(600);
  });

  test("content blocks share one budget, so many small blocks cannot add up to a large one", () => {
    const blocks = Array.from({ length: 40 }, (_, index) => ({ type: "text", text: "x".repeat(100 * index) }));
    const bounded = boundedOutput(blocks, 500) as unknown[];

    expect(bounded.length).toBeLessThan(blocks.length);
    expect(bounded.at(-1)).toContain("more content blocks elided");
    const spent = bounded
      .filter((block): block is { text: string } => typeof (block as { text?: unknown }).text === "string")
      .reduce((total, block) => total + block.text.length, 0);
    // Elision markers add their own characters; the payload itself stays bounded.
    expect(spent).toBeLessThan(1_500);
  });

  test("a shape the harness has never been observed to send is passed through untouched", () => {
    const value = { status: "ok", exitCode: 0 };

    expect(boundedOutput(value)).toBe(value);
    expect(boundedOutput(null)).toBeNull();
    expect(boundedOutput(7)).toBe(7);
  });

  test("output that already fits is returned unchanged", () => {
    expect(boundedOutput("short")).toBe("short");
    expect(MAX_INLINE_OUTPUT_CHARS).toBeGreaterThan(1_000);
  });
});

describe("Droid live tool results", () => {
  test("an inlined tool result is bounded before it reaches the log", async () => {
    const sink = new MemorySink();
    const events: Record<string, any>[] = [];
    const driver = new DroidLiveDriver({
      sink,
      def: BUILTIN_ADAPTERS.droid!,
      cwd: "/tmp",
      sessionId: null,
      model: null,
      effort: null,
      initialMessageId: "initial-message",
      initialText: "hello",
      initialImages: [],
      emit: (event) => events.push(event),
      onTerminal: () => {},
    });

    const initialize = await requestAt(sink, 0);
    driver.handle({ id: initialize.id, result: { sessionId: "droid-session" } });
    const firstMessage = await requestAt(sink, 1);
    driver.handle({ id: firstMessage.id, result: {} });
    await driver.ready;

    const output = `${"line\n".repeat(50_000)}TAIL`;
    driver.handle({
      method: "droid.session_notification",
      params: {
        notification: {
          type: "create_message",
          message: {
            id: "message-1",
            role: "user",
            content: [{ type: "tool_result", toolUseId: "tool-1", content: output }],
          },
        },
      },
    });

    const result = events.find((event) => event.type === "tool_result")!;
    const value = result.value as string;
    expect(value.length).toBeLessThan(output.length);
    expect(value).toStartWith("line");
    expect(value).toEndWith("TAIL");
    expect(value).toContain("characters elided");
    await driver.close();
  });

  test("a subagent handoff stays linkable: the markers it leads with survive bounding", () => {
    const report = `task_id: child-1\nsession_id: session-1\n${"detail\n".repeat(50_000)}`;
    const bounded = boundedOutput(report) as string;

    expect(/(?:^|\n)task_id:\s*([^\s\n]+)/.exec(bounded)?.[1]).toBe("child-1");
    expect(/(?:^|\n)session_id:\s*([^\s\n]+)/.exec(bounded)?.[1]).toBe("session-1");
  });
});
