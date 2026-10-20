import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import type { AdapterDef } from "../src/adapters";
import type { WispConfig } from "../src/config";
import { startTurn } from "../src/runner";
import { createTask, freeSlot, getTask, newTaskId, setTaskFields, turnsFor } from "../src/store";

const cfg: WispConfig = {
  instanceId: "123e4567-e89b-42d3-a456-426614174000",
  port: 0,
  host: "127.0.0.1",
  token: "test",
  webhooks: [],
  repos: [],
  stuckMinutes: 10,
  logMaxBytes: 5_000_000,
  setupTimeoutMinutes: 10,
  envAllowlist: {},
  harnessDefaults: {},
};

const FIXTURE = join(import.meta.dir, "fixtures", "droid-plan-acknowledgement.jsonl");

function makeTask() {
  const task = createTask({
    id: newTaskId(),
    title: "droid final text test",
    repo_path: "/tmp/repo",
    harness: "fake",
    model: null,
    slot: freeSlot(),
  });
  setTaskFields(task.id, { worktree_path: mkdtempSync(join(tmpdir(), "wisp-droid-final-text-wt-")) });
  return getTask(task.id)!;
}

async function until(pred: () => boolean, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await Bun.sleep(50);
  }
}

/** A Droid stand-in that answers the turn's message by replaying a recorded stream. */
function replayingDroid(dir: string, stream: string): AdapterDef {
  const harnessPath = join(dir, "fake-droid");
  writeFileSync(
    harnessPath,
    `#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
const frame = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
const request = JSON.parse(line);
if (request.method === "droid.initialize_session") {
  frame({ jsonrpc: "2.0", id: request.id, result: { sessionId: "droid-replay-session" } });
} else if (request.method === "droid.add_user_message") {
  frame({ jsonrpc: "2.0", id: request.id, result: {} });
  process.stdout.write(readFileSync(${JSON.stringify(stream)}, "utf8"));
}
}
`,
  );
  chmodSync(harnessPath, 0o755);
  return {
    bin: harnessPath,
    exec: [],
    liveInput: "droid-jsonrpc",
    activity: "droid-stream-json",
    parse: {
      format: "json",
      resultType: "completion",
      result: "finalText",
      session: "session_id",
      needsInput: "needs_input",
    },
    attach: null,
  };
}

function recordedMessages(): string[] {
  return readFileSync(FIXTURE, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line).params.notification)
    .filter((notification) => notification.type === "create_message")
    .flatMap((notification) => notification.message.content)
    .filter((block) => block.type === "text")
    .map((block) => block.text as string);
}

describe("Droid turn result", () => {
  test("an acknowledgement after TodoWrite does not replace the answer, and stays in the transcript", async () => {
    const [answer, acknowledgement] = recordedMessages();
    expect(acknowledgement).toBe("Plan is up-to-date.");
    const dir = mkdtempSync(join(tmpdir(), "wisp-droid-final-text-"));
    const task = makeTask();
    startTurn(task, "why does the parser drop a field?", replayingDroid(dir, FIXTURE), cfg);
    await until(() => turnsFor(task.id)[0]?.status === "done");

    expect(turnsFor(task.id)[0]).toMatchObject({ n: 1, status: "done", result: answer });
    expect(getTask(task.id)?.session_id).toBe("droid-replay-session");

    const logged = readFileSync(turnsFor(task.id)[0]!.log_file, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, any>);
    expect(logged.filter((event) => event.type === "message").map((event) => event.text)).toEqual([
      answer,
      acknowledgement,
    ]);
    expect(logged.find((event) => event.type === "tool_call")).toMatchObject({ toolName: "TodoWrite" });
    expect(logged.find((event) => event.type === "tool_result")).toMatchObject({ value: "TODO List Updated" });
    expect(logged.find((event) => event.type === "completion")).toMatchObject({ finalText: answer, isError: false });
  });
});
