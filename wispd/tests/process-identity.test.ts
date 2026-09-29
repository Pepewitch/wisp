/**
 * A process's identity must mean the same thing to every daemon that reads it.
 *
 * On macOS the start time comes from `ps -o lstart=`, which prints local time
 * in the current locale. A daemon restarted under a different `TZ` or `LANG`
 * used to read its own still-running harness as a reused pid: the turn was
 * failed, the next send started a second harness in the same worktree, and
 * Stop refused its background groups as "ownership is uncertain". A `ps` that
 * could not be spawned at all was also reported as a dead process.
 *
 * Bun does not pass in-process `process.env` edits to children, so a "daemon
 * in another timezone" here is a real child `bun` launched with that `TZ`.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AdapterDef } from "../src/adapters";
import type { WispConfig } from "../src/config";
import * as procid from "../src/procid";
import { compareStartTimes, lstartWallClock, processStartTime, readProcessStartTime } from "../src/procid";
import { signalProcessGroup } from "../src/process-tree";
import { pidIdentity } from "../src/process-watch";
import { interruptTurn, recoverOrphanedTurns } from "../src/runner";
import { createTask, createTurn, finishTurn, freeSlot, getTask, newTaskId, setTaskFields, transition, turnsFor } from "../src/store";
import { backgroundWork, recordProcessGroup, refreshProcessGroups } from "../src/task-processes";

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

const jsonAdapter: AdapterDef = {
  bin: "true",
  exec: [],
  parse: { format: "json", resultType: "result", result: "result", session: "session_id" },
  attach: null,
};
const RESULT_LINE = '{"type":"result","result":"finished after the restart","session_id":"sess-tz"}';

const PROCID = join(import.meta.dir, "../src/procid.ts");
const PROCESS_WATCH = join(import.meta.dir, "../src/process-watch.ts");
/** Linux identities are /proc start ticks, never lstart text, so the ps-only cases do not apply. */
const onLinux = process.platform === "linux";

/**
 * A fixed-offset POSIX zone that is NOT this machine's current offset, so a
 * start time rendered in it can never coincide with the local rendering.
 */
function foreignZone(): string {
  return -new Date().getTimezoneOffset() === 9 * 60 ? "WISPB+5" : "WISPA-9";
}

/** Run a script in a child bun with the given environment and return its last stdout line as JSON. */
async function inChildBun(script: string, env: Record<string, string>): Promise<unknown> {
  const dir = mkdtempSync(join(tmpdir(), "wisp-procid-"));
  const file = join(dir, "probe.ts");
  writeFileSync(file, script);
  const child = Bun.spawn({ cmd: [process.execPath, file], env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`child bun failed (${code}): ${err}`);
  return JSON.parse(out.trim().split("\n").at(-1)!);
}

/** The identity a daemon running under `env` would store for `pid` at spawn time. */
async function recordedUnder(pid: number, env: Record<string, string>): Promise<string> {
  const token = await inChildBun(
    `import { processStartTime } from ${JSON.stringify(PROCID)};\nconsole.log(JSON.stringify(processStartTime(${pid})));`,
    env,
  );
  expect(typeof token).toBe("string");
  return token as string;
}

/** What an older Wisp in that zone stored: the raw `lstart` text, verbatim. */
function legacyTokenUnder(pid: number, tz: string): string {
  const res = Bun.spawnSync({ cmd: ["ps", "-o", "lstart=", "-p", String(pid)], env: { ...process.env, TZ: tz, LC_ALL: "C" } });
  const text = res.stdout.toString().trim();
  expect(text).not.toBe("");
  return text;
}

const children: ReturnType<typeof Bun.spawn>[] = [];
const groups: number[] = [];
afterEach(async () => {
  for (const pgid of groups.splice(0)) signalProcessGroup(pgid, "SIGKILL");
  for (const child of children.splice(0)) {
    child.kill("SIGKILL");
    await child.exited;
  }
});

function sleeper(detached = false): ReturnType<typeof Bun.spawn> {
  const child = Bun.spawn({ cmd: ["sleep", "30"], stdout: "ignore", stderr: "ignore", detached });
  children.push(child);
  if (detached) groups.push(child.pid);
  return child;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function until(pred: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await Bun.sleep(50);
  }
}

/** A running task whose turn row carries the pid identity a previous daemon stored. */
function orphanedTurn(pid: number, token: string | null): string {
  const task = createTask({ id: newTaskId(), title: "identity test", repo_path: "/tmp/repo", harness: "fake", model: null, slot: freeSlot() });
  const dir = mkdtempSync(join(tmpdir(), "wisp-identity-"));
  setTaskFields(task.id, { worktree_path: dir, turn_count: 1 });
  transition(task.id, "running", "turn 1");
  const log = join(dir, "turn.out.log");
  writeFileSync(log, `${RESULT_LINE}\n`);
  createTurn(task.id, 1, "prompt", pid, log, token);
  return task.id;
}

describe("start-time tokens", () => {
  test("reads C-locale lstart text, space-padded days included, and nothing else", () => {
    expect(lstartWallClock("Tue Sep 29 03:25:37 2026")).toBe(Date.UTC(2026, 8, 29, 3, 25, 37));
    expect(lstartWallClock("  Wed Sep  9 03:25:37 2026  ")).toBe(Date.UTC(2026, 8, 9, 3, 25, 37));
    expect(lstartWallClock("Mon Feb 31 00:00:00 2026")).toBeNull();
    expect(lstartWallClock("mar. 29 sept. 10:25:37 2026")).toBeNull();
    expect(lstartWallClock("old-start-time")).toBeNull();
  });

  test("canonical and Linux tick tokens compare exactly", () => {
    expect(compareStartTimes("2026-09-29T03:25:37Z", "2026-09-29T03:25:37Z")).toBe("same");
    expect(compareStartTimes("2026-09-29T03:25:37Z", "2026-09-29T03:25:38Z")).toBe("different");
    expect(compareStartTimes("12345", "12345")).toBe("same");
    expect(compareStartTimes("12345", "12346")).toBe("different");
  });

  test("an older Wisp's local-time token is compared exactly once its launch time pins the zone", () => {
    const launchedAt = "2026-09-29T03:25:37.412Z";
    // Recorded at UTC+9, UTC-5 and Nepal's UTC+5:45; the process started at 03:25:37Z.
    for (const text of ["Tue Sep 29 12:25:37 2026", "Mon Sep 28 22:25:37 2026", "Tue Sep 29 09:10:37 2026"]) {
      expect(compareStartTimes(text, "2026-09-29T03:25:37Z", launchedAt)).toBe("same");
      expect(compareStartTimes(text, "2026-09-29T03:25:38Z", launchedAt)).toBe("different");
      // A stranger that started exactly an hour later is not mistaken for it.
      expect(compareStartTimes(text, "2026-09-29T04:25:37Z", launchedAt)).toBe("different");
    }
    // Another locale's text: the launch time can still rule out a stranger,
    // but nothing can confirm the process that started at launch.
    expect(compareStartTimes("mar. 29 sept. 12:25:37 2026", "2026-09-29T04:25:37Z", launchedAt)).toBe("different");
    expect(compareStartTimes("mar. 29 sept. 12:25:37 2026", "2026-09-29T03:25:37Z", launchedAt)).toBe("uncertain");
  });

  test("without a launch time, an older token is ours only in this daemon's own zone", () => {
    const instant = Date.UTC(2026, 8, 29, 3, 25, 37);
    const d = new Date(instant);
    const two = (n: number) => String(n).padStart(2, "0");
    const local = `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()]} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getMonth()]} ${String(d.getDate()).padStart(2, " ")} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())} ${d.getFullYear()}`;
    expect(compareStartTimes(local, "2026-09-29T03:25:37Z")).toBe("same");
    // Some zone renders the instant this way: cannot be confirmed, cannot be ruled out.
    const shifted = -d.getTimezoneOffset() === 9 * 60 ? "Mon Sep 28 22:25:37 2026" : "Tue Sep 29 12:25:37 2026";
    expect(compareStartTimes(shifted, "2026-09-29T03:25:37Z")).toBe("uncertain");
    // No zone renders it this way, and another locale's text proves nothing.
    expect(compareStartTimes("Thu Jan  1 00:00:00 1970", "2026-09-29T03:25:37Z")).toBe("different");
    expect(compareStartTimes("mar. 29 sept. 10:25:37 2026", "2026-09-29T03:25:37Z")).toBe("uncertain");
  });
});

describe("process identity across daemon timezones and locales", () => {
  test("an identity recorded in one timezone verifies from a daemon in another timezone and locale", async () => {
    const child = sleeper();
    const token = await recordedUnder(child.pid, { TZ: "WISPA-9", LC_ALL: "C" });
    const verdict = await inChildBun(
      `import { pidIdentity } from ${JSON.stringify(PROCESS_WATCH)};\n` +
        `console.log(JSON.stringify(await pidIdentity(${child.pid}, ${JSON.stringify(token)})));`,
      { TZ: "WISPB+5", LANG: "fr_FR.UTF-8", LC_ALL: "fr_FR.UTF-8" },
    );
    expect(verdict).toBe("alive");
    expect(await pidIdentity(child.pid, token)).toBe("alive");
  }, 15_000);

  test("a ps that cannot be spawned is unknown, never dead", async () => {
    const token = processStartTime(process.pid);
    expect(token).not.toBeNull();
    const read = spyOn(procid, "readProcessStartTime").mockResolvedValue({ kind: "unavailable" });
    try {
      expect(await pidIdentity(process.pid, token)).toBe("unknown");
    } finally {
      read.mockRestore();
    }
    // A pid that does not exist is still dead without asking ps at all.
    const exited = Bun.spawn({ cmd: ["true"] });
    await exited.exited;
    expect(await pidIdentity(exited.pid, token)).toBe("dead");
  });

  test.skipIf(onLinux)("EAGAIN from spawning ps is unknown, not a dead process (macOS reads through ps)", async () => {
    const token = processStartTime(process.pid);
    const spawn = spyOn(Bun, "spawn").mockImplementation(() => {
      throw Object.assign(new Error("posix_spawn: Resource temporarily unavailable"), { code: "EAGAIN" });
    });
    try {
      expect(await readProcessStartTime(process.pid)).toEqual({ kind: "unavailable" });
      expect(await pidIdentity(process.pid, token)).toBe("unknown");
    } finally {
      spawn.mockRestore();
    }
  });
});

describe("restart recovery keeps a live harness across a timezone change", () => {
  test("a turn recorded by a daemon in another timezone is re-adopted, not failed", async () => {
    const child = sleeper();
    const taskId = orphanedTurn(child.pid, await recordedUnder(child.pid, { TZ: foreignZone(), LC_ALL: "C" }));
    await recoverOrphanedTurns({ fake: jsonAdapter }, cfg);
    // Still running: finalizing here is what let the next send start a second harness.
    expect(turnsFor(taskId)[0]!.status).toBe("running");
    expect(getTask(taskId)!.state).toBe("running");
    expect(alive(child.pid)).toBe(true);
    child.kill("SIGKILL");
    await child.exited;
    await until(() => turnsFor(taskId)[0]!.status !== "running"); // 3s poll tick
    expect(turnsFor(taskId)[0]!.status).toBe("done");
  }, 15_000);

  test.skipIf(onLinux)("an older Wisp's local-time token from another timezone is still recognized", async () => {
    const child = sleeper();
    const taskId = orphanedTurn(child.pid, legacyTokenUnder(child.pid, foreignZone()));
    await recoverOrphanedTurns({ fake: jsonAdapter }, cfg);
    expect(turnsFor(taskId)[0]!.status).toBe("running");
    child.kill("SIGKILL");
    await child.exited;
    await until(() => turnsFor(taskId)[0]!.status !== "running");
    expect(turnsFor(taskId)[0]!.status).toBe("done");
  }, 15_000);

  test("an identity that cannot be read is waited on: never finalized, never signalled", async () => {
    const child = sleeper();
    const taskId = orphanedTurn(child.pid, processStartTime(child.pid));
    const read = spyOn(procid, "readProcessStartTime").mockResolvedValue({ kind: "unavailable" });
    try {
      await recoverOrphanedTurns({ fake: jsonAdapter }, cfg);
      expect(turnsFor(taskId)[0]!.status).toBe("running");
      // Stop refuses rather than signalling a pid it cannot prove is ours,
      // and leaves the turn running for a retry to settle.
      await expect(interruptTurn(taskId, 50)).rejects.toThrow("could not verify");
      expect(alive(child.pid)).toBe(true);
      expect(turnsFor(taskId)[0]!.interrupt_detail).toBeNull();
      await Bun.sleep(3_300); // one re-adoption poll tick, still unverifiable
      expect(turnsFor(taskId)[0]!.status).toBe("running");
      expect(alive(child.pid)).toBe(true);
    } finally {
      read.mockRestore();
    }
    // Once ps answers again, the ordinary path finishes the job.
    await interruptTurn(taskId, 200);
    await child.exited;
    await until(() => turnsFor(taskId)[0]!.status !== "running");
    expect(alive(child.pid)).toBe(false);
  }, 20_000);
});

describe("background groups keep their owner across a timezone change", () => {
  function finishedTurnWithGroup(pid: number, token: string): { taskId: string; turnId: number } {
    const task = createTask({ id: newTaskId(), title: "group identity", repo_path: "/tmp/repo", harness: "fake", model: null, slot: freeSlot() });
    const turnId = createTurn(task.id, 1, "old turn", pid, "/dev/null", token);
    recordProcessGroup(turnId);
    finishTurn(turnId, "done", 0, "result");
    transition(task.id, "done", "result");
    return { taskId: task.id, turnId };
  }

  test("a group recorded in another timezone stays owned, so Stop can stop it", async () => {
    const child = sleeper(true);
    const { taskId } = finishedTurnWithGroup(child.pid, await recordedUnder(child.pid, { TZ: foreignZone(), LC_ALL: "C" }));
    await refreshProcessGroups(taskId);
    expect(backgroundWork(taskId).state).toBe("running");
    await interruptTurn(taskId, 200);
    await child.exited;
    expect(backgroundWork(taskId).state).toBe("none");
  }, 15_000);

  test.skipIf(onLinux)("a group an older Wisp recorded in local time stays owned", async () => {
    const child = sleeper(true);
    const { taskId } = finishedTurnWithGroup(child.pid, legacyTokenUnder(child.pid, foreignZone()));
    await refreshProcessGroups(taskId);
    expect(backgroundWork(taskId).state).toBe("running");
    await interruptTurn(taskId, 200);
    await child.exited;
    expect(backgroundWork(taskId).state).toBe("none");
  }, 15_000);
});
