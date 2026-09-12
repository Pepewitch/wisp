import { afterEach, describe, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILTIN_ADAPTERS, createActivityFormatter } from "../src/adapters";
import { DroidSubagentStream } from "../src/adapters/live/droid-subagents";

const homes: string[] = [];

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

function line(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

describe("Droid local subagent stream", () => {
  test("follows live child and nested-child transcript activity", async () => {
    const home = await mkdtemp(join(tmpdir(), "wisp-droid-subagents-"));
    homes.push(home);
    const sessions = join(home, "sessions", "-repo");
    await mkdir(sessions, { recursive: true });
    const parentPath = join(sessions, "parent.jsonl");
    const childPath = join(sessions, "child.jsonl");
    const grandchildPath = join(sessions, "grandchild.jsonl");
    await writeFile(parentPath, "");
    await writeFile(
      join(home, "task-invocations.json"),
      JSON.stringify({
        invocations: [
          {
            parentSessionId: "parent",
            parentToolUseId: "task-1",
            childSessionId: "child",
            parentTranscriptPath: parentPath,
          },
          {
            parentSessionId: "child",
            parentToolUseId: "task-2",
            childSessionId: "grandchild",
            parentTranscriptPath: childPath,
          },
        ],
      }),
    );
    await writeFile(
      childPath,
      [
        line({ type: "session_start", id: "child" }),
        line({
          type: "message",
          id: "context",
          timestamp: 1,
          message: { role: "user", content: [{ type: "text", text: "private assignment context" }] },
        }),
        line({
          type: "message",
          id: "assistant-1",
          timestamp: 2,
          message: {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "Inspecting the file" },
              { type: "tool_use", id: "read-1", name: "Read", input: { file_path: "package.json" } },
            ],
          },
        }),
        line({
          type: "message",
          id: "result-1",
          timestamp: 3,
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "read-1", content: "{\"name\":\"wisp\"}" }],
          },
        }),
        line({
          type: "message",
          id: "assistant-2",
          timestamp: 4,
          message: {
            role: "assistant",
            content: [{
              type: "tool_use",
              id: "task-2",
              name: "Task",
              input: { description: "Double-check name", subagent_type: "explorer", prompt: "Check it" },
            }],
          },
        }),
      ].join(""),
    );
    await writeFile(
      grandchildPath,
      line({
        type: "message",
        id: "assistant-3",
        timestamp: 5,
        message: { role: "assistant", content: [{ type: "text", text: "wisp" }] },
      }),
    );

    const events: Record<string, unknown>[] = [];
    const stream = new DroidSubagentStream({
      parentSessionId: "parent",
      factoryHome: home,
      pollMs: 60_000,
      emit: (event) => events.push(event),
    });
    stream.follow("task-1");
    await stream.poll();
    await stream.poll();

    expect(events).toEqual([
      expect.objectContaining({ type: "reasoning", id: "assistant-1", parent_tool_use_id: "task-1" }),
      expect.objectContaining({ type: "tool_call", id: "read-1", parent_tool_use_id: "task-1" }),
      expect.objectContaining({ type: "tool_result", id: "read-1", parent_tool_use_id: "task-1" }),
      expect.objectContaining({ type: "tool_call", id: "task-2", parent_tool_use_id: "task-1" }),
      expect.objectContaining({ type: "message", id: "assistant-3", parent_tool_use_id: "task-2" }),
    ]);
    expect(JSON.stringify(events)).not.toContain("private assignment context");

    await appendFile(
      childPath,
      line({
        type: "message",
        id: "assistant-4",
        timestamp: 6,
        message: { role: "assistant", content: [{ type: "text", text: "Live conclusion" }] },
      }),
    );
    await stream.poll();
    expect(events.filter((event) => event.id === "assistant-4")).toHaveLength(1);
    await stream.poll();
    expect(events.filter((event) => event.id === "assistant-4")).toHaveLength(1);

    const normalize = createActivityFormatter(BUILTIN_ADAPTERS.droid!);
    const activity = events.flatMap((event) => normalize(JSON.stringify(event)));
    expect(activity).toContainEqual(expect.objectContaining({
      kind: "tool",
      id: "read-1",
      parentId: "task-1",
      name: "Read",
    }));
    expect(activity).toContainEqual(expect.objectContaining({
      kind: "subagent",
      id: "task-2",
      parentId: "task-1",
      status: "running",
    }));
    expect(activity).toContainEqual(expect.objectContaining({
      kind: "text",
      id: "assistant-3",
      parentId: "task-2",
      text: "wisp",
    }));
    await stream.close();
  });

  test("rejects registry transcript paths outside Factory sessions", async () => {
    const home = await mkdtemp(join(tmpdir(), "wisp-droid-subagents-"));
    homes.push(home);
    await writeFile(
      join(home, "task-invocations.json"),
      JSON.stringify({
        invocations: [{
          parentSessionId: "parent",
          parentToolUseId: "task-1",
          childSessionId: "child",
          parentTranscriptPath: join(home, "..", "outside", "parent.jsonl"),
        }],
      }),
    );
    const events: Record<string, unknown>[] = [];
    const stream = new DroidSubagentStream({
      parentSessionId: "parent",
      factoryHome: home,
      pollMs: 60_000,
      emit: (event) => events.push(event),
    });
    stream.follow("task-1");
    await stream.poll();
    expect(events).toEqual([]);
    await stream.close();
  });
});
