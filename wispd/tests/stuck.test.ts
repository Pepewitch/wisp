import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import type { WispConfig } from "../src/config";
import { stuckTick } from "../src/runner";
import {
  createTask,
  createTurn,
  freeSlot,
  getTask,
  newTaskId,
  setTaskFields,
  transition,
  undeliveredOutbox,
} from "../src/store";

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

/**
 * Fake clock, fixed once: every log mtime is set relative to NOW via utimes,
 * so quietMin is exact and no test depends on the wall clock advancing.
 */
const NOW = Date.now();

/** A task in 'running' with a running turn backed by a real log file. */
function makeRunningTask(): { id: string; logFile: string } {
  const task = createTask({
    id: newTaskId(),
    title: "stuck test",
    repo_path: "/tmp/repo",
    harness: "fake",
    model: null,
    slot: freeSlot(),
  });
  const logFile = join(mkdtempSync(join(tmpdir(), "wisp-stuck-")), "turn1.out.log");
  writeFileSync(logFile, "harness output\n");
  createTurn(task.id, 1, "prompt", null, logFile);
  transition(task.id, "running", "turn 1");
  return { id: task.id, logFile };
}

/** Fake mtime: backdate the log to `minutes` before the fake clock. */
function setLogAge(logFile: string, minutes: number): void {
  const mtime = new Date(NOW - minutes * 60_000);
  utimesSync(logFile, mtime, mtime);
}

const stuckEventsFor = (taskId: string) =>
  undeliveredOutbox().filter((r) => r.task_id === taskId && r.event === "stuck");

describe("stuckTick — running ⇄ stuck flapping (the state-flapping regression case)", () => {
  test("a running task with a log quiet past stuckMinutes flips to stuck and notifies", async () => {
    const { id, logFile } = makeRunningTask();
    setLogAge(logFile, 15);

    await stuckTick(cfg, NOW);

    const after = getTask(id)!;
    expect(after.state).toBe("stuck");
    expect(after.state_detail).toBe("no output for 15 min (turn 1)");
    // 'stuck' is notify-worthy: exactly one webhook row per flap into stuck
    const rows = stuckEventsFor(id);
    expect(rows.length).toBe(1);
    expect(JSON.parse(rows[0]!.payload)).toMatchObject({ task_id: id, state: "stuck" });
  });

  test("fresh output flips a stuck task back to running (the recovery flap)", async () => {
    const { id, logFile } = makeRunningTask();
    setLogAge(logFile, 15);
    await stuckTick(cfg, NOW);
    expect(getTask(id)!.state).toBe("stuck");

    setLogAge(logFile, 0.2); // the harness spoke again
    await stuckTick(cfg, NOW);

    const after = getTask(id)!;
    expect(after.state).toBe("running");
    expect(after.state_detail).toBe("turn 1 (recovered)");
    // recovery is state-only: 'running' is not notify-worthy, so this flap
    // emits no webhook — if the turn goes quiet again, the NEXT flap into
    // stuck is what re-notifies
    expect(stuckEventsFor(id).length).toBe(1);
  });

  test("each flap into stuck emits a fresh webhook (running → stuck → running → stuck)", async () => {
    const { id, logFile } = makeRunningTask();

    setLogAge(logFile, 20);
    await stuckTick(cfg, NOW);
    expect(getTask(id)!.state).toBe("stuck");

    setLogAge(logFile, 0.1);
    await stuckTick(cfg, NOW);
    expect(getTask(id)!.state).toBe("running");

    setLogAge(logFile, 30);
    await stuckTick(cfg, NOW);

    const after = getTask(id)!;
    expect(after.state).toBe("stuck");
    expect(after.state_detail).toBe("no output for 30 min (turn 1)");
    const rows = stuckEventsFor(id);
    expect(rows.length).toBe(2); // one webhook per flap into stuck
    expect(rows[0]!.seq).toBeLessThan(rows[1]!.seq); // consumers see flaps in order
  });

  test("hysteresis: quiet between 1 min and stuckMinutes leaves a stuck task stuck", async () => {
    const { id, logFile } = makeRunningTask();
    setLogAge(logFile, 15);
    await stuckTick(cfg, NOW);
    expect(getTask(id)!.state).toBe("stuck");

    setLogAge(logFile, 5); // quiet, but not fresh enough to count as recovered
    await stuckTick(cfg, NOW);

    expect(getTask(id)!.state).toBe("stuck");
    expect(stuckEventsFor(id).length).toBe(1); // no re-notify while parked in stuck
  });

  test("hysteresis: quiet under stuckMinutes leaves a running task running", async () => {
    const { id, logFile } = makeRunningTask();
    setLogAge(logFile, 9.9);

    await stuckTick(cfg, NOW);

    expect(getTask(id)!.state).toBe("running");
    expect(stuckEventsFor(id).length).toBe(0);
  });

  test("archived and terminal-state tasks are ignored even with running turns", async () => {
    const archived = makeRunningTask();
    setTaskFields(archived.id, { archived: 1 });
    setLogAge(archived.logFile, 60);

    const done = makeRunningTask();
    transition(done.id, "done", "finished");
    setLogAge(done.logFile, 60);

    await stuckTick(cfg, NOW);

    expect(getTask(archived.id)!.state).toBe("running"); // untouched
    expect(getTask(done.id)!.state).toBe("done");
    expect(stuckEventsFor(archived.id).length).toBe(0);
    expect(stuckEventsFor(done.id).length).toBe(0);
  });

  test("a turn whose log file vanished is skipped without aborting the pass", async () => {
    const { id, logFile } = makeRunningTask();
    // a second running turn whose log path does not exist (e.g. deleted out from under us)
    createTurn(id, 2, "prompt", null, join(tmpdir(), "wisp-stuck-no-such-file.out.log"));
    setLogAge(logFile, 15);

    await stuckTick(cfg, NOW); // must not throw on the missing log...

    expect(getTask(id)!.state).toBe("stuck"); // ...and must still flag via the healthy turn
  });
});
