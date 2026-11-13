import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import type { AdapterDef } from "../src/adapters";
import { backgroundHoldsReport } from "../src/autopilot/idle";
import type { WispConfig } from "../src/config";
import { archiveTaskRows } from "../src/domain/archive";
import { activeLiveInput, lingerTiming, warmProcessCount } from "../src/live-input";
import { processGroupAlive, signalProcessGroup } from "../src/process-tree";
import { startTurn, submitTaskMessage } from "../src/runner";
import { createTask, freeSlot, getTask, getTaskMessage, newTaskId, setTaskFields, turnsFor } from "../src/store";
import { BACKGROUND_SETTLE_MS, backgroundWork, refreshProcessGroups } from "../src/task-processes";

const base: WispConfig = {
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
const cfg: WispConfig = { ...base, warmHarnessProcesses: 2 };

/** Every task this file started, so a failed case cannot leave its fake harness running. */
const started: string[] = [];

afterEach(() => {
  for (const taskId of started.splice(0)) {
    for (const turn of turnsFor(taskId)) if (turn.pid && processGroupAlive(turn.pid)) signalProcessGroup(turn.pid, "SIGKILL");
  }
});

function makeTask(extra: Partial<Parameters<typeof createTask>[0]> = {}) {
  const task = createTask({ id: newTaskId(), title: "warm process test", repo_path: "/tmp/repo", harness: "fake", model: null, slot: freeSlot(), ...extra });
  setTaskFields(task.id, { worktree_path: mkdtempSync(join(tmpdir(), "wisp-warm-")) });
  started.push(task.id);
  return getTask(task.id)!;
}

async function until(pred: () => boolean, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await Bun.sleep(25);
  }
}

function emit(event: Record<string, unknown>): string {
  return `printf '%s\\n' '${JSON.stringify(event)}'`;
}

/** One model call as the CLI makes it: `system/init`, then its result. */
function answer(text: string, extra: Record<string, unknown> = {}): string[] {
  return [emit({ type: "system", subtype: "init", session_id: "session-warm" }), emit({ type: "result", result: text, session_id: "session-warm", ...extra })];
}

/** Wait for Wisp to close stdin: exit 0 at EOF, 9 if it writes a line it should not. */
const UNTIL_EOF = ["IFS= read -r unexpected && exit 9", "touch exited", "exit 0"];

/** The fake's second life, once `marker` exists in its worktree: a plain answer, then EOF. */
function resumed(marker: string, text: string): string {
  return `if [ -f ${marker} ]; then IFS= read -r first; ${answer(text).join("; ")}; IFS= read -r unexpected && exit 9; exit 0; fi`;
}

function claudeDef(lines: string[]): AdapterDef {
  return {
    bin: "bash",
    exec: ["-c", lines.join("; ")],
    liveInput: "claude-stream-json",
    parse: { format: "json", resultType: "result", result: "result", session: "session_id" },
    attach: null,
  };
}

async function withTiming(timing: Partial<typeof lingerTiming>, body: () => Promise<void>): Promise<void> {
  const saved = { ...lingerTiming };
  Object.assign(lingerTiming, timing);
  try {
    await body();
  } finally {
    Object.assign(lingerTiming, saved);
  }
}

const done = (taskId: string, n: number) => () => turnsFor(taskId).find((turn) => turn.n === n)?.status === "done";

describe("a warm Claude process", () => {
  test("settles a plain answer, waits for the next turn without being background work, and takes it", async () => {
    const def = claudeDef([
      "IFS= read -r first",
      ...answer("FIRST"),
      "IFS= read -r second || exit 7",
      'case "$second" in *NEXT_PROMPT*) ;; *) exit 8 ;; esac',
      ...answer("SECOND"),
      ...UNTIL_EOF,
    ]);
    const task = makeTask();
    startTurn(task, "first", def, cfg);
    await until(done(task.id, 1));
    const first = turnsFor(task.id)[0]!;
    expect(first).toMatchObject({ status: "done", result: "FIRST", exit_code: null });
    expect(getTask(task.id)!.state).toBe("done");
    expect(activeLiveInput(task.id)).toBeUndefined();
    await until(() => warmProcessCount() === 1);
    await refreshProcessGroups(task.id);
    // waiting for the next turn is not work: no badge, no hold on a workflow or a subtask report
    expect(processGroupAlive(first.pid!)).toBe(true);
    expect(backgroundWork(task.id).state).toBe("none");
    expect(backgroundWork(task.id, BACKGROUND_SETTLE_MS).state).toBe("none");
    expect(backgroundHoldsReport(task.id)).toBe(false);

    const sent = await submitTaskMessage(getTask(task.id)!, "NEXT_PROMPT: go on", def, cfg);
    expect(sent.disposition).toBe("started");
    await until(done(task.id, 2));
    const second = turnsFor(task.id)[1]!;
    expect(second).toMatchObject({ status: "done", result: "SECOND", pid: first.pid, prompt: "NEXT_PROMPT: go on" });
    expect(getTaskMessage(sent.message.id)).toMatchObject({ status: "delivered", delivery: "started", turn_n: 2 });
    expect(readFileSync(first.log_file, "utf8")).not.toContain("SECOND");
  });

  test("closes its input after the idle window, and the next turn resumes on a fresh process", async () => {
    await withTiming({ warmMs: 200 }, async () => {
      const def = claudeDef([resumed("resume", "SECOND"), "IFS= read -r first", ...answer("FIRST"), ...UNTIL_EOF]);
      const task = makeTask();
      startTurn(task, "first", def, cfg);
      await until(done(task.id, 1));
      const first = turnsFor(task.id)[0]!;
      await until(() => existsSync(join(task.worktree_path!, "exited")) && !processGroupAlive(first.pid!));
      await refreshProcessGroups(task.id);
      expect(backgroundWork(task.id).groups).toBe(0);

      writeFileSync(join(task.worktree_path!, "resume"), "");
      await submitTaskMessage(getTask(task.id)!, "again", def, cfg);
      await until(done(task.id, 2));
      expect(turnsFor(task.id)[1]!.pid).not.toBe(first.pid);
    });
  });

  test("the least recently warmed goes first when the daemon keeps its cap", async () => {
    const one = { ...cfg, warmHarnessProcesses: 1 };
    const def = claudeDef(["IFS= read -r first", ...answer("FIRST"), ...UNTIL_EOF]);
    const older = makeTask();
    startTurn(older, "first", def, one);
    await until(done(older.id, 1));
    const olderPid = turnsFor(older.id)[0]!.pid!;
    await until(() => warmProcessCount() === 1);

    const newer = makeTask();
    startTurn(newer, "first", def, one);
    await until(done(newer.id, 1));
    // the older one's input closed: the fake saw EOF and exited 0, not 9
    await until(() => existsSync(join(older.worktree_path!, "exited")) && !processGroupAlive(olderPid));
    expect(processGroupAlive(turnsFor(newer.id)[0]!.pid!)).toBe(true);
    expect(warmProcessCount()).toBe(1);
  });

  test("is not kept after an error, for a reviewer, or when the config keeps none", async () => {
    const failing = claudeDef(["IFS= read -r first", ...answer("broke", { is_error: true }), ...UNTIL_EOF]);
    const errored = makeTask();
    startTurn(errored, "first", failing, cfg);
    await until(() => existsSync(join(errored.worktree_path!, "exited")));
    await until(() => turnsFor(errored.id)[0]?.status === "failed");

    const plain = claudeDef(["IFS= read -r first", ...answer("FIRST"), ...UNTIL_EOF]);
    const reviewer = makeTask({ verify_role: "reviewer" });
    startTurn(reviewer, "review", plain, cfg);
    await until(() => existsSync(join(reviewer.worktree_path!, "exited")));
    await until(done(reviewer.id, 1));

    const off = makeTask();
    startTurn(off, "first", plain, base);
    await until(() => existsSync(join(off.worktree_path!, "exited")));
    await until(done(off.id, 1));
  });

  test("a process a turn left behind, no longer its child, is still background work", async () => {
    const def = claudeDef([
      "IFS= read -r first",
      // double-forked: reparented away from the harness, still in its group
      "( sleep 30 & )",
      ...answer("FIRST"),
      ...UNTIL_EOF,
    ]);
    const task = makeTask();
    startTurn(task, "start a server", def, cfg);
    await until(done(task.id, 1));
    await refreshProcessGroups(task.id);
    expect(backgroundWork(task.id).state).toBe("running");
  });

  test("a message for another model ends it, and starts on a new process", async () => {
    const def = claudeDef(["IFS= read -r first", ...answer("ANSWER"), ...UNTIL_EOF]);
    const task = makeTask();
    startTurn(task, "first", def, cfg);
    await until(done(task.id, 1));
    const first = turnsFor(task.id)[0]!;
    await until(() => warmProcessCount() >= 1);

    await submitTaskMessage(getTask(task.id)!, "switch models", def, cfg, [], undefined, { fake: def }, {
      harness: "fake", model: "another-model", effort: null, fast: false, freshContext: false,
    });
    await until(done(task.id, 2));
    const second = turnsFor(task.id)[1]!;
    expect(second.pid).not.toBe(first.pid);
    expect(second.requested_model).toBe("another-model");
    expect(processGroupAlive(first.pid!)).toBe(false);
    // it ran nothing in the background, so its transcript has nothing to explain
    expect(readFileSync(first.log_file, "utf8")).not.toContain("Wisp stopped the background work");
  });

  test("archive takes a warm task as it is, and stops the process", async () => {
    const def = claudeDef(["IFS= read -r first", ...answer("FIRST"), ...UNTIL_EOF]);
    const task = makeTask();
    startTurn(task, "first", def, cfg);
    await until(done(task.id, 1));
    const pid = turnsFor(task.id)[0]!.pid!;
    await until(() => warmProcessCount() >= 1);

    expect(await archiveTaskRows([getTask(task.id)!], false, cfg)).toHaveProperty("archived");
    await until(() => !processGroupAlive(pid));
    expect(turnsFor(task.id).map((turn) => turn.status)).toEqual(["done"]);
  });
});
