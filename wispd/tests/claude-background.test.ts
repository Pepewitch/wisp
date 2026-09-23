import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import type { AdapterDef } from "../src/adapters";
import type { WispConfig } from "../src/config";
import { startTurn } from "../src/runner";
import { createTask, freeSlot, getTask, newTaskId, setTaskFields, turnsFor } from "../src/store";
import { taskPreamble } from "../src/turn-input";

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
    title: "background follow-up test",
    repo_path: "/tmp/repo",
    harness: "fake",
    model: null,
    slot: freeSlot(),
  });
  setTaskFields(task.id, { worktree_path: mkdtempSync(join(tmpdir(), "wisp-background-")) });
  return getTask(task.id)!;
}

async function until(pred: () => boolean, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await Bun.sleep(50);
  }
}

describe("Claude background follow-up", () => {
  test("keeps stdin open until background work reports its follow-up result", async () => {
    const script = [
      "IFS= read -r first",
      `printf '%s\\n' '{"type":"system","subtype":"background_tasks_changed","tasks":[{"task_id":"waiter","task_type":"local_bash"}]}'`,
      `printf '%s\\n' '{"type":"system","subtype":"background_tasks_changed","tasks":[]}'`,
      `printf '%s\\n' '{"type":"system","subtype":"task_notification","task_id":"waiter","status":"completed"}'`,
      `printf '%s\\n' '{"type":"result","result":"still waiting","session_id":"session-background"}'`,
      // EOF here means Wisp closed stdin at the first result and reproduced
      // the real Claude failure. Probe with a blocking reader rather than
      // `read -t`: macOS Bash 3.2 reports both pipe timeout and EOF as status 1.
      "exec 3<&0",
      'IFS= read -r unexpected <&3 & reader="$!"',
      "sleep 0.2",
      'kill -0 "$reader" 2>/dev/null || exit 9',
      'kill "$reader" 2>/dev/null || true',
      'wait "$reader" 2>/dev/null || true',
      "exec 3<&-",
      `printf '%s\\n' '{"type":"result","result":"background finished","session_id":"session-background"}'`,
    ].join("; ");
    const def: AdapterDef = {
      bin: "bash",
      exec: ["-c", script],
      liveInput: "claude-stream-json",
      parse: { format: "json", resultType: "result", result: "result", session: "session_id" },
      attach: null,
    };
    const task = makeTask();
    startTurn(task, "wait and report", def, cfg);
    await until(() => turnsFor(task.id)[0]?.status === "done");

    expect(turnsFor(task.id)[0]).toMatchObject({
      status: "done",
      exit_code: 0,
      result: "background finished",
    });
  });

  // Captured from claude-code against a real Monitor call: the monitor
  // registers as a backgrounded local_bash task, then each event it emits
  // drives its own model call and its own `result`. Only after
  // background_tasks_changed empties and task_notification reports completed
  // does the final follow-up run. Every one of those intermediate results must
  // leave stdin open, or the monitor dies at the first event.
  test("keeps a Monitor alive across its repeated events", async () => {
    const script = [
      "IFS= read -r first",
      `printf '%s\\n' '{"type":"system","subtype":"background_tasks_changed","tasks":[{"task_id":"mon","task_type":"local_bash"}]}'`,
      `printf '%s\\n' '{"type":"system","subtype":"task_started","task_id":"mon","is_backgrounded":true,"task_type":"local_bash"}'`,
      `printf '%s\\n' '{"type":"result","result":"EVENT tick 1","session_id":"session-monitor"}'`,
      "exec 3<&0",
      'IFS= read -r unexpected <&3 & reader="$!"',
      "sleep 0.2",
      'kill -0 "$reader" 2>/dev/null || exit 9',
      'kill "$reader" 2>/dev/null || true',
      'wait "$reader" 2>/dev/null || true',
      "exec 3<&-",
      `printf '%s\\n' '{"type":"result","result":"EVENT tick 2","session_id":"session-monitor"}'`,
      `printf '%s\\n' '{"type":"result","result":"EVENT tick 3","session_id":"session-monitor"}'`,
      "exec 3<&0",
      'IFS= read -r unexpected <&3 & reader="$!"',
      "sleep 0.2",
      'kill -0 "$reader" 2>/dev/null || exit 9',
      'kill "$reader" 2>/dev/null || true',
      'wait "$reader" 2>/dev/null || true',
      "exec 3<&-",
      `printf '%s\\n' '{"type":"system","subtype":"background_tasks_changed","tasks":[]}'`,
      `printf '%s\\n' '{"type":"system","subtype":"task_updated","task_id":"mon"}'`,
      `printf '%s\\n' '{"type":"system","subtype":"task_notification","task_id":"mon","status":"completed"}'`,
      "exec 3<&0",
      'IFS= read -r unexpected <&3 & reader="$!"',
      "sleep 0.2",
      'kill -0 "$reader" 2>/dev/null || exit 9',
      'kill "$reader" 2>/dev/null || true',
      'wait "$reader" 2>/dev/null || true',
      "exec 3<&-",
      `printf '%s\\n' '{"type":"result","result":"MONITOR_DONE","session_id":"session-monitor"}'`,
    ].join("; ");
    const def: AdapterDef = {
      bin: "bash",
      exec: ["-c", script],
      liveInput: "claude-stream-json",
      parse: { format: "json", resultType: "result", result: "result", session: "session_id" },
      attach: null,
    };
    const task = makeTask();
    startTurn(task, "watch ticks", def, cfg);
    await until(() => turnsFor(task.id)[0]?.status === "done");

    expect(turnsFor(task.id)[0]).toMatchObject({
      status: "done",
      exit_code: 0,
      result: "MONITOR_DONE",
    });
  });

  // The monitor's last event and its completion can land while the model call
  // answering that event is still in flight, so the completion arrives BEFORE
  // the result it did not cause. Closing on that result drops the follow-up
  // the completion was supposed to wake.
  test("keeps stdin open when a Monitor completes mid-call", async () => {
    const script = [
      "IFS= read -r first",
      `printf '%s\\n' '{"type":"system","subtype":"background_tasks_changed","tasks":[{"task_id":"mon","task_type":"local_bash"}]}'`,
      `printf '%s\\n' '{"type":"system","subtype":"task_started","task_id":"mon","is_backgrounded":true,"task_type":"local_bash"}'`,
      `printf '%s\\n' '{"type":"result","result":"EVENT tick 1","session_id":"session-race"}'`,
      `printf '%s\\n' '{"type":"system","subtype":"background_tasks_changed","tasks":[]}'`,
      `printf '%s\\n' '{"type":"system","subtype":"task_notification","task_id":"mon","status":"completed"}'`,
      `printf '%s\\n' '{"type":"result","result":"EVENT tick 2","session_id":"session-race"}'`,
      "exec 3<&0",
      'IFS= read -r unexpected <&3 & reader="$!"',
      "sleep 0.2",
      'kill -0 "$reader" 2>/dev/null || exit 9',
      'kill "$reader" 2>/dev/null || true',
      'wait "$reader" 2>/dev/null || true',
      "exec 3<&-",
      `printf '%s\\n' '{"type":"result","result":"MONITOR_DONE","session_id":"session-race"}'`,
    ].join("; ");
    const def: AdapterDef = {
      bin: "bash",
      exec: ["-c", script],
      liveInput: "claude-stream-json",
      parse: { format: "json", resultType: "result", result: "result", session: "session_id" },
      attach: null,
    };
    const task = makeTask();
    startTurn(task, "watch ticks", def, cfg);
    await until(() => turnsFor(task.id)[0]?.status === "done");

    expect(turnsFor(task.id)[0]).toMatchObject({
      status: "done",
      exit_code: 0,
      result: "MONITOR_DONE",
    });
  });

  test("closes on a result that already consumed the background completion", async () => {
    const script = [
      "IFS= read -r first",
      `printf '%s\\n' '{"type":"system","subtype":"background_tasks_changed","tasks":[{"task_id":"waiter"}]}'`,
      `printf '%s\\n' '{"type":"system","subtype":"task_notification","task_id":"waiter","status":"completed"}'`,
      `printf '%s\\n' '{"type":"user","message":{"content":[{"type":"tool_result","content":"READY"}]}}'`,
      `printf '%s\\n' '{"type":"result","result":"READY","session_id":"session-background"}'`,
      "IFS= read -r -t 0.3 unexpected",
      'status="$?"',
      '[ "$status" -eq 1 ] || exit 9',
    ].join("; ");
    const def: AdapterDef = {
      bin: "bash",
      exec: ["-c", script],
      liveInput: "claude-stream-json",
      parse: { format: "json", resultType: "result", result: "result", session: "session_id" },
      attach: null,
    };
    const task = makeTask();
    startTurn(task, "wait and report", def, cfg);
    await until(() => turnsFor(task.id)[0]?.status === "done");

    expect(turnsFor(task.id)[0]).toMatchObject({ status: "done", exit_code: 0, result: "READY" });
  });

  // The follow-up cycle a completion wakes announces itself with system/init.
  // Without that init the result belongs to the call that was already running,
  // which is the ordering the Monitor test above covers. Probe with a blocking
  // reader: `read -t` cannot tell timeout from EOF on macOS Bash 3.2.
  test("closes on the follow-up result a completion woke", async () => {
    const script = [
      "IFS= read -r first",
      `printf '%s\\n' '{"type":"system","subtype":"background_tasks_changed","tasks":[{"task_id":"waiter"}]}'`,
      `printf '%s\\n' '{"type":"result","result":"waiting","session_id":"session-background"}'`,
      `printf '%s\\n' '{"type":"system","subtype":"task_notification","task_id":"waiter","status":"completed"}'`,
      `printf '%s\\n' '{"type":"system","subtype":"init","session_id":"session-background"}'`,
      `printf '%s\\n' '{"type":"result","result":"READY","session_id":"session-background"}'`,
      "exec 3<&0",
      'IFS= read -r unexpected <&3 & reader="$!"',
      "sleep 0.2",
      'if kill -0 "$reader" 2>/dev/null; then kill "$reader" 2>/dev/null; exit 9; fi',
      "exec 3<&-",
    ].join("; ");
    const def: AdapterDef = {
      bin: "bash",
      exec: ["-c", script],
      liveInput: "claude-stream-json",
      parse: { format: "json", resultType: "result", result: "result", session: "session_id" },
      attach: null,
    };
    const task = makeTask();
    startTurn(task, "wait and report", def, cfg);
    await until(() => turnsFor(task.id)[0]?.status === "done");

    expect(turnsFor(task.id)[0]).toMatchObject({ status: "done", exit_code: 0, result: "READY" });
  });

  test("the task preamble points delayed follow-up at durable workflows", () => {
    expect(taskPreamble(makeTask())).toContain("wisp workflow types");
    expect(taskPreamble(makeTask())).toContain("instead of relying on a harness background process");
  });
});

