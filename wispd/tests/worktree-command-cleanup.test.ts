import { expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as subprocess from "../src/subprocess";
import { CommandGroup } from "../src/command-group";
import { worktreeHealth } from "../src/worktree";

test("incomplete Git cleanup is an error, not evidence that a worktree can be forgotten", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wisp-git-cleanup-refusal-"));
  const run = spyOn(subprocess, "runBounded").mockResolvedValue({
    exitCode: null, out: "", err: "", truncated: true, timedOut: false, cancelled: false,
    cleanupError: "command cleanup incomplete: fixture ownership uncertain",
  });
  try {
    await expect(worktreeHealth(dir)).rejects.toThrow("git rev-parse: command cleanup incomplete: fixture ownership uncertain");
  } finally { run.mockRestore(); }
}, 10_000);

test("a confirmed timeout is reported instead of claiming Git forgot the worktree", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wisp-git-timeout-"));
  const run = spyOn(subprocess, "runBounded").mockResolvedValue({
    exitCode: 0, out: "", err: "", truncated: false, timedOut: true, cancelled: false,
  });
  try {
    await expect(worktreeHealth(dir)).rejects.toThrow("git rev-parse timed out after 20s and was stopped");
  } finally { run.mockRestore(); }
});

test("a reaped command cannot grant permission to signal a new leader with the same numeric PID", async () => {
  const unrelated = Bun.spawn({ cmd: ["sh", "-c", "sleep 30"], stdout: "ignore", stderr: "ignore", detached: true });
  const oldHandle = { pid: unrelated.pid, exitCode: 0, signalCode: null } as ReturnType<typeof Bun.spawn>;
  const group = new CommandGroup(oldHandle);
  const kill = process.kill.bind(process);
  const sent: number[] = [];
  const observed = spyOn(process, "kill").mockImplementation((pid, signal) => {
    if (signal !== 0) sent.push(pid);
    return kill(pid, signal);
  });
  try {
    await expect(group.captureExit()).rejects.toThrow("ownership could not be verified");
    await expect(group.inspect("SIGKILL")).rejects.toThrow("ownership could not be verified");
    expect(sent).toEqual([]);
    expect(unrelated.exitCode).toBeNull();
  } finally {
    observed.mockRestore();
    group.close();
    try { process.kill(-unrelated.pid, "SIGKILL"); } catch { /* already exited */ }
    await unrelated.exited;
  }
});
