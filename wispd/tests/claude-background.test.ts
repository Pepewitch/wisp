import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import type { AdapterDef } from "../src/adapters";
import type { WispConfig } from "../src/config";
import { activeLiveInput } from "../src/live-input";
import { processGroupAlive, signalProcessGroup } from "../src/process-tree";
import { hasRunningTurn, interruptTurn, startTurn, submitTaskMessage } from "../src/runner";
import { archiveTaskRows } from "../src/routes/archive";
import { createTask, freeSlot, getTask, newTaskId, setTaskFields, turnsFor } from "../src/store";
import { BACKGROUND_SETTLE_MS, backgroundWork } from "../src/task-processes";
import { taskPreambleLines } from "../src/turn-input";

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

function settled(taskId: string): boolean {
  const status = turnsFor(taskId)[0]?.status;
  return status !== undefined && status !== "running";
}

/** One stream-json record, as the fake harness prints it. */
function emit(event: Record<string, unknown>): string {
  return `printf '%s\\n' '${JSON.stringify(event)}'`;
}

function init(session: string): string {
  return emit({ type: "system", subtype: "init", session_id: session });
}

/** Wait for Wisp to close stdin: exit 0 at EOF, 9 if it writes a line it should not. */
const UNTIL_EOF = ["IFS= read -r unexpected && exit 9", "exit 0"];

/**
 * Exit 9 unless stdin is still open a moment later. A blocking reader, because
 * macOS Bash 3.2's `read -t` reports a pipe timeout and EOF alike.
 */
const STDIN_STILL_OPEN = [
  "exec 3<&0",
  'IFS= read -r unexpected <&3 & reader="$!"',
  "sleep 0.2",
  'kill -0 "$reader" 2>/dev/null || exit 9',
  'kill "$reader" 2>/dev/null || true',
  'wait "$reader" 2>/dev/null || true',
  "exec 3<&-",
];

function claudeDef(lines: string[]): AdapterDef {
  return {
    bin: "bash",
    exec: ["-c", lines.join("; ")],
    liveInput: "claude-stream-json",
    parse: { format: "json", resultType: "result", result: "result", session: "session_id" },
    attach: null,
  };
}

/** Every task this file started, so a failed case cannot leave its fake harness running. */
const started: string[] = [];

afterEach(() => {
  for (const taskId of started.splice(0)) {
    for (const turn of turnsFor(taskId)) if (turn.pid && processGroupAlive(turn.pid)) signalProcessGroup(turn.pid, "SIGKILL");
  }
});

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
  // drives its own model call (`system/init` … `result`, origin
  // task-notification). The prompt's own answer comes first and settles its
  // turn; every event's call is then a follow-up turn of its own, while the
  // process stays alive for the monitor. Only when the monitor ends and its
  // completion's call has answered is nothing left, and stdin closes.
  test("keeps a Monitor alive across its repeated events, one follow-up turn per event", async () => {
    const notified = { origin: { kind: "task-notification" }, num_turns: 1, session_id: "session-monitor" };
    const def = claudeDef([
      "IFS= read -r first",
      init("session-monitor"),
      emit({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "mon", task_type: "local_bash", description: "ticker" }] }),
      emit({ type: "system", subtype: "task_started", task_id: "mon", is_backgrounded: true, task_type: "local_bash", description: "ticker" }),
      emit({ type: "result", result: "STARTED", num_turns: 2, session_id: "session-monitor" }),
      init("session-monitor"),
      emit({ type: "result", result: "tick 1", ...notified }),
      init("session-monitor"),
      emit({ type: "result", result: "tick 2", ...notified }),
      emit({ type: "system", subtype: "background_tasks_changed", tasks: [] }),
      emit({ type: "system", subtype: "task_updated", task_id: "mon" }),
      emit({ type: "system", subtype: "task_notification", task_id: "mon", status: "completed", summary: 'Monitor "ticker" stream ended' }),
      init("session-monitor"),
      emit({ type: "result", result: "MONITOR_DONE", ...notified }),
      ...UNTIL_EOF,
    ]);
    const task = makeTask();
    startTurn(task, "watch ticks", def, cfg);
    await until(() => turnsFor(task.id).length === 4 && !hasRunningTurn(task.id) && backgroundWork(task.id).state === "none");

    const turns = turnsFor(task.id);
    expect(turns.map((turn) => [turn.status, turn.result])).toEqual([
      ["done", "STARTED"],
      ["done", "tick 1"],
      ["done", "tick 2"],
      ["done", "MONITOR_DONE"],
    ]);
    expect(turns[0]!.prompt).toBe("watch ticks");
    expect(turns[1]!.prompt).toBe('Background update from "ticker"');
    expect(turns[3]!.prompt).toBe('Background update: Monitor "ticker" stream ended');
    // one process served them all, and it exited on its own once stdin closed
    expect(new Set(turns.map((turn) => turn.pid)).size).toBe(1);
    expect(turns[3]!.exit_code).toBe(0);
    expect(getTask(task.id)!.state).toBe("done");
  });

  // The monitor's last event and its completion can land while the model call
  // answering that event is still in flight, so the completion arrives BEFORE
  // the result it did not cause. Closing on that result drops the follow-up
  // the completion was supposed to wake; the follow-up stays in that turn.
  test("keeps stdin open when a Monitor completes mid-call", async () => {
    const notified = { origin: { kind: "task-notification" }, num_turns: 1, session_id: "session-race" };
    const def = claudeDef([
      "IFS= read -r first",
      init("session-race"),
      emit({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "mon", task_type: "local_bash" }] }),
      emit({ type: "system", subtype: "task_started", task_id: "mon", is_backgrounded: true, task_type: "local_bash" }),
      emit({ type: "result", result: "STARTED", session_id: "session-race" }),
      init("session-race"),
      emit({ type: "system", subtype: "background_tasks_changed", tasks: [] }),
      emit({ type: "system", subtype: "task_notification", task_id: "mon", status: "completed" }),
      emit({ type: "result", result: "EVENT tick 2", ...notified }),
      ...STDIN_STILL_OPEN,
      init("session-race"),
      emit({ type: "result", result: "MONITOR_DONE", ...notified }),
      ...UNTIL_EOF,
    ]);
    const task = makeTask();
    startTurn(task, "watch ticks", def, cfg);
    await until(() => turnsFor(task.id).length === 2 && !hasRunningTurn(task.id) && backgroundWork(task.id).state === "none");

    // exit_code 9 means stdin closed at "EVENT tick 2", before the completion's call
    expect(turnsFor(task.id).map((turn) => [turn.status, turn.result, turn.exit_code])).toEqual([
      ["done", "STARTED", null],
      ["done", "MONITOR_DONE", 0],
    ]);
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

  // Captured from claude-code resuming a session whose previous process exited
  // with background agents still running: it replays their `stopped`
  // notifications and answers them with an empty result BEFORE the prompt's
  // own cycle. Closing stdin there made the CLI kill every background agent
  // the prompt went on to start, 600 s after its answer.
  test("a resumed session's replayed notifications do not close the turn before the prompt runs", async () => {
    const script = [
      "IFS= read -r first",
      `printf '%s\\n' '{"type":"system","subtype":"task_notification","task_id":"old-agent","status":"stopped"}'`,
      `printf '%s\\n' '{"type":"system","subtype":"init","session_id":"session-resume"}'`,
      `printf '%s\\n' '{"type":"result","subtype":"success","result":"","num_turns":0,"origin":{"kind":"task-notification"},"session_id":"session-resume"}'`,
      "exec 3<&0",
      'IFS= read -r unexpected <&3 & reader="$!"',
      "sleep 0.2",
      'kill -0 "$reader" 2>/dev/null || exit 9',
      'kill "$reader" 2>/dev/null || true',
      'wait "$reader" 2>/dev/null || true',
      "exec 3<&-",
      `printf '%s\\n' '{"type":"system","subtype":"init","session_id":"session-resume"}'`,
      `printf '%s\\n' '{"type":"result","subtype":"success","result":"PROMPT_ANSWER","num_turns":3,"session_id":"session-resume"}'`,
    ].join("; ");
    const def: AdapterDef = {
      bin: "bash",
      exec: ["-c", script],
      liveInput: "claude-stream-json",
      parse: { format: "json", resultType: "result", result: "result", session: "session_id" },
      attach: null,
    };
    const task = makeTask();
    startTurn(task, "continue", def, cfg);
    await until(() => settled(task.id), 4000);

    // exit_code 9 means the fake harness saw stdin close at the replayed result.
    expect(turnsFor(task.id)[0]).toMatchObject({ status: "done", exit_code: 0, result: "PROMPT_ANSWER" });
  });

  // The CLI can fold a queued prompt into a notification cycle that calls the
  // model, and that cycle's result is the prompt's answer despite its origin.
  // Skipping it would hold the turn open with nothing left to arrive.
  test("a notification cycle that answered the prompt still closes the turn", async () => {
    const script = [
      "IFS= read -r first",
      `printf '%s\\n' '{"type":"system","subtype":"task_notification","task_id":"old-agent","status":"completed"}'`,
      `printf '%s\\n' '{"type":"system","subtype":"init","session_id":"session-folded"}'`,
      `printf '%s\\n' '{"type":"result","subtype":"success","result":"FOLDED_ANSWER","num_turns":4,"origin":{"kind":"task-notification"},"session_id":"session-folded"}'`,
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
    startTurn(task, "continue", def, cfg);
    await until(() => settled(task.id), 4000);

    // exit_code 9 means stdin stayed open after the only answer that will come.
    expect(turnsFor(task.id)[0]).toMatchObject({ status: "done", exit_code: 0, result: "FOLDED_ANSWER" });
  });

  // Once the prompt has its answer, notification-driven results are the normal
  // follow-up cycles the tests above cover, and one still closes the turn.
  test("a notification's result after the prompt's answer still closes the turn", async () => {
    const script = [
      "IFS= read -r first",
      `printf '%s\\n' '{"type":"system","subtype":"background_tasks_changed","tasks":[{"task_id":"agent","task_type":"local_agent"}]}'`,
      `printf '%s\\n' '{"type":"result","result":"started","session_id":"session-after"}'`,
      `printf '%s\\n' '{"type":"system","subtype":"background_tasks_changed","tasks":[]}'`,
      `printf '%s\\n' '{"type":"system","subtype":"task_notification","task_id":"agent","status":"completed"}'`,
      `printf '%s\\n' '{"type":"system","subtype":"init","session_id":"session-after"}'`,
      `printf '%s\\n' '{"type":"result","result":"AGENT_DONE","origin":{"kind":"task-notification"},"session_id":"session-after"}'`,
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
    startTurn(task, "start an agent", def, cfg);
    await until(() => settled(task.id), 4000);

    expect(turnsFor(task.id)[0]).toMatchObject({ status: "done", exit_code: 0, result: "AGENT_DONE" });
  });

  test("the task preamble points delayed follow-up at durable workflows", () => {
    const preamble = taskPreambleLines(makeTask()).join("\n");
    expect(preamble).toContain("wisp workflow types");
    expect(preamble).toContain("instead of relying on a harness background process");
  });
});

/**
 * The answer is in, but work the agent started in the background still runs.
 * The turn settles and the process stays, stdin open, for that work: closing
 * stdin would make the CLI kill it. Every fake here writes `system/init` at
 * the start of each model call, as the real CLI does.
 */
describe("Claude background work outliving its turn", () => {
  const devServer = [
    "IFS= read -r first",
    init("session-dev"),
    emit({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "dev", task_type: "local_bash", description: "vite dev server" }] }),
    emit({ type: "system", subtype: "task_started", task_id: "dev", is_backgrounded: true, task_type: "local_bash", description: "vite dev server" }),
    emit({ type: "result", result: "SERVER_UP", num_turns: 2, session_id: "session-dev" }),
  ];

  test("settles the answer as done, names the background work, and keeps the process for it", async () => {
    const def = claudeDef([...devServer, ...UNTIL_EOF]);
    const task = makeTask();
    startTurn(task, "start the dev server", def, cfg);
    await until(() => turnsFor(task.id)[0]?.status === "done");

    const [turn] = turnsFor(task.id);
    expect(turn).toMatchObject({ status: "done", result: "SERVER_UP", exit_code: null });
    expect(getTask(task.id)!.state).toBe("done");
    expect(hasRunningTurn(task.id)).toBeNull();
    expect(activeLiveInput(task.id)).toBeUndefined();
    // Reported at once, not after the straggler window: this process was kept on purpose.
    const background = backgroundWork(task.id, BACKGROUND_SETTLE_MS);
    expect(background.state).toBe("running");
    expect(background.details).toHaveLength(1);
    expect(background.details[0]).toMatchObject({ turn: 1, pgid: turn!.pid });
    expect(background.details[0]!.tasks).toEqual([
      { name: "vite dev server", kind: "local_bash", turn: 1, since: expect.any(String) },
    ]);
    // the process is alive, still reading: the fake exits 0 on EOF and 9 on a stray line
    await Bun.sleep(300);
    expect(processGroupAlive(turn!.pid!)).toBe(true);

    // Stop ends the lingering process and the work it holds; the settled turn stays settled.
    await interruptTurn(task.id, 500);
    await until(() => !processGroupAlive(turn!.pid!) && backgroundWork(task.id).state === "none");
    expect(turnsFor(task.id)).toHaveLength(1);
    expect(turnsFor(task.id)[0]).toMatchObject({ status: "done", result: "SERVER_UP" });
    expect(getTask(task.id)!.state).toBe("done");
  });

  test("archive refuses while it lingers, as it would a running turn; force-archive stops it", async () => {
    const def = claudeDef([...devServer, ...UNTIL_EOF]);
    const task = makeTask();
    startTurn(task, "start the dev server", def, cfg);
    await until(() => turnsFor(task.id)[0]?.status === "done" && backgroundWork(task.id, BACKGROUND_SETTLE_MS).state === "running");
    const pid = turnsFor(task.id)[0]!.pid!;

    const refused = await archiveTaskRows([getTask(task.id)!], false, cfg);
    expect(refused).toMatchObject({ status: 409, error: expect.stringContaining("Background work is still running") });
    expect(processGroupAlive(pid)).toBe(true);

    expect(await archiveTaskRows([getTask(task.id)!], true, cfg)).toHaveProperty("archived");
    expect(getTask(task.id)!.archived).toBe(1);
    // the teardown job stops what the task's recorded groups still run
    await until(() => !processGroupAlive(pid));
    expect(turnsFor(task.id).map((turn) => turn.status)).toEqual(["done"]);
  });

  test("a message while it lingers is written to the same process as the next turn", async () => {
    const def = claudeDef([
      ...devServer,
      "IFS= read -r second || exit 7",
      'case "$second" in *NEXT_PROMPT*) ;; *) exit 8 ;; esac',
      init("session-dev"),
      emit({ type: "result", result: "SECOND_ANSWER", session_id: "session-dev" }),
      ...UNTIL_EOF,
    ]);
    const task = makeTask();
    startTurn(task, "start the dev server", def, cfg);
    await until(() => turnsFor(task.id)[0]?.status === "done" && backgroundWork(task.id, BACKGROUND_SETTLE_MS).state === "running");

    const sent = await submitTaskMessage(getTask(task.id)!, "NEXT_PROMPT: add a route", def, cfg);
    expect(sent.disposition).toBe("started");
    await until(() => turnsFor(task.id)[1]?.status === "done");

    const [first, second] = turnsFor(task.id);
    expect(first).toMatchObject({ status: "done", result: "SERVER_UP" });
    expect(second).toMatchObject({ n: 2, status: "done", result: "SECOND_ANSWER", prompt: "NEXT_PROMPT: add a route", pid: first!.pid });
    // each turn's transcript holds its own call
    expect(readFileSync(first!.log_file, "utf8")).not.toContain("SECOND_ANSWER");
    expect(readFileSync(second!.log_file, "utf8")).toContain("SECOND_ANSWER");
    // the dev server is still up, still named as started in turn 1, and now the latest turn's work
    const background = backgroundWork(task.id, BACKGROUND_SETTLE_MS);
    expect(background.state).toBe("running");
    expect(background.details[0]).toMatchObject({ turn: 2 });
    expect(background.details[0]!.tasks?.map((item) => [item.name, item.turn])).toEqual([["vite dev server", 1]]);

    await interruptTurn(task.id, 500);
    await until(() => !processGroupAlive(first!.pid!));
  });

  test("background work finishing later opens a follow-up turn, clears the marker, and never reopens the settled turn", async () => {
    const def = claudeDef([
      "IFS= read -r first",
      init("session-sleeper"),
      emit({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "sleeper", task_type: "local_bash", description: "sleeper" }] }),
      emit({ type: "system", subtype: "task_started", task_id: "sleeper", is_backgrounded: true, task_type: "local_bash", description: "sleeper" }),
      emit({ type: "result", result: "STARTED", session_id: "session-sleeper" }),
      "while [ ! -f finish ]; do sleep 0.05; done",
      // captured from claude-code 2.1.283: a background command completing after the answer
      emit({ type: "system", subtype: "background_tasks_changed", tasks: [] }),
      emit({ type: "system", subtype: "task_updated", task_id: "sleeper", patch: { status: "completed" } }),
      emit({ type: "system", subtype: "task_notification", task_id: "sleeper", status: "completed", summary: 'Background command "sleeper" completed (exit code 0)' }),
      init("session-sleeper"),
      emit({ type: "result", result: "SLEEPER_DONE", num_turns: 1, origin: { kind: "task-notification" }, session_id: "session-sleeper" }),
      ...UNTIL_EOF,
    ]);
    const task = makeTask();
    startTurn(task, "run the sleeper", def, cfg);
    await until(() => turnsFor(task.id)[0]?.status === "done" && backgroundWork(task.id, BACKGROUND_SETTLE_MS).state === "running");
    const settled = turnsFor(task.id)[0]!;

    writeFileSync(join(task.worktree_path!, "finish"), "");
    await until(() => turnsFor(task.id)[1]?.status === "done" && backgroundWork(task.id).state === "none");

    const [first, followUp] = turnsFor(task.id);
    // the settled turn is exactly as it was
    expect(first).toMatchObject({ status: "done", result: "STARTED", ended_at: settled.ended_at });
    expect(followUp).toMatchObject({
      status: "done",
      result: "SLEEPER_DONE",
      // Wisp closed stdin once nothing was left in the background (9 = it did not)
      exit_code: 0,
      prompt: 'Background update: Background command "sleeper" completed (exit code 0)',
      pid: first!.pid,
    });
    // the completion is recorded with the turn that started the work, the call it woke with its own turn
    expect(readFileSync(first!.log_file, "utf8")).toContain('"task_notification"');
    expect(readFileSync(followUp!.log_file, "utf8")).toContain("SLEEPER_DONE");
    expect(getTask(task.id)!.state).toBe("done");
  });

  // A message written while the answering call runs is either folded into it
  // or gets a call of its own right after it; the stream does not say which.
  // Settling on the first result would file the second call as background
  // work's. A fast steer can even land before the call's own `system/init`,
  // so what counts is how many calls have started, not a flag an init clears.
  for (const when of ["once the call is under way", "before the call starts"] as const) test(`a message steered into the answering call keeps its own call in the same turn (${when})`, async () => {
    const def = claudeDef([
      "IFS= read -r first",
      init("session-steer"),
      emit({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "dev", task_type: "local_bash", description: "dev" }] }),
      emit({ type: "system", subtype: "task_started", task_id: "dev", is_backgrounded: true, task_type: "local_bash", description: "dev" }),
      "IFS= read -r steer || exit 7",
      emit({ type: "result", result: "FIRST", session_id: "session-steer" }),
      init("session-steer"),
      emit({ type: "result", result: "STEER_ANSWER", session_id: "session-steer" }),
      ...UNTIL_EOF,
    ]);
    const task = makeTask();
    startTurn(task, "start it", def, cfg);
    await until(() => activeLiveInput(task.id) !== undefined &&
      (when === "before the call starts" || readFileSync(turnsFor(task.id)[0]!.log_file, "utf8").includes("task_started")));
    const steered = await submitTaskMessage(getTask(task.id)!, "and tell me the port", def, cfg);
    expect(steered.disposition).toBe("steered");
    await until(() => turnsFor(task.id)[0]?.status === "done");
    await Bun.sleep(300);

    expect(turnsFor(task.id)).toHaveLength(1);
    expect(turnsFor(task.id)[0]).toMatchObject({ status: "done", result: "STEER_ANSWER" });

    const pid = turnsFor(task.id)[0]!.pid!;
    await interruptTurn(task.id, 500);
    await until(() => !processGroupAlive(pid));
  });

  // The process was started with one agent; a turn for another cannot ride it,
  // and a second harness beside it would split its session. It is stopped, and
  // the message starts on a fresh process.
  test("a message for another agent ends the lingering process and starts on a new one", async () => {
    const def = claudeDef([...devServer, ...UNTIL_EOF]);
    const task = makeTask();
    startTurn(task, "start the dev server", def, cfg);
    await until(() => turnsFor(task.id)[0]?.status === "done" && backgroundWork(task.id, BACKGROUND_SETTLE_MS).state === "running");
    const first = turnsFor(task.id)[0]!;

    const sent = await submitTaskMessage(getTask(task.id)!, "switch models", def, cfg, [], undefined, { fake: def }, {
      harness: "fake",
      model: "another-model",
      effort: null,
      fast: false,
      freshContext: false,
    });
    expect(sent.disposition).toBe("queued-next");
    await until(() => turnsFor(task.id)[1]?.status === "done");

    const second = turnsFor(task.id)[1]!;
    expect(second.pid).not.toBe(first.pid);
    expect(processGroupAlive(first.pid!)).toBe(false);
    expect(second).toMatchObject({ requested_model: "another-model", result: "SERVER_UP" });
    expect(readFileSync(first.log_file, "utf8")).toContain("Wisp stopped the background work this turn left running");

    await interruptTurn(task.id, 500);
    await until(() => !processGroupAlive(second.pid!));
  });
});
