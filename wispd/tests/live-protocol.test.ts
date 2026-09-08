import { describe, expect, test } from "bun:test";
import { BUILTIN_ADAPTERS, createActivityFormatter, parseOutput } from "../src/adapters";
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

  test("a child thread's markers reach the structured stream as one subagent, not raw tool calls", async () => {
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

    const spawn = { id: "call-1", type: "subAgentActivity", kind: "started", agentThreadId: "thread-2", agentPath: "/root/reviewer" };
    const done = { id: "subagent-completed-1", type: "subAgentActivity", kind: "completed", agentThreadId: "thread-2", agentPath: "/root/reviewer" };
    driver.handle({ method: "item/started", params: { item: spawn, startedAtMs: 1 } });
    driver.handle({ method: "item/completed", params: { item: spawn, completedAtMs: 1 } });
    driver.handle({ method: "item/completed", params: { item: done, completedAtMs: 2 } });

    // The driver's wire dialect and the activity normalizer must agree: this
    // pair is what once rendered a subagent as a raw `subagent_activity` tool.
    const format = createActivityFormatter(BUILTIN_ADAPTERS.codex!);
    const activity = events.flatMap((event) => format(JSON.stringify(event)));
    expect(activity.filter((event) => event.kind === "tool")).toEqual([]);
    expect(activity).toEqual([
      expect.objectContaining({ kind: "subagent", id: "call-1", agentId: "thread-2", phase: "started", status: "running", title: "reviewer", timestamp: 1 }),
      expect.objectContaining({ kind: "subagent", id: "call-1", agentId: "thread-2", phase: "updated", status: "running", timestamp: 1 }),
      expect.objectContaining({ kind: "subagent", id: "thread-2", agentId: "thread-2", phase: "completed", status: "completed", timestamp: 2 }),
    ]);
    await driver.close();
  });
});

describe("Codex child threads", () => {
  test("a child's items are scoped, its thread is described once, and its own turn settles the card", async () => {
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
    const startThread = await requestAt(sink, 2);
    driver.handle({ id: startThread.id, result: { thread: { id: "thread-1" } } });
    const startTurn = await requestAt(sink, 3);
    driver.handle({ id: startTurn.id, result: { turn: { id: "turn-1" } } });
    await driver.ready;

    const spawn = { id: "call-1", type: "subAgentActivity", kind: "started", agentThreadId: "thread-2", agentPath: "/root/reviewer" };
    driver.handle({ method: "item/started", params: { threadId: "thread-1", turnId: "turn-1", item: spawn, startedAtMs: 1 } });
    driver.handle({ method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", item: spawn, completedAtMs: 1 } });

    // One metadata-only read per child, not one per marker.
    const read = await requestAt(sink, 4);
    expect(read).toMatchObject({ method: "thread/read", params: { threadId: "thread-2", includeTurns: false } });
    expect(sink.lines).toHaveLength(5);
    driver.handle({
      id: read.id,
      result: { thread: { id: "thread-2", parentThreadId: "thread-1", model: "gpt-test", reasoningEffort: "high", agentRole: "reviewer", agentNickname: "quiet-otter" } },
    });
    await Bun.sleep(0);

    driver.handle({
      method: "item/completed",
      params: { threadId: "thread-2", turnId: "turn-2", item: { id: "msg-1", type: "agentMessage", text: "No findings." }, completedAtMs: 2 },
    });
    driver.handle({
      method: "turn/completed",
      params: {
        threadId: "thread-2",
        turn: { id: "turn-2", status: "completed", items: [{ id: "msg-1", type: "agentMessage", text: "No findings." }], durationMs: 1234, completedAt: 3 },
      },
    });
    expect(terminalCount).toBe(0);
    expect(events.filter((event) => event.type === "turn.completed")).toEqual([]);

    driver.handle({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } });
    expect(terminalCount).toBe(1);

    expect(events).toEqual([
      expect.objectContaining({ type: "thread.started", thread_id: "thread-1" }),
      expect.objectContaining({ type: "item.started", thread_id: "thread-1", item: expect.objectContaining({ type: "subagent_activity" }) }),
      expect.objectContaining({ type: "item.completed", thread_id: "thread-1" }),
      { type: "thread.child", thread_id: "thread-2", parent_thread_id: "thread-1", model: "gpt-test", reasoning_effort: "high", agent_role: "reviewer", agent_nickname: "quiet-otter" },
      expect.objectContaining({ type: "item.completed", thread_id: "thread-2", item: expect.objectContaining({ type: "agent_message", text: "No findings." }) }),
      { type: "subagent.completed", thread_id: "thread-2", status: "completed", error: null, result: "No findings.", duration_ms: 1234, timestamp: 3000 },
      expect.objectContaining({ type: "turn.completed" }),
    ]);

    // End to end: the card carries the child's identity and its work nests beneath it.
    const format = createActivityFormatter(BUILTIN_ADAPTERS.codex!);
    const activity = events.flatMap((event) => format(JSON.stringify(event)));
    expect(activity).toEqual([
      expect.objectContaining({ kind: "subagent", id: "call-1", agentId: "thread-2", parentId: null, phase: "started", title: "reviewer" }),
      expect.objectContaining({ kind: "subagent", id: "call-1", agentId: "thread-2", phase: "updated" }),
      expect.objectContaining({ kind: "subagent", id: "thread-2", model: "gpt-test", effort: "high", agentType: "reviewer", status: "running" }),
      expect.objectContaining({ kind: "text", parentId: "thread-2", text: "No findings." }),
      expect.objectContaining({ kind: "subagent", id: "thread-2", phase: "completed", status: "completed", result: "No findings.", durationMs: 1234, timestamp: 3000 }),
    ]);
    await driver.close();
  });

  test("a failed metadata read leaves the card unlabelled and the turn unharmed", async () => {
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

    driver.handle({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        item: { id: "call-1", type: "subAgentActivity", kind: "started", agentThreadId: "thread-2", agentPath: "/root/reviewer" },
        completedAtMs: 1,
      },
    });
    const read = await requestAt(sink, 4);
    driver.handle({ id: read.id, error: { code: -32601, message: "method not found" } });
    await Bun.sleep(0);
    expect(events.filter((event) => event.type === "thread.child")).toEqual([]);
    expect(events.filter((event) => event.type === "error")).toEqual([]);
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

describe("Droid live turn completion", () => {
  async function bootDroid(): Promise<{
    driver: DroidLiveDriver;
    sink: MemorySink;
    events: Record<string, any>[];
    terminals: number[];
  }> {
    const sink = new MemorySink();
    const events: Record<string, any>[] = [];
    const terminals: number[] = [];
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
      onTerminal: () => {
        terminals.push(Date.now());
      },
    });
    const initialize = await requestAt(sink, 0);
    driver.handle({ id: initialize.id, result: { sessionId: "droid-session" } });
    const firstMessage = await requestAt(sink, 1);
    driver.handle({ id: firstMessage.id, result: {} });
    await driver.ready;
    return { driver, sink, events, terminals };
  }

  function notify(driver: DroidLiveDriver, notification: Record<string, unknown>): void {
    driver.handle({
      method: "droid.session_notification",
      params: { notification },
    });
  }

  test("AskUser ends the turn as needs-input and closes stdin without waiting for idle", async () => {
    const { driver, events, terminals } = await bootDroid();
    notify(driver, {
      type: "create_message",
      message: {
        id: "assistant-1",
        role: "assistant",
        content: [
          { type: "text", text: "which option?" },
          { type: "tool_use", id: "ask-1", name: "AskUser", input: { questionnaire: "pick one" } },
        ],
        modelId: "fake-droid-model",
        createdAt: 123,
      },
    });

    expect(terminals).toHaveLength(1);
    expect(events.filter((event) => event.type === "completion")).toEqual([
      {
        type: "completion",
        finalText: "which option?",
        session_id: "droid-session",
        model: "fake-droid-model",
        usage: null,
        isError: false,
        needs_input: ["AskUser"],
      },
    ]);
    const parsed = parseOutput(
      BUILTIN_ADAPTERS.droid!,
      events.map((event) => JSON.stringify(event)).join("\n"),
    );
    expect(parsed).toMatchObject({ result: "which option?", needsInput: true, isError: false });
    await expect(driver.send("later", "a reply", [])).rejects.toThrow("Droid turn already completed");
    await driver.close();
  });

  test("agent_turn_completed closes stdin without an idle event, for success and error", async () => {
    for (const reason of ["completed", "error"] as const) {
      const { driver, events, terminals } = await bootDroid();
      notify(driver, {
        type: "create_message",
        message: {
          id: "assistant-1",
          role: "assistant",
          content: [{ type: "text", text: "done" }],
          createdAt: 1,
        },
      });
      notify(driver, {
        type: "agent_turn_completed",
        reason,
        tokenUsage: { inputTokens: 3, outputTokens: 1 },
      });

      expect(terminals).toHaveLength(1);
      expect(events.filter((event) => event.type === "completion")).toEqual([
        {
          type: "completion",
          finalText: "done",
          session_id: "droid-session",
          model: null,
          usage: { input_tokens: 3, output_tokens: 1 },
          isError: reason !== "completed",
        },
      ]);
      if (reason === "error") {
        expect(events.filter((event) => event.type === "error")).toEqual([
          { type: "error", source: "agent_loop", message: "Droid turn error" },
        ]);
      }
      await driver.close();
    }
  });

  test("an error completion with no assistant text leaves finalText empty", async () => {
    const { driver, events, terminals } = await bootDroid();
    notify(driver, { type: "agent_turn_completed", reason: "error" });
    expect(terminals).toHaveLength(1);
    expect(events.filter((event) => event.type === "completion")).toEqual([
      {
        type: "completion",
        finalText: "",
        session_id: "droid-session",
        model: null,
        usage: null,
        isError: true,
      },
    ]);
    expect(events.filter((event) => event.type === "error")).toEqual([
      { type: "error", source: "agent_loop", message: "Droid turn error" },
    ]);
    await driver.close();
  });
});
