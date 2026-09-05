import { describe, expect, test } from "bun:test";
import { BUILTIN_ADAPTERS, parseOutput } from "../src/adapters";
import { CodexLiveDriver } from "../src/adapters/live/codex";
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
