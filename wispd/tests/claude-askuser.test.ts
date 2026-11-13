// Claude's AskUserQuestion on a live turn: Claude sends a `can_use_tool`
// permission prompt on stdout and blocks until Wisp answers it on stdin
// (adapters/live/claude-questions.ts). The fixtures are real claude-code
// 2.1.322 captures, trimmed to the frames that matter.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { BUILTIN_ADAPTERS, createActivityFormatter, type ActivityEvent, type AdapterDef } from "../src/adapters";
import { ClaudeQuestions } from "../src/adapters/live/claude-questions";
import { parseOutput } from "../src/adapters/parse";
import type { WispConfig } from "../src/config";
import { activeLiveInput } from "../src/live-input";
import { processGroupAlive, signalProcessGroup } from "../src/process-tree";
import { conversationDetail } from "../src/routes/task-conversation";
import { interruptTurn, startTurn, submitTaskMessage } from "../src/runner";
import { createTask, freeSlot, getTask, newTaskId, setTaskFields, turnsFor } from "../src/store";
import { fixture } from "./fixtures";

const claude = BUILTIN_ADAPTERS.claude!;

function frames(name: string): Record<string, any>[] {
  return fixture(name).split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, any>);
}

function render(events: Record<string, unknown>[]): ActivityEvent[] {
  const format = createActivityFormatter(claude);
  return events.flatMap((event) => format(JSON.stringify(event)));
}

const answered = frames("claude-askuser-answered.jsonl");
const prompt = answered.find((frame) => frame.type === "control_request")!;
const askCall = answered.find((frame) => frame.type === "assistant")!;
const askId: string = prompt.request.tool_use_id;

describe("Claude question captures", () => {
  test("an answered question renders as one card that settles with the answer", () => {
    const events = render(answered).filter((event) => event.kind === "question");
    expect(events.map((event) => event.phase)).toEqual(["asked", "answered"]);
    expect(events[0]).toMatchObject({ id: askId, questions: [{ index: 1, topic: "Color", question: "Which color?", options: ["Red", "Blue"] }] });
    expect(events[1]).toMatchObject({ id: askId, answers: [{ index: 1, answer: "Blue" }] });
    // the permission prompt itself is protocol, not a row
    expect(render(answered).filter((event) => event.kind === "tool")).toEqual([]);
  });

  test("a question Wisp released does not leave the turn waiting on the person", () => {
    const denied = fixture("claude-askuser-denied.jsonl");
    expect(denied).toContain('"permission_denials":[{"tool_name":"AskUserQuestion"');
    expect(parseOutput(claude, denied).needsInput).toBe(false);
  });

  test("a Bash denial in the same result still holds the turn", () => {
    const result = { type: "result", result: "May I?", session_id: "s", permission_denials: [{ tool_name: "AskUserQuestion" }, { tool_name: "Bash" }] };
    expect(parseOutput(claude, JSON.stringify(result)).needsInput).toBe(true);
  });

  test("answers map back by Claude's full question text, not the card's truncated copy", () => {
    const long = `${"Which ".repeat(200)}color?`;
    const input = { questions: [{ question: long, header: "Color", multiSelect: false, options: [{ label: "Red", description: "" }, { label: "Blue", description: "" }] }] };
    const events = render([
      { type: "assistant", message: { content: [{ type: "tool_use", id: "ask-long", name: "AskUserQuestion", input }] } },
      {
        type: "user",
        tool_use_result: { ...input, answers: { [long]: "Red" } },
        message: { content: [{ type: "tool_result", tool_use_id: "ask-long", content: "answered" }] },
      },
    ]);
    expect(events[1]).toMatchObject({ phase: "answered", answers: [{ index: 1, answer: "Red" }] });
  });

  test("the driver's own settle event carries why the card closed", () => {
    const events = render([askCall, { type: "question", id: askId, phase: "cancelled", reason: "superseded" }]);
    expect(events[1]).toMatchObject({ kind: "question", id: askId, phase: "cancelled", reason: "superseded" });
  });
});

describe("ClaudeQuestions", () => {
  function harness() {
    const written: Record<string, any>[] = [];
    const emitted: Record<string, any>[] = [];
    const waiting: boolean[] = [];
    const settled: [string, string][] = [];
    const questions = new ClaudeQuestions({
      write: async (frame) => { written.push(frame); },
      emit: (event) => emitted.push(event),
      onWaiting: (value) => waiting.push(value),
      onSettled: (id, phase) => settled.push([id, phase]),
    });
    return { questions, written, emitted, waiting, settled };
  }

  test("holds a question, then answers it keyed by question text", async () => {
    const h = harness();
    expect(h.questions.handle(prompt)).toBe(true);
    expect(h.waiting).toEqual([true]);
    expect(h.questions.question()).toMatchObject({ id: askId });
    expect(h.written).toEqual([]);

    await expect(h.questions.answer(askId, [])).rejects.toThrow("answer every question first (1 still empty)");
    await h.questions.answer(askId, [{ index: 1, answer: "Blue" }]);
    expect(h.written).toEqual([{
      type: "control_response",
      response: {
        subtype: "success",
        request_id: prompt.request_id,
        response: { behavior: "allow", updatedInput: { ...prompt.request.input, answers: { "Which color?": "Blue" } } },
      },
    }]);
    expect(h.waiting).toEqual([true, false]);
    expect(h.settled).toEqual([[askId, "answered"]]);
    expect(h.emitted.map((event) => event.phase)).toEqual(["asked", "answered"]);
    expect(h.emitted[0]).toMatchObject({ type: "question", id: askId, questions: [{ index: 1, question: "Which color?" }] });
    expect(h.emitted[1]).toMatchObject({ type: "question", id: askId, phase: "answered", answers: [{ index: 1, answer: "Blue" }] });
    expect(h.questions.question()).toBeNull();
    await expect(h.questions.answer(askId, [{ index: 1, answer: "Red" }])).rejects.toThrow("no longer waiting");
  });

  test("a message sent instead releases the question with a pointer to it", async () => {
    const h = harness();
    h.questions.handle(prompt);
    await h.questions.deferToMessage();
    expect(h.written[0]!.response.response).toMatchObject({ behavior: "deny" });
    expect(h.written[0]!.response.response.message).toContain("message");
    expect(h.settled).toEqual([[askId, "answered"]]);
    expect(h.emitted[1]).toMatchObject({ phase: "cancelled", reason: "superseded" });
  });

  test("Stop releases the question and leaves the task state to the stop", async () => {
    const h = harness();
    h.questions.handle(prompt);
    await h.questions.stop();
    expect(h.written[0]!.response.response).toMatchObject({ behavior: "deny" });
    expect(h.waiting).toEqual([true]);
    expect(h.settled).toEqual([[askId, "cancelled"]]);
    expect(h.emitted[1]).toMatchObject({ phase: "cancelled", reason: "stopped" });
  });

  test("any other permission prompt is allowed as asked, at once", () => {
    const h = harness();
    const bash = { type: "control_request", request_id: "r-bash", request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "ls" }, tool_use_id: "t-bash" } };
    expect(h.questions.handle(bash)).toBe(true);
    expect(h.written).toEqual([{
      type: "control_response",
      response: { subtype: "success", request_id: "r-bash", response: { behavior: "allow", updatedInput: { command: "ls" } } },
    }]);
    expect(h.waiting).toEqual([]);
  });

  test("Claude withdrawing the prompt settles the card", () => {
    const h = harness();
    h.questions.handle(prompt);
    expect(h.questions.handle({ type: "control_cancel_request", request_id: prompt.request_id })).toBe(true);
    expect(h.questions.question()).toBeNull();
    expect(h.settled).toEqual([[askId, "cancelled"]]);
  });

  test("ordinary stream events are not its business", () => {
    const h = harness();
    expect(h.questions.handle(askCall)).toBe(false);
    expect(h.questions.handle({ type: "control_request", request_id: "x", request: { subtype: "interrupt" } })).toBe(false);
  });
});

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

const started: string[] = [];

afterEach(() => {
  for (const taskId of started.splice(0)) {
    for (const turn of turnsFor(taskId)) if (turn.pid && processGroupAlive(turn.pid)) signalProcessGroup(turn.pid, "SIGKILL");
  }
});

function makeTask() {
  const task = createTask({ id: newTaskId(), title: "claude question test", repo_path: "/tmp/repo", harness: "fake", model: null, slot: freeSlot() });
  setTaskFields(task.id, { worktree_path: mkdtempSync(join(tmpdir(), "wisp-askuser-")) });
  started.push(task.id);
  return getTask(task.id)!;
}

async function until(pred: () => boolean, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await Bun.sleep(50);
  }
}

/** One stream-json frame, as the fake harness prints it. */
function emit(frame: Record<string, unknown>): string {
  return `printf '%s\\n' '${JSON.stringify(frame)}'`;
}

/** A fake Claude that asks the captured question, then saves what Wisp wrote back. */
function askingClaude(after: string[]): AdapterDef {
  return {
    bin: "bash",
    exec: ["-c", [
      "IFS= read -r first",
      emit({ type: "system", subtype: "init", session_id: "session-ask" }),
      emit(askCall),
      emit(prompt),
      'IFS= read -r reply && printf "%s\\n" "$reply" > reply.json',
      ...after,
    ].join("; ")],
    liveInput: "claude-stream-json",
    parse: { format: "json", resultType: "result", result: "result", session: "session_id", needsInput: "permission_denials" },
    attach: null,
  };
}

const reply = (taskId: string) => JSON.parse(readFileSync(join(getTask(taskId)!.worktree_path!, "reply.json"), "utf8"));

describe("a live Claude turn asking a question", () => {
  test("waits in needs-input, takes the card's answer on stdin, and finishes", async () => {
    const def = askingClaude([
      emit({ type: "user", tool_use_result: { answers: { "Which color?": "Blue" } }, message: { content: [{ type: "tool_result", tool_use_id: askId, content: "answered" }] } }),
      emit({ type: "result", result: "You chose Blue.", session_id: "session-ask", permission_denials: [] }),
      "IFS= read -r unexpected && exit 9",
      "exit 0",
    ]);
    const task = makeTask();
    startTurn(task, "ask me", def, cfg);
    await until(() => getTask(task.id)!.state === "needs-input");

    expect(turnsFor(task.id)[0]!.status).toBe("running");
    expect(conversationDetail(getTask(task.id)!, { fake: def }).pending_question_id).toBe(askId);
    await activeLiveInput(task.id)!.answer!(askId, [{ index: 1, answer: "Blue" }]);
    expect(getTask(task.id)!.state).toBe("running");
    await until(() => turnsFor(task.id)[0]?.status === "done");

    expect(reply(task.id).response).toMatchObject({
      request_id: prompt.request_id,
      response: { behavior: "allow", updatedInput: { answers: { "Which color?": "Blue" } } },
    });
    expect(turnsFor(task.id)[0]).toMatchObject({ status: "done", result: "You chose Blue." });
    expect(getTask(task.id)!.state).not.toBe("needs-input");
  });

  test("a message sent instead releases the question before Claude reads the message", async () => {
    const def = askingClaude([
      emit({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: askId, is_error: true, content: "declined" }] } }),
      "IFS= read -r steer || exit 7",
      'case "$steer" in *GREEN_PLEASE*) ;; *) exit 8 ;; esac',
      emit({ type: "result", result: "Going with green.", session_id: "session-ask", permission_denials: [{ tool_name: "AskUserQuestion", tool_use_id: askId, tool_input: {} }] }),
      "IFS= read -r unexpected && exit 9",
      "exit 0",
    ]);
    const task = makeTask();
    startTurn(task, "ask me", def, cfg);
    await until(() => getTask(task.id)!.state === "needs-input");

    const sent = await submitTaskMessage(getTask(task.id)!, "GREEN_PLEASE: neither, use green", def, cfg);
    expect(sent.disposition).toBe("steered");
    await until(() => turnsFor(task.id)[0]?.status === "done");

    expect(reply(task.id).response.response).toMatchObject({ behavior: "deny" });
    expect(turnsFor(task.id)[0]).toMatchObject({ status: "done", exit_code: 0, result: "Going with green." });
    expect(getTask(task.id)!.state).not.toBe("needs-input");
    const log = readFileSync(turnsFor(task.id)[0]!.log_file, "utf8");
    expect(log).toContain('"reason":"superseded"');
  });

  test("Stop leaves nothing waiting", async () => {
    const def = askingClaude(["sleep 30"]);
    const task = makeTask();
    startTurn(task, "ask me", def, cfg);
    await until(() => getTask(task.id)!.state === "needs-input");

    await interruptTurn(task.id, 500);
    await until(() => turnsFor(task.id)[0]?.status !== "running");
    expect(activeLiveInput(task.id)).toBeUndefined();
    expect(conversationDetail(getTask(task.id)!, { fake: def }).pending_question_id).toBeNull();
  });
});
