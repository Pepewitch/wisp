import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import type { AdapterDef } from "../src/adapters";
import type { WispConfig } from "../src/config";
import { activeLiveInput } from "../src/live-input";
import { conversationDetail } from "../src/routes/task-conversation";
import { hasRunningTurn, interruptTurn, startTurn } from "../src/runner";
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

function makeTask() {
  const task = createTask({
    id: newTaskId(),
    title: "droid askuser test",
    repo_path: "/tmp/repo",
    harness: "fake",
    model: null,
    slot: freeSlot(),
  });
  setTaskFields(task.id, { worktree_path: mkdtempSync(join(tmpdir(), "wisp-droid-askuser-wt-")) });
  return getTask(task.id)!;
}

async function until(pred: () => boolean, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await Bun.sleep(50);
  }
}

describe("Droid live AskUser and interrupt", () => {
  test("AskUser suspends the turn, and answering it in-protocol resumes the same turn", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wisp-droid-askuser-"));
    const answerPath = join(dir, "answers.json");
    const harnessPath = join(dir, "fake-droid");
    writeFileSync(
      harnessPath,
      `#!/usr/bin/env bun
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
const frame = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const notify = (notification) => frame({
  jsonrpc: "2.0",
  type: "notification",
  method: "droid.session_notification",
  params: { notification },
});
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  const request = JSON.parse(line);
  if (request.method === "droid.initialize_session") {
    frame({ jsonrpc: "2.0", id: request.id, result: { sessionId: "droid-ask-session" } });
  } else if (request.method === "droid.add_user_message") {
    frame({ jsonrpc: "2.0", id: request.id, result: {} });
    notify({ type: "create_message", message: {
      id: "assistant-1",
      role: "assistant",
      content: [
        { type: "text", text: "WHICH_OPTION" },
        { type: "tool_use", id: "ask-1", name: "AskUser", input: { questionnaire: "1. [question] Where to?\\n[option] Japan\\n[option] Italy" } },
      ],
      createdAt: 123,
    } });
    // The structured half: Droid now BLOCKS until this is answered.
    frame({
      jsonrpc: "2.0",
      type: "request",
      id: "ask-request-1",
      method: "droid.ask_user",
      params: { toolCallId: "ask-1", questions: [
        { index: 1, topic: "Travel", question: "Where to?", options: ["Japan", "Italy"] },
      ] },
    });
  } else if (request.type === "response") {
    writeFileSync(${JSON.stringify(answerPath)}, JSON.stringify(request));
    notify({ type: "create_message", message: {
      id: "assistant-2",
      role: "assistant",
      content: [{ type: "text", text: "BOOKED_JAPAN" }],
      createdAt: 456,
    } });
    notify({ type: "agent_turn_completed", reason: "completed" });
  }
}
`,
    );
    chmodSync(harnessPath, 0o755);
    const def: AdapterDef = {
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
    const task = makeTask();
    startTurn(task, "ask me", def, cfg);
    await until(() => getTask(task.id)?.state === "needs-input");

    // The turn is SUSPENDED, not finished: the harness is waiting on us.
    expect(turnsFor(task.id)[0]?.status).toBe("running");
    const live = activeLiveInput(task.id)!;
    expect(live.question?.()).toMatchObject({
      id: "ask-1",
      questions: [{ index: 1, topic: "Travel", question: "Where to?", multiSelect: false, options: ["Japan", "Italy"] }],
    });

    // The conversation names the ONE question that can still be answered, so
    // the UI never offers a form for a question nothing is waiting on.
    expect(conversationDetail(getTask(task.id)!, {}).pending_question_id).toBe("ask-1");

    await live.answer!("ask-1", [{ index: 1, answer: "Japan" }]);
    await until(() => getTask(task.id)?.state === "done");

    // The harness got a well-formed reply on its own frame id...
    expect(JSON.parse(readFileSync(answerPath, "utf8"))).toMatchObject({
      type: "response",
      id: "ask-request-1",
      result: { answers: [{ index: 1, question: "Where to?", answer: "Japan" }] },
    });
    expect(conversationDetail(getTask(task.id)!, {}).pending_question_id).toBeNull();
    // ...and the SAME turn carried on to its conclusion — no second turn.
    expect(turnsFor(task.id)).toHaveLength(1);
    expect(turnsFor(task.id)[0]).toMatchObject({ n: 1, status: "done", result: "BOOKED_JAPAN" });
  });

  test("interrupt closes live stdin before SIGTERM so a TERM-trapping harness can exit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wisp-droid-interrupt-stdin-"));
    const markPath = join(dir, "order.txt");
    const harnessPath = join(dir, "fake-droid");
    writeFileSync(
      harnessPath,
      `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const mark = ${JSON.stringify(markPath)};
const frame = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
process.on("SIGTERM", () => appendFileSync(mark, "term\\n"));
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  const request = JSON.parse(line);
  if (request.method === "droid.initialize_session") {
    frame({ jsonrpc: "2.0", id: request.id, result: { sessionId: "droid-interrupt-session" } });
  } else if (request.method === "droid.add_user_message") {
    frame({ jsonrpc: "2.0", id: request.id, result: {} });
  }
}
appendFileSync(mark, "stdin\\n");
`,
    );
    chmodSync(harnessPath, 0o755);
    const def: AdapterDef = {
      bin: harnessPath,
      exec: [],
      liveInput: "droid-jsonrpc",
      parse: { format: "json", resultType: "completion", result: "finalText", session: "session_id" },
      attach: null,
    };
    const task = makeTask();
    startTurn(task, "hang", def, cfg);
    await until(() => hasRunningTurn(task.id) !== null);
    await until(() => {
      try {
        return readFileSync(turnsFor(task.id)[0]!.log_file, "utf8").includes('"subtype":"init"');
      } catch {
        return false;
      }
    });

    await interruptTurn(task.id, 500);

    expect(hasRunningTurn(task.id)).toBeNull();
    expect(turnsFor(task.id)[0]!.status).toBe("interrupted");
    expect(getTask(task.id)?.state_detail).toBe("turn interrupted — session kept, send a message to continue");
    expect(readFileSync(markPath, "utf8")).toContain("stdin");
  });
});
