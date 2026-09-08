/**
 * Stopping a turn stops what the turn started (ENG-03).
 *
 * A review reproduced the defect with the simplest possible harness: a script
 * that launches `sleep` and waits. After `interruptTurn` the task had no
 * running turn and the `sleep` was still alive. Every case here launches real
 * descendants and asserts, by pid, that they are gone — including a child that
 * traps SIGTERM and one that keeps the turn's stdout pipe open, which is what
 * stalls finalization until it dies.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AdapterDef } from "../src/adapters";
import type { WispConfig } from "../src/config";
import { processGroupAlive, signalProcessGroup, signalProcessTree } from "../src/process-tree";
import {
  hasRunningTurn,
  interruptTurn,
  killTurnForArchive,
  startTurn,
} from "../src/runner";
import { createTask, freeSlot, getTask, newTaskId, setTaskFields } from "../src/store";

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

/** Pids this file launched outside a turn, killed on the way out even if a case fails. */
const strays: number[] = [];

afterEach(() => {
  for (const pid of strays.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone, which is the point of most of these tests */
    }
  }
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function until(predicate: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await Bun.sleep(50);
  }
}

/** Read the pid a fixture script recorded for its own child. */
async function recordedPid(path: string): Promise<number> {
  await until(() => existsSync(path) && readFileSync(path, "utf8").trim() !== "");
  const pid = Number(readFileSync(path, "utf8").trim());
  expect(Number.isInteger(pid)).toBe(true);
  strays.push(pid);
  return pid;
}

function makeTask(label: string) {
  const task = createTask({
    id: newTaskId(),
    title: `process tree ${label}`,
    repo_path: "/tmp/repo",
    harness: "fake",
    model: null,
    slot: freeSlot(),
  });
  setTaskFields(task.id, { worktree_path: mkdtempSync(join(tmpdir(), `wisp-tree-${label}-`)) });
  return getTask(task.id)!;
}

/** An adapter whose "harness" is a bash script the test writes. */
function bashAdapter(script: string): AdapterDef {
  return { bin: "bash", exec: ["-c", script], parse: { format: "text" }, attach: null };
}

describe("signalling a process group", () => {
  test("reaches a grandchild, and reports when there is no group to reach", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wisp-group-"));
    const pidFile = join(dir, "child.pid");
    const grouped = Bun.spawn({
      cmd: ["bash", "-c", `sleep 30 & echo $! > ${JSON.stringify(pidFile)}; wait`],
      stdout: "ignore",
      stderr: "ignore",
      detached: true,
    });
    strays.push(grouped.pid);
    const grandchild = await recordedPid(pidFile);

    expect(signalProcessGroup(grouped.pid, "SIGTERM")).toBe("group");
    await grouped.exited;
    await until(() => !alive(grandchild));

    // An undetached child leads no group, so the group attempt finds nothing
    // and the caller's own fallback is what stops it.
    const ungrouped = Bun.spawn({ cmd: ["sleep", "30"], stdout: "ignore", stderr: "ignore" });
    strays.push(ungrouped.pid);
    expect(signalProcessGroup(ungrouped.pid, "SIGTERM")).toBe("gone");
    expect(alive(ungrouped.pid)).toBe(true);
    let fellBack = false;
    expect(
      signalProcessTree(ungrouped.pid, "SIGTERM", (signal) => {
        fellBack = true;
        ungrouped.kill(signal);
      }),
    ).toBe("process");
    expect(fellBack).toBe(true);
    await ungrouped.exited;
  }, 20_000);

  test("processGroupAlive answers for a group that still has members", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wisp-group-alive-"));
    const pidFile = join(dir, "child.pid");
    const leader = Bun.spawn({
      cmd: ["bash", "-c", `sleep 30 & echo $! > ${JSON.stringify(pidFile)}; exit 0`],
      stdout: "ignore",
      stderr: "ignore",
      detached: true,
    });
    strays.push(leader.pid);
    const grandchild = await recordedPid(pidFile);
    await leader.exited;

    // The leader is gone and reaped; the group survives because its child does.
    expect(processGroupAlive(leader.pid)).toBe(true);
    expect(signalProcessGroup(leader.pid, "SIGKILL")).toBe("group");
    await until(() => !alive(grandchild));
    await until(() => !processGroupAlive(leader.pid));
  }, 20_000);
});

describe("interrupting a turn stops its descendants", () => {
  test("a harness's child does not outlive the stop", async () => {
    const task = makeTask("child");
    const pidFile = join(task.worktree_path!, "child.pid");
    startTurn(task, "start work", bashAdapter(`sleep 30 & echo $! > ${JSON.stringify(pidFile)}; wait`), cfg);
    await until(() => hasRunningTurn(task.id) !== null);
    const grandchild = await recordedPid(pidFile);
    expect(alive(grandchild)).toBe(true);

    await interruptTurn(task.id, 2_000);

    expect(hasRunningTurn(task.id)).toBeNull();
    await until(() => !alive(grandchild), 5_000);
  }, 30_000);

  test("a SIGTERM-resistant child is escalated with the rest of the group", async () => {
    const task = makeTask("stubborn");
    const pidFile = join(task.worktree_path!, "child.pid");
    // Both halves ignore SIGTERM: the harness AND the work it started.
    startTurn(
      task,
      "start work",
      bashAdapter(
        `trap "" TERM; bash -c 'trap "" TERM; sleep 30' & echo $! > ${JSON.stringify(pidFile)}; wait`,
      ),
      cfg,
    );
    await until(() => hasRunningTurn(task.id) !== null);
    const grandchild = await recordedPid(pidFile);
    // give both traps a beat to install before the signal
    await Bun.sleep(300);

    await interruptTurn(task.id, 1_000);

    expect(hasRunningTurn(task.id)).toBeNull();
    await until(() => !alive(grandchild), 5_000);
    expect(getTask(task.id)?.state_detail ?? "").toContain("escalated to SIGKILL");
  }, 30_000);

  /**
   * The case that used to hang rather than leak: the harness exits but leaves
   * a child holding the turn's stdout. The pump never sees EOF, so the turn
   * cannot finalize until that child is gone — which is exactly why the stop
   * has to reach the whole group.
   */
  test("a child holding the turn's output open is stopped, so the turn can finalize", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wisp-holder-"));
    const harnessPath = join(dir, "fake-live-harness");
    const pidFile = join(dir, "holder.pid");
    writeFileSync(
      harnessPath,
      [
        "#!/bin/bash",
        // an event so the live protocol has something to parse, then a child
        // that inherits stdout and outlives this shell
        `printf '%s\\n' '{"type":"system","subtype":"init","session_id":"held-session"}'`,
        `sleep 30 & echo $! > ${JSON.stringify(pidFile)}`,
        "wait",
        "",
      ].join("\n"),
    );
    chmodSync(harnessPath, 0o755);
    const def: AdapterDef = {
      bin: harnessPath,
      exec: [],
      liveInput: "claude-stream-json",
      parse: { format: "json", resultType: "result", result: "result", session: "session_id" },
      attach: null,
    };

    const task = makeTask("holder");
    startTurn(task, "start work", def, cfg);
    await until(() => hasRunningTurn(task.id) !== null);
    const holder = await recordedPid(pidFile);

    await killTurnForArchive(task.id, 2_000);

    // Both halves of the promise: nothing of the turn survives, and the row is
    // finalized so archive is allowed to proceed.
    await until(() => !alive(holder), 5_000);
    expect(hasRunningTurn(task.id)).toBeNull();
  }, 30_000);
});
