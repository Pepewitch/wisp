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
      // The Agent call named no model; the child's first forwarded message did.
      const modelReports = events.filter((event) => event.kind === "subagent" && event.model);
      expect(modelReports[0]).toMatchObject({ id: "call-claude-subagent", phase: "updated", status: "running", model: "claude-sonnet-5" });
      expect(modelReports.at(-1)).toMatchObject({ id: "call-claude-subagent", phase: "completed", model: "claude-sonnet-5" });
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

// The app-server driver (src/adapters/live/codex.ts) speaks a second Codex
// dialect; these pin that its subagent markers land in the same lifecycle.
describe("Codex app-server subagent dialect", () => {
  test("Codex app-server marks a child thread with subagent_activity items, never a raw tool", () => {
    const events = renderFixture(BUILTIN_ADAPTERS.codex!, "codex-live-subagent.jsonl");
    // The regression: an unknown item type fell into the generic tool
    // fallback and painted the wire JSON as a tool call.
    expect(events.filter((event) => event.kind === "tool")).toEqual([]);
    expect(events[0]).toMatchObject({
      kind: "subagent",
      id: "call-codex-live-spawn",
      agentId: "agent-codex-live",
      phase: "started",
      status: "running",
      title: "review_plan",
      background: true,
    });
    expect(events.at(-1)).toMatchObject({
      kind: "subagent",
      id: "agent-codex-live",
      agentId: "agent-codex-live",
      phase: "completed",
      status: "completed",
    });
  });

  test("Codex app-server nests a spawned child's work under one card and settles it from its own turn", () => {
    const events = renderFixture(BUILTIN_ADAPTERS.codex!, "codex-live-nested-subagent.jsonl");
    const cards = events.filter((event) => event.kind === "subagent");
    // One card: the spawn call opens it, and the child's thread id is an alias, not a second card.
    expect(cards.filter((event) => event.phase === "started")).toEqual([
      expect.objectContaining({ id: "call-spawn", status: "running" }),
    ]);
    expect(cards).toContainEqual(expect.objectContaining({
      id: "call-spawn",
      agentId: "agent-codex-live",
      title: "Read package.json in the workspace and reply with only its name field.",
      model: "gpt-5.6-luna",
      effort: "low",
      prompt: "Read package.json in the workspace and reply with only its name field.",
    }));
    // The child's command and final message live under the child, not the parent.
    expect(events).toContainEqual(expect.objectContaining({ kind: "tool", id: "exec-1", parentId: "agent-codex-live", name: "Run" }));
    expect(events).toContainEqual(expect.objectContaining({ kind: "text", parentId: "agent-codex-live", text: "papaya-verify" }));
    expect(events.filter((event) => event.kind === "text" && event.parentId === null).map((event) => event.text)).toEqual([
      "I’m spawning the single requested subagent now and will wait for its exact reply.",
      "child said: papaya-verify",
    ]);
    // The child's own turn/completed carries the outcome and duration.
    expect(events).toContainEqual(expect.objectContaining({
      kind: "subagent",
      id: "agent-codex-live",
      phase: "completed",
      status: "completed",
      result: "papaya-verify",
      durationMs: 7356,
    }));
  });

  test("Codex subagent_activity kinds map onto the lifecycle through the thread id", () => {
    const marker = (id: string, kind: string) => ({
      type: "item.completed",
      item: { type: "subagent_activity", id, kind, agent_thread_id: "thread-1", agent_path: "/root/worker" },
    });
    const events = render(BUILTIN_ADAPTERS.codex!, [
      marker("call-1", "started"),
      marker("marker-2", "interacted"),
      marker("marker-3", "interrupted"),
    ]);
    expect(events).toEqual([
      expect.objectContaining({ kind: "subagent", id: "call-1", agentId: "thread-1", phase: "updated", status: "running", title: "worker" }),
      expect.objectContaining({ kind: "subagent", id: "thread-1", agentId: "thread-1", phase: "updated", status: "running" }),
      expect.objectContaining({ kind: "subagent", id: "thread-1", agentId: "thread-1", phase: "completed", status: "stopped" }),
    ]);
  });

  test("Codex child-thread items nest under the child's card, even when they outrun the spawn marker", () => {
    const events = render(BUILTIN_ADAPTERS.codex!, [
      { type: "thread.started", thread_id: "root" },
      { type: "item.completed", thread_id: "root", item: { id: "msg-1", type: "agent_message", text: "Delegating." } },
      // The child's first command lands before the parent's marker does.
      { type: "item.started", thread_id: "child", item: { id: "exec-1", type: "command_execution", command: "ls" } },
      {
        type: "item.completed",
        thread_id: "root",
        item: { id: "call-1", type: "subagent_activity", kind: "started", agent_thread_id: "child", agent_path: "/root/reviewer" },
      },
      { type: "thread.child", thread_id: "child", parent_thread_id: "root", model: "gpt-test", reasoning_effort: "high", agent_role: "reviewer", agent_nickname: "quiet-otter" },
      { type: "item.completed", thread_id: "child", item: { id: "msg-2", type: "agent_message", text: "No findings." } },
      { type: "subagent.completed", thread_id: "child", status: "failed", error: "context window exceeded", result: null, duration_ms: 4200 },
      // The trailing marker must not repaint the failed card as completed.
      {
        type: "item.completed",
        thread_id: "child",
        item: { id: "subagent-completed-1", type: "subagent_activity", kind: "completed", agent_thread_id: "child", agent_path: "/root/reviewer" },
      },
    ]);
    expect(events).toEqual([
      expect.objectContaining({ kind: "text", parentId: null, text: "Delegating." }),
      expect.objectContaining({ kind: "subagent", id: "child", agentId: "child", phase: "started", status: "running" }),
      expect.objectContaining({ kind: "tool", id: "exec-1", parentId: "child", name: "Run" }),
      expect.objectContaining({ kind: "subagent", id: "call-1", agentId: "child", parentId: null, title: "reviewer", status: "running" }),
      expect.objectContaining({ kind: "subagent", id: "child", phase: "updated", model: "gpt-test", effort: "high", agentType: "reviewer" }),
      expect.objectContaining({ kind: "text", parentId: "child", text: "No findings." }),
      expect.objectContaining({ kind: "subagent", id: "child", phase: "completed", status: "failed", error: "context window exceeded", durationMs: 4200 }),
    ]);
  });

  test("Codex exec --json events carry no thread scope and stay at the top level", () => {
    const events = render(BUILTIN_ADAPTERS.codex!, [
      { type: "thread.started", thread_id: "root" },
      { type: "item.completed", item: { id: "exec-1", type: "command_execution", command: "ls", exit_code: 0, aggregated_output: "" } },
    ]);
    expect(events).toEqual([expect.objectContaining({ kind: "tool", id: "exec-1", parentId: null })]);
  });

  test("Codex app-server collab calls speak camelCase and still drive the subagent lifecycle", () => {
    const events = render(BUILTIN_ADAPTERS.codex!, [
      {
        type: "item.started",
        item: { type: "collab_tool_call", id: "spawn-1", tool: "spawnAgent", status: "inProgress", prompt: "Review", model: "gpt-test", reasoning_effort: "high", receiver_thread_ids: [], agents_states: {} },
      },
      {
        type: "item.completed",
        item: {
          type: "collab_tool_call",
          id: "spawn-1",
          tool: "spawnAgent",
          status: "completed",
          prompt: "Review",
          model: "gpt-test",
          reasoning_effort: "high",
          receiver_thread_ids: ["thread-1"],
          agents_states: { "thread-1": { status: "pendingInit", message: null } },
        },
      },
      {
        type: "item.completed",
        item: {
          type: "collab_tool_call",
          id: "close-1",
          tool: "closeAgent",
          status: "completed",
          receiver_thread_ids: ["thread-1"],
          agents_states: { "thread-1": { status: "shutdown", message: null } },
        },
      },
    ]);
    expect(events[0]).toMatchObject({ kind: "subagent", id: "spawn-1", status: "running", model: "gpt-test", effort: "high" });
    expect(events[1]).toMatchObject({ kind: "subagent", id: "spawn-1", agentId: "thread-1", phase: "updated", status: "running" });
    expect(events[2]).toMatchObject({ kind: "subagent", id: "thread-1", phase: "completed", status: "stopped" });
  });
  // opencode 1.18.29, from real captured turns. Its structured projection is
  // deliberately narrower than the others': tools are only ever reported
  // COMPLETED (the CLI emits no started event), and the delegating `task` tool
  // renders as a plain tool row until a real `task` transcript is captured.
  describe("opencode", () => {
    const opencode = BUILTIN_ADAPTERS.opencode!;

    test("a captured tool turn yields completed tool rows keyed by the harness's call ids", () => {
      const events = renderFixture(opencode, "opencode-tool-turn.jsonl");
      expect(events.map((e) => e.kind)).toEqual(["tool", "tool", "text"]);
      expect(events[0]).toMatchObject({
        kind: "tool",
        id: "call_fixture0001",
        parentId: null,
        phase: "completed",
        name: "read",
        input: { filePath: "/work/repo/a.txt" },
        error: null,
      });
      expect(events[1]).toMatchObject({ kind: "tool", id: "call_fixture0002", name: "write", phase: "completed" });
      expect(events[2]).toMatchObject({ kind: "text", id: "prt_fixture0008", text: "`a.txt` said: `hello`" });
    });

    test("reasoning becomes a thinking row, and step events contribute nothing", () => {
      const events = renderFixture(opencode, "opencode-thinking-turn.jsonl");
      expect(events.map((e) => e.kind)).toEqual(["thinking", "text"]);
      expect(events[0]).toMatchObject({
        kind: "thinking",
        id: "prt_fixture0002",
        text: "**Calculating the Answer**\n\nI broke 17 * 23 into 17 * 20 and 17 * 3, then summed.",
      });
    });

    test("a failed tool reports the error and withholds the output", () => {
      const events = render(opencode, [
        {
          type: "tool_use",
          sessionID: "ses_1",
          part: {
            type: "tool",
            tool: "bash",
            callID: "c1",
            state: { status: "error", input: { command: "false" }, error: "exit status 1" },
          },
        },
      ]);
      expect(events[0]).toMatchObject({ kind: "tool", name: "bash", phase: "completed", output: null, error: "exit status 1" });
    });

    test("a stream error surfaces as text rather than vanishing from the conversation", () => {
      const events = renderFixture(opencode, "opencode-unknown-model.jsonl");
      expect(events).toHaveLength(1);
      expect(events[0]!.kind).toBe("text");
      expect((events[0] as { text: string }).text).toStartWith(
        "Error: This model models/gemini-2.5-flash is no longer available",
      );
    });
  });
});
