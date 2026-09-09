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
import { afterEach, describe, expect, spyOn, test } from "bun:test";
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
  recoverOrphanedTurns,
  startTurn,
  submitTaskMessage,
} from "../src/runner";
import { db, createTask, createTurn, finishTurn, freeSlot, getTask, newTaskId, setTaskFields, setTurnInterrupt, transition, turnsFor } from "../src/store";
import { processStartTime } from "../src/procid";
import { STOPPING } from "../src/interrupt-state";
import { archiveTaskRows } from "../src/routes/archive";
import { route } from "../src/routes";
import { backgroundWork, recordProcessGroup, refreshProcessGroups, assertTaskProcessesEnded } from "../src/task-processes";

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
const fixtureGroups: number[] = [];

afterEach(() => {
  for (const pid of fixtureGroups.splice(0)) signalProcessGroup(pid, "SIGKILL");
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
  test("live steering leaves the current harness and its child running", async () => {
    const task = makeTask("live-steering");
    const def: AdapterDef = {
      ...bashAdapter([
        'IFS= read -r first',
        'sleep 30 & echo $! > child.pid',
        'IFS= read -r correction',
        'echo accepted > steered',
        'wait',
      ].join('\n')),
      liveInput: "claude-stream-json",
    };
    startTurn(task, "start work", def, cfg);
    const turn = hasRunningTurn(task.id)!;
    fixtureGroups.push(turn.pid!);
    const descendant = await recordedPid(join(task.worktree_path!, "child.pid"));
    const result = await submitTaskMessage(getTask(task.id)!, "change direction", def, cfg);
    expect(result.disposition).toBe("steered");
    await until(() => existsSync(join(task.worktree_path!, "steered")));
    expect(hasRunningTurn(task.id)?.id).toBe(turn.id);
    expect(alive(turn.pid!)).toBe(true);
    expect(alive(descendant)).toBe(true);
    expect(turnsFor(task.id)[0]?.interrupt_detail).toBeNull();
    await interruptTurn(task.id, 200);
    expect(alive(descendant)).toBe(false);
  }, 10_000);

  test("an identity-validated re-adopted turn also stops its resistant child after leader exit", async () => {
    const task = makeTask("readopted-stop");
    const log = join(task.worktree_path!, "turn.out.log");
    writeFileSync(log, "");
    const child = Bun.spawn({
      cmd: ["sh", "-c", `sh -c 'trap "" TERM; echo $$ > child.pid; while :; do sleep 1; done' & wait`],
      cwd: task.worktree_path!, stdout: "ignore", stderr: "ignore", detached: true,
    });
    fixtureGroups.push(child.pid);
    const descendant = await recordedPid(join(task.worktree_path!, "child.pid"));
    createTurn(task.id, 1, "work before restart", child.pid, log, processStartTime(child.pid));
    setTaskFields(task.id, { turn_count: 1 });
    transition(task.id, "running", "turn 1");
    await recoverOrphanedTurns({ fake: bashAdapter("true") }, cfg);
    await interruptTurn(task.id, 200);
    await child.exited;
    expect(alive(descendant)).toBe(false);
    expect(processGroupAlive(child.pid)).toBe(false);
    expect(hasRunningTurn(task.id)).toBeNull();
  }, 15_000);

  test("a failed stop refuses sending and archive until a successful retry", async () => {
    const task = makeTask("stop-refused");
    const def = bashAdapter('sleep 30 & echo $! > child.pid; wait');
    startTurn(task, "start work", def, cfg);
    const turn = hasRunningTurn(task.id)!;
    fixtureGroups.push(turn.pid!);
    const descendant = await recordedPid(join(task.worktree_path!, "child.pid"));
    const kill = process.kill.bind(process);
    const denied = spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (pid === -turn.pid! && signal !== 0) throw Object.assign(new Error("fixture signal denied"), { code: "EPERM" });
      return kill(pid, signal);
    });
    try {
      await expect(interruptTurn(task.id, 50)).rejects.toThrow("Could not fully stop turn");
      expect(alive(descendant)).toBe(true);
      await expect(submitTaskMessage(getTask(task.id)!, "cannot race", def, cfg)).rejects.toThrow("Could not fully stop turn");
      const url = new URL(`http://localhost/api/tasks/${task.id}/send`);
      const response = await route(new Request(url, {
        method: "POST", body: JSON.stringify({ message: "cannot race through HTTP either" }),
      }), url, url.pathname, cfg, { fake: def });
      expect(response.status).toBe(409);
      expect((await response.json()).error).toContain("Could not fully stop turn");
      await expect(killTurnForArchive(task.id, 50)).rejects.toThrow("Could not fully stop turn");
      const archive = await archiveTaskRows([getTask(task.id)!], true, cfg);
      expect(archive).toMatchObject({ status: 409 });
      expect(getTask(task.id)?.archived).toBe(0);
    } finally {
      denied.mockRestore();
    }
    await interruptTurn(task.id, 200);
    expect(alive(descendant)).toBe(false);
    expect(hasRunningTurn(task.id)).toBeNull();
    expect(getTask(task.id)?.state_detail).toBe("turn interrupted — session kept, send a correction");
  }, 10_000);

  test("recovery retains an unresolved Stop until retry confirms completion", async () => {
    const task = makeTask("pending-stop-recovery");
    const log = join(task.worktree_path!, "turn.out.log");
    writeFileSync(log, "");
    const child = Bun.spawn({ cmd: ["sh", "-c", "exit 0"], stdout: "ignore", stderr: "ignore", detached: true });
    const turnId = createTurn(task.id, 1, "old work", child.pid, log, processStartTime(child.pid));
    setTaskFields(task.id, { turn_count: 1 });
    transition(task.id, "running", "turn 1");
    await child.exited;
    setTurnInterrupt(turnId, STOPPING);
    const def = bashAdapter("true");
    await recoverOrphanedTurns({ fake: def }, cfg);
    expect(turnsFor(task.id)[0]?.status).toBe("interrupted");
    expect(getTask(task.id)?.state).toBe("stuck");
    await expect(submitTaskMessage(getTask(task.id)!, "must wait", def, cfg)).rejects.toThrow("Stopping");
    expect(await archiveTaskRows([getTask(task.id)!], true, cfg)).toMatchObject({ status: 409 });
    await interruptTurn(task.id, 100);
    expect(getTask(task.id)?.state).toBe("needs-input");
    const next = await submitTaskMessage(getTask(task.id)!, "safe now", def, cfg);
    expect(next.disposition).toBe("started");
    await until(() => hasRunningTurn(task.id) === null);
  }, 10_000);

  test("waits for a resistant child after its leader exits before finalizing or starting queued work", async () => {
    const task = makeTask("leader-exits");
    const pidFile = join(task.worktree_path!, "child.pid");
    const nextFile = join(task.worktree_path!, "next.started");
    const def = bashAdapter([
      'if [ -f child.pid ]; then',
      '  if kill -0 "$(cat child.pid)" 2>/dev/null; then echo overlap > next.started; else echo safe > next.started; fi',
      '  exit 0',
      'fi',
      // Readiness is written AFTER the child's trap is installed. The leader
      // deliberately has no trap and exits promptly when Stop sends TERM.
      `sh -c 'trap "" TERM; echo $$ > child.pid; while :; do sleep 1; done' &`,
      'wait',
    ].join('\n'));
    startTurn(task, "start work", def, cfg);
    const turn = hasRunningTurn(task.id)!;
    fixtureGroups.push(turn.pid!);
    const descendant = await recordedPid(pidFile);

    // Ordinary sending queues without stopping either process.
    const queued = await submitTaskMessage(getTask(task.id)!, "next work", def, cfg);
    expect(queued.disposition).toBe("queued-next");
    expect(alive(turn.pid!)).toBe(true);
    expect(alive(descendant)).toBe(true);

    const stopping = interruptTurn(task.id, 1000);
    // Attach a handler immediately so a regression cannot leak a rejection.
    void stopping.catch(() => {});
    await until(() => !alive(turn.pid!));
    expect(alive(descendant)).toBe(true);
    expect(hasRunningTurn(task.id)?.id).toBe(turn.id);
    expect(getTask(task.id)?.state_detail).toContain("Stopping");
    expect(existsSync(nextFile)).toBe(false);
    await expect(submitTaskMessage(getTask(task.id)!, "racing send", def, cfg)).rejects.toThrow("Stopping");

    await Promise.all([stopping, interruptTurn(task.id, 1000)]);
    expect(alive(descendant)).toBe(false);
    expect(processGroupAlive(turn.pid!)).toBe(false);
    expect(turnsFor(task.id)[0]?.status).toBe("interrupted");
    expect(turnsFor(task.id)[0]?.interrupt_detail).toContain("escalated to SIGKILL");
    await until(() => existsSync(nextFile));
    expect(readFileSync(nextFile, "utf8").trim()).toBe("safe");
    await until(() => hasRunningTurn(task.id) === null);
  }, 15_000);

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
   * The log-cap kill, which is the stop path that runs while THIS daemon owns
   * the child — the common case for a non-recorder turn. It was the one stop
   * path still signalling only the leader after the rest were fixed (a review
   * caught it): the harness's own children are what filled the log, so killing
   * the leader alone leaves them writing to the log it was killed for.
   */
  test("a cap kill stops the children that filled the log", async () => {
    const task = makeTask("cap");
    const pidFile = join(task.worktree_path!, "child.pid");
    // Over the budget in one write, then a descendant that would outlive a
    // leader-only kill. `capTick` polls every 5s, so this waits for one tick.
    const harness = bashAdapter(
      `head -c 4000 /dev/zero | tr '\\0' 'x'; sleep 30 & echo $! > ${JSON.stringify(pidFile)}; wait`,
    );
    startTurn(task, "fill the log", harness, { ...cfg, logMaxBytes: 1_000, turnTranscriptBytes: 1_000 });
    await until(() => hasRunningTurn(task.id) !== null);
    const grandchild = await recordedPid(pidFile);

    await until(() => !alive(grandchild), 20_000);
    await until(() => hasRunningTurn(task.id) === null);
    expect(getTask(task.id)?.state_detail ?? "").toContain("log cap exceeded");
  }, 40_000);

  /**
   * A finished turn can leave verified background work. Force-archive must
   * stop that work before deleting files, even without a live harness.
   */
  test("force-archive stops a finished turn's verified surviving group", async () => {
    const task = makeTask("survivor");
    const pidFile = join(task.worktree_path!, "child.pid");
    // The harness exits immediately; its child keeps the GROUP alive, having
    // been detached from the pipe so nothing waits on it.
    startTurn(
      task,
      "leave something behind",
      bashAdapter(`sleep 30 >/dev/null 2>&1 & echo $! > ${JSON.stringify(pidFile)}; exit 0`),
      cfg,
    );
    const grandchild = await recordedPid(pidFile);
    await until(() => hasRunningTurn(task.id) === null, 15_000);
    expect(alive(grandchild)).toBe(true);

    await killTurnForArchive(task.id, 500);
    expect(alive(grandchild)).toBe(false);
  }, 40_000);

  test("a host reboot invalidates old process identities even when PID and start ticks match", async () => {
    const task = makeTask("previous-boot");
    const unrelated = Bun.spawn({ cmd: ["sh", "-c", "sleep 30"], stdout: "ignore", stderr: "ignore", detached: true });
    fixtureGroups.push(unrelated.pid);
    const log = join(task.worktree_path!, "turn.out.log");
    writeFileSync(log, "old result");
    const turnId = createTurn(task.id, 1, "old turn", unrelated.pid, log, processStartTime(unrelated.pid));
    recordProcessGroup(turnId);
    db.query("UPDATE turn_process_groups SET boot_id = 'previous-boot' WHERE turn_id = ?").run(turnId);
    setTurnInterrupt(turnId, STOPPING);
    transition(task.id, "running", STOPPING);
    await recoverOrphanedTurns({ fake: bashAdapter("true") }, cfg);
    expect(hasRunningTurn(task.id)).toBeNull();
    await interruptTurn(task.id, 50);
    expect(alive(unrelated.pid)).toBe(true);
    expect(backgroundWork(task.id).state).toBe("none");
    signalProcessGroup(unrelated.pid, "SIGKILL");
    await unrelated.exited;
  }, 10_000);

  test("a mismatched process-group leader is not signalled or treated as safe for deletion", async () => {
    const task = makeTask("reused-group");
    const unrelated = Bun.spawn({ cmd: ["sh", "-c", "sleep 30"], stdout: "ignore", stderr: "ignore", detached: true });
    fixtureGroups.push(unrelated.pid);
    const turnId = createTurn(task.id, 1, "old turn", unrelated.pid, "/dev/null", "old-start-time");
    recordProcessGroup(turnId);
    finishTurn(turnId, "done", 0, "old result");
    transition(task.id, "done", "old result");
    await expect(interruptTurn(task.id, 50)).rejects.toThrow("ownership is uncertain");
    expect(alive(unrelated.pid)).toBe(true);
    expect(backgroundWork(task.id).state).toBe("unknown");
    await expect(assertTaskProcessesEnded(task.id)).rejects.toThrow("unverified");
    signalProcessGroup(unrelated.pid, "SIGKILL");
    await unrelated.exited;
  }, 10_000);

  test("unverified background ownership refuses Stop and archive without signalling the group", async () => {
    const task = makeTask("unverified-background");
    const def = bashAdapter('sleep 30 </dev/null >/dev/null 2>&1 & echo $! > child.pid; exit 0');
    startTurn(task, "start watcher", def, cfg);
    const turn = hasRunningTurn(task.id)!;
    fixtureGroups.push(turn.pid!);
    const descendant = await recordedPid(join(task.worktree_path!, "child.pid"));
    await until(() => hasRunningTurn(task.id) === null);
    expect(backgroundWork(task.id).state).toBe("running");
    // Simulate a persisted identity that no longer matches any living member.
    db.query("UPDATE turn_process_groups SET members_json = ? WHERE turn_id = ?")
      .run(JSON.stringify([{ pid: descendant, started: "different-start-time" }]), turn.id);
    await refreshProcessGroups(task.id);
    expect(backgroundWork(task.id).state).toBe("unknown");
    const kill = process.kill.bind(process);
    const signals: number[] = [];
    const observed = spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (signal !== 0) signals.push(pid);
      return kill(pid, signal);
    });
    try {
      await expect(interruptTurn(task.id, 50)).rejects.toThrow("ownership is uncertain");
      await expect(assertTaskProcessesEnded(task.id)).rejects.toThrow("unverified");
      expect(await archiveTaskRows([getTask(task.id)!], true, cfg)).toMatchObject({ status: 409 });
      await expect(submitTaskMessage(getTask(task.id)!, "must wait", def, cfg)).rejects.toThrow("Stop is incomplete");
      expect(signals).toEqual([]);
      expect(alive(descendant)).toBe(true);
      expect(getTask(task.id)?.archived).toBe(0);
    } finally { observed.mockRestore(); }
    // Once independently stopped, retry confirms absence and reopens sending.
    signalProcessGroup(turn.pid!, "SIGKILL");
    await until(() => !alive(descendant));
    await interruptTurn(task.id, 50);
    expect(backgroundWork(task.id).state).toBe("none");
    expect(getTask(task.id)?.state).toBe("done");
  }, 10_000);

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
