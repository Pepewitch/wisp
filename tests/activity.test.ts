import { describe, expect, test } from "bun:test";
import { BUILTIN_ADAPTERS, createActivityFormatter, type ActivityEvent, type AdapterDef } from "../src/adapters";
import { formatSteerNote } from "../src/turn-notes";
import { fixture } from "./fixtures";

function render(def: AdapterDef, events: Record<string, unknown>[]): ActivityEvent[] {
  const format = createActivityFormatter(def);
  return events.flatMap((event) => format(JSON.stringify(event)));
}

function renderFixture(def: AdapterDef, name: string): ActivityEvent[] {
  const events = fixture(name)
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  return render(def, events);
}

describe("structured activity normalization", () => {
  describe("captured subagent lifecycles", () => {
    test("Claude Agent events preserve the child lifecycle and nested tool activity", () => {
      const events = renderFixture(BUILTIN_ADAPTERS.claude!, "claude-subagent.jsonl");
      expect(events).toContainEqual(expect.objectContaining({
        kind: "subagent",
        id: "call-claude-subagent",
        agentId: "agent-claude",
        status: "running",
        title: "Get package.json name field",
        agentType: "Explore",
      }));
      expect(events).toContainEqual(expect.objectContaining({
        kind: "tool",
        id: "call-claude-child-tool",
        parentId: "call-claude-subagent",
        name: "Bash",
      }));
      expect(events).toContainEqual(expect.objectContaining({
        kind: "subagent",
        id: "call-claude-subagent",
        agentId: "agent-claude",
        status: "completed",
        result: "wisp",
        durationMs: 3980,
      }));
      expect(events).toContainEqual(expect.objectContaining({
        kind: "subagent",
        id: "call-claude-subagent",
        status: "completed",
        durationMs: 3981,
      }));
    });

    test("Claude Bash task_* events stay a tool, not a 0s subagent", () => {
      const events = render(BUILTIN_ADAPTERS.claude!, [
        {
          type: "assistant",
          timestamp: "2026-09-03T09:47:52.498Z",
          message: {
            content: [{
              type: "tool_use",
              id: "toolu-bash",
              name: "Bash",
              input: { command: "pnpm test", description: "Set up worktree dependencies" },
            }],
          },
        },
        {
          type: "system",
          subtype: "task_started",
          task_id: "bash-task",
          tool_use_id: "toolu-bash",
          description: "Set up worktree dependencies",
          is_backgrounded: false,
          task_type: "local_bash",
        },
        {
          type: "system",
          subtype: "task_notification",
          task_id: "bash-task",
          tool_use_id: "toolu-bash",
          status: "completed",
          summary: "Set up worktree dependencies",
        },
        {
          type: "user",
          timestamp: "2026-09-03T09:49:45.129Z",
          message: {
            content: [{ tool_use_id: "toolu-bash", type: "tool_result", content: "Worktree ready", is_error: false }],
          },
        },
      ]);
      expect(events.filter((event) => event.kind === "subagent")).toEqual([]);
      expect(events).toEqual([
        expect.objectContaining({
          kind: "tool",
          id: "toolu-bash",
          name: "Bash",
          phase: "started",
        }),
        expect.objectContaining({
          kind: "tool",
          id: "toolu-bash",
          phase: "completed",
          output: "Worktree ready",
        }),
      ]);
    });

    test("Droid correlates Task results by event id and extracts the child session", () => {
      const events = renderFixture(BUILTIN_ADAPTERS.droid!, "droid-subagent.jsonl");
      expect(events).toEqual([
        expect.objectContaining({ kind: "subagent", id: "call-droid-subagent", status: "running" }),
        expect.objectContaining({
          kind: "subagent",
          id: "call-droid-subagent",
          agentId: "agent-droid",
          status: "completed",
          result: "wisp",
        }),
      ]);
    });

    test("Codex correlates spawn and wait events through the receiver thread", () => {
      const events = renderFixture(BUILTIN_ADAPTERS.codex!, "codex-subagent.jsonl");
      expect(events).toContainEqual(expect.objectContaining({
        kind: "subagent",
        id: "item-spawn",
        agentId: "agent-codex",
        status: "running",
      }));
      expect(events).toContainEqual(expect.objectContaining({
        kind: "subagent",
        id: "agent-codex",
        agentId: "agent-codex",
        status: "completed",
        result: "wisp",
      }));
    });

    test("Cursor reads camelCase child output, identity, and duration", () => {
      const events = renderFixture(BUILTIN_ADAPTERS.cursor!, "cursor-subagent.jsonl");
      expect(events).toEqual([
        expect.objectContaining({
          kind: "subagent",
          id: "call-cursor-subagent",
          status: "running",
          model: "composer-2.5",
        }),
        expect.objectContaining({
          kind: "subagent",
          id: "call-cursor-subagent",
          agentId: "agent-cursor",
          status: "completed",
          result: "wisp",
          durationMs: 8490,
        }),
      ]);
    });
  });

  test("Claude preserves nested tools and subagent failure under the Task call", () => {
    const events = render(BUILTIN_ADAPTERS.claude!, [
      {
        type: "assistant",
        timestamp: "2026-09-01T12:00:00Z",
        message: {
          content: [{
            type: "tool_use",
            id: "task-1",
            name: "Task",
            input: {
              description: "Trace event flow",
              subagent_type: "explorer",
              complexity: "medium",
              prompt: "Inspect the adapters",
            },
          }],
        },
      },
      {
        type: "assistant",
        parent_tool_use_id: "task-1",
        message: {
          content: [
            { type: "text", text: "Reading the formatter." },
            { type: "tool_use", id: "read-1", name: "Read", input: { file_path: "src/adapters/format.ts" } },
          ],
        },
      },
      {
        type: "user",
        parent_tool_use_id: "task-1",
        message: { content: [{ type: "tool_result", tool_use_id: "read-1", content: "file contents" }] },
      },
      {
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: "task-1", is_error: true, content: "Child timed out" }],
        },
      },
    ]);

    expect(events[0]).toMatchObject({
      kind: "subagent",
      id: "task-1",
      parentId: null,
      phase: "started",
      status: "running",
      title: "Trace event flow",
      agentType: "explorer",
      effort: "medium",
    });
    expect(events[1]).toMatchObject({ kind: "text", parentId: "task-1", text: "Reading the formatter." });
    expect(events[2]).toMatchObject({
      kind: "tool",
      id: "read-1",
      parentId: "task-1",
      phase: "started",
      name: "Read",
    });
    expect(events[3]).toMatchObject({ kind: "tool", id: "read-1", parentId: "task-1", phase: "completed" });
    expect(events[4]).toMatchObject({
      kind: "subagent",
      id: "task-1",
      phase: "completed",
      status: "failed",
      error: "Child timed out",
    });
  });

  test("Claude does not claim a background child finished when only Task returned", () => {
    const events = render(BUILTIN_ADAPTERS.claude!, [
      {
        type: "assistant",
        message: {
          content: [{
            type: "tool_use",
            id: "task-bg",
            name: "Task",
            input: { description: "Background review", prompt: "Review", run_in_background: true },
          }],
        },
      },
      {
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "task-bg", content: "Agent launched" }] },
      },
    ]);
    expect(events[1]).toMatchObject({
      kind: "subagent",
      id: "task-bg",
      phase: "updated",
      status: "running",
      result: null,
      background: true,
    });
  });

  test("Droid correlates background IDs, monitoring calls, and completion notifications", () => {
    const events = render(BUILTIN_ADAPTERS.droid!, [
      {
        type: "tool_call",
        id: "call-1",
        toolName: "Task",
        parameters: { subagent_type: "worker", description: "Run tests", prompt: "Test it", await: false },
      },
      {
        type: "tool_result",
        toolId: "call-1",
        value: "task_id: bg-1\nsession_id: session-1\ntype: worker\ndescription: Run tests",
      },
      { type: "tool_call", id: "watch-1", toolName: "TaskOutput", parameters: { task_id: "bg-1", block: false } },
      { type: "tool_result", toolId: "watch-1", value: "Status: running\nLatest: typechecking" },
      {
        type: "message",
        role: "user",
        text: "Background task completed.\ntask_id: bg-1\ntype: worker\nreason: completed\ndescription: Run tests\noutput: 42 tests passed",
      },
    ]);

    expect(events[0]).toMatchObject({ kind: "subagent", id: "call-1", status: "running", background: true });
    expect(events[1]).toMatchObject({
      kind: "subagent",
      id: "call-1",
      agentId: "bg-1",
      phase: "updated",
      status: "running",
    });
    expect(events[2]).toMatchObject({ kind: "tool", id: "watch-1", parentId: "bg-1", name: "TaskOutput" });
    expect(events[3]).toMatchObject({ kind: "tool", id: "watch-1", parentId: "bg-1", phase: "completed" });
    expect(events[4]).toMatchObject({
      kind: "subagent",
      id: "bg-1",
      agentId: "bg-1",
      phase: "completed",
      status: "completed",
      result: "42 tests passed",
    });
  });

  test("Codex keeps the spawn call running until the receiver thread settles", () => {
    const events = render(BUILTIN_ADAPTERS.codex!, [
      {
        type: "item.started",
        item: { type: "collab_tool_call", id: "spawn-1", tool: "spawn_agent", status: "in_progress", prompt: "Review" },
      },
      {
        type: "item.completed",
        item: {
          type: "collab_tool_call",
          id: "spawn-1",
          tool: "spawn_agent",
          status: "completed",
          receiver_thread_ids: ["thread-1"],
          prompt: "Review",
        },
      },
      {
        type: "item.completed",
        item: {
          type: "collab_tool_call",
          id: "wait-1",
          tool: "wait",
          status: "completed",
          agents_states: { "thread-1": { status: "completed", message: "No findings" } },
        },
      },
    ]);

    expect(events[0]).toMatchObject({ kind: "subagent", id: "spawn-1", status: "running" });
    expect(events[1]).toMatchObject({
      kind: "subagent",
      id: "spawn-1",
      agentId: "thread-1",
      phase: "updated",
      status: "running",
    });
    expect(events[2]).toMatchObject({
      kind: "subagent",
      id: "thread-1",
      phase: "completed",
      status: "completed",
      result: "No findings",
    });
  });

  test("Cursor reports taskToolCall failures", () => {
    const failed = render(BUILTIN_ADAPTERS.cursor!, [
      {
        type: "tool_call",
        subtype: "completed",
        call_id: "cursor-task-2",
        tool_call: { taskToolCall: { result: { error: { error: "Agent unavailable" } } } },
      },
    ]);
    expect(failed[0]).toMatchObject({ kind: "subagent", status: "failed", error: "Agent unavailable" });
  });

  test("unknown adapters degrade to human prose instead of raw JSON", () => {
    const def: AdapterDef = {
      bin: "custom",
      exec: [],
      parse: { format: "json" },
      events: "droid-stream-json",
    };
    expect(render(def, [{ type: "message", role: "assistant", text: "Still useful" }])).toEqual([
      { kind: "text", id: "text-1", parentId: null, text: "Still useful" },
    ]);

    const unstructured: AdapterDef = { bin: "custom", exec: [], parse: { format: "json" } };
    const format = createActivityFormatter(unstructured);
    expect(format(`{"private":"wire payload"}`)).toEqual([]);
    expect(format("plain harness output")).toEqual([
      { kind: "text", id: "text-1", parentId: null, text: "plain harness output" },
    ]);

    const optedOut = { ...BUILTIN_ADAPTERS.droid!, activity: null };
    expect(render(optedOut, [{ type: "message", role: "assistant", text: "Human fallback" }])).toEqual([
      { kind: "text", id: "text-1", parentId: null, text: "Human fallback" },
    ]);
    const duplicateReasoning = { type: "reasoning", id: "reason-1", text: "One thought", timestamp: 123 };
    expect(render(optedOut, [duplicateReasoning, duplicateReasoning])).toEqual([
      { kind: "text", id: "text-1", parentId: null, text: "~ One thought" },
    ]);
  });

  test("a steered message becomes a canonical event where the harness accepted it", () => {
    const format = createActivityFormatter(BUILTIN_ADAPTERS.claude!);
    const before = format(
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Reading the config" }] } }),
    );
    const steer = format(formatSteerNote("mfaketestid01", "Use the safer approach\nand keep the tests green"));
    const after = format(
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Switching approach" }] } }),
    );

    expect(before).toEqual([expect.objectContaining({ kind: "text", text: "Reading the config" })]);
    expect(steer).toEqual([
      {
        kind: "message",
        id: "mfaketestid01",
        parentId: null,
        text: "Use the safer approach and keep the tests green",
      },
    ]);
    expect(after).toEqual([expect.objectContaining({ kind: "text", text: "Switching approach" })]);
  });

  test("only Wisp's own marker becomes a message; other notes stay prose", () => {
    const format = createActivityFormatter(BUILTIN_ADAPTERS.claude!);
    expect(format("· attached: diagram.png (320 B)")).toEqual([
      { kind: "text", id: "text-1", parentId: null, text: "· attached: diagram.png (320 B)" },
    ]);
    expect(format("· steer without an id")).toEqual([
      { kind: "text", id: "text-2", parentId: null, text: "· steer without an id" },
    ]);
  });

  test("bounds large tool inputs before they reach the browser", () => {
    const [event] = render(BUILTIN_ADAPTERS.droid!, [{
      type: "tool_call",
      id: "large",
      toolName: "Execute",
      parameters: { command: "x".repeat(10_000) },
    }]);
    expect(event).toMatchObject({ kind: "tool", id: "large" });
    if (event?.kind !== "tool") throw new Error("expected tool");
    expect((event.input as { command: string }).command.length).toBeLessThan(2_100);
  });

  test("Claude builtin forwards nested child text", () => {
    expect(BUILTIN_ADAPTERS.claude!.exec).toContain("--forward-subagent-text");
  });
});
