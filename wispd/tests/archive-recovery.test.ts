import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { archiveCleanup, archiveTaskWithCleanup, clearArchiveCleanup, pendingArchiveCleanups } from "../src/archive-jobs";
import { cleanupProgress, recoverCleanupProgress, updateProgress } from "../src/archive-progress";
import { resumeArchiveCleanups } from "../src/archive-worker";
import { route } from "../src/daemon";
import { loadConfig } from "../src/config";
import { createTask, db, freeSlot, getTask, newTaskId, setTaskFields } from "../src/store";
import { createWorktree } from "../src/worktree";
import { runBounded } from "../src/subprocess";

afterEach(async () => {
  await resumeArchiveCleanups();
  for (const job of pendingArchiveCleanups()) clearArchiveCleanup(job.task_id);
});

async function fixture(script?: string, badRepo = false) {
  const repo = mkdtempSync(join(tmpdir(), "wisp-recovery-"));
  for (const args of [["init", "-b", "main"], ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "Fixture"]]) {
    const result = Bun.spawnSync(["git", ...args], { cwd: repo });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
  }
  const id = newTaskId();
  const cfg = loadConfig();
  const wt = await createWorktree(repo, id, cfg);
  createTask({ id, title: "Cleanup recovery", repo_path: repo, harness: "fake", model: null, slot: freeSlot() });
  setTaskFields(id, { state: "done", worktree_path: wt.path, branch: wt.branch, base_commit: wt.base_commit });
  archiveTaskWithCleanup(id, null, { task_id: id, stage: "stop-turn", force: true, stop_turn: false,
    removable: true, repo_path: badRepo ? mkdtempSync(join(tmpdir(), "wisp-no-repo-")) : repo,
    worktree_path: wt.path, branch: wt.branch, archive_script: script?.replaceAll("TASKID", id) ?? null, timeout_minutes: 1 });
  return { id, repo, path: wt.path, count: join(process.env.WISP_HOME!, `${id}-effects`) };
}

async function call(id: string, action: string, revision = cleanupProgress(id)!.revision, extra = {}) {
  const url = new URL(`http://fixture.test/api/tasks/${id}/cleanup`);
  return await route(new Request(url, { method: "POST", body: JSON.stringify({ action, revision, ...extra }) }), url, url.pathname, loadConfig(), {});
}

test("successful hooks are not repeated after a later Git failure, and retries back off", async () => {
  const f = await fixture('echo effect >> "$WISP_HOME/TASKID-effects"', true);
  await resumeArchiveCleanups();
  expect(cleanupProgress(f.id)?.phase).toBe("remove-worktree");
  expect(cleanupProgress(f.id)?.status).toBe("pending");
  expect(cleanupProgress(f.id)?.next_retry_at).not.toBeNull();
  expect(readFileSync(f.count, "utf8")).toBe("effect\n");
  const attempts = archiveCleanup(f.id)!.attempts;
  await resumeArchiveCleanups();
  expect(archiveCleanup(f.id)!.attempts).toBe(attempts);
  db.query("UPDATE archive_cleanups SET repo_path = ? WHERE task_id = ?").run(f.repo, f.id);
  expect((await call(f.id, "retry")).status).toBe(202);
  await resumeArchiveCleanups();
  expect(archiveCleanup(f.id)).toBeNull();
  expect(existsSync(f.path)).toBe(false);
  expect(readFileSync(f.count, "utf8")).toBe("effect\n");
});

test("a partially failed hook preserves files and needs an explicit decision, protected against stale clients", async () => {
  const f = await fixture('echo effect >> "$WISP_HOME/TASKID-effects"; echo "fixture failure" >&2; exit 7');
  await resumeArchiveCleanups();
  expect(cleanupProgress(f.id)?.status).toBe("needs-attention");
  expect(existsSync(f.path)).toBe(true);
  expect(archiveCleanup(f.id)?.last_error).toContain("partially completed");
  const revision = cleanupProgress(f.id)!.revision;
  expect((await call(f.id, "retry")).status).toBe(409);
  await resumeArchiveCleanups();
  expect(readFileSync(f.count, "utf8")).toBe("effect\n");
  expect((await call(f.id, "rerun", revision)).status).toBe(202);
  await resumeArchiveCleanups();
  expect(readFileSync(f.count, "utf8")).toBe("effect\neffect\n");
  expect((await call(f.id, "confirm", revision)).status).toBe(409);
  expect((await call(f.id, "confirm")).status).toBe(202);
  await resumeArchiveCleanups();
  expect(archiveCleanup(f.id)).toBeNull();
  expect(readFileSync(f.count, "utf8")).toBe("effect\neffect\n");
});

test("repeated archive requests cannot erase a hook's uncertain checkpoint", async () => {
  const f = await fixture('echo effect >> "$WISP_HOME/TASKID-effects"; exit 1');
  await resumeArchiveCleanups();
  const before = cleanupProgress(f.id);
  const url = new URL(`http://fixture.test/api/tasks/${f.id}/archive`);
  expect((await route(new Request(url, { method: "POST", body: "{}" }), url, url.pathname, loadConfig(), {})).status).toBe(200);
  await resumeArchiveCleanups();
  expect(cleanupProgress(f.id)).toEqual(before);
  expect(readFileSync(f.count, "utf8")).toBe("effect\n");
});

test("permanent safe-step failures stop automatic retries with a remedy", async () => {
  const f = await fixture(undefined, true);
  for (let attempt = 0; attempt < 5; attempt++) {
    db.query("UPDATE archive_cleanup_progress SET next_retry_at = NULL WHERE task_id = ?").run(f.id);
    await resumeArchiveCleanups();
  }
  expect(cleanupProgress(f.id)?.status).toBe("needs-attention");
  expect(archiveCleanup(f.id)?.attempts).toBe(5);
  expect(archiveCleanup(f.id)?.last_error).toContain("Retry cleanup");
  await resumeArchiveCleanups();
  expect(archiveCleanup(f.id)?.attempts).toBe(5);
  expect(existsSync(f.path)).toBe(true);
});

test("legacy uncertain scripts require confirmation that both scripts and their children stopped", async () => {
  const f = await fixture('echo effect >> "$WISP_HOME/TASKID-effects"');
  updateProgress(f.id, { phase: "legacy-hooks", status: "needs-attention" });
  expect((await call(f.id, "confirm")).status).toBe(409);
  expect((await call(f.id, "confirm", cleanupProgress(f.id)!.revision, { confirmStopped: true })).status).toBe(202);
  await resumeArchiveCleanups();
  expect(archiveCleanup(f.id)).toBeNull();
  expect(existsSync(f.count)).toBe(false);
});

test("the launch gate never executes a command if its durable ownership record fails", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wisp-hook-gate-"));
  await expect(runBounded({ cmd: ["bash", "-c", "touch effect"], cwd: dir,
    beforeStart: () => { throw new Error("fixture database write failed"); } })).rejects.toThrow("fixture database write failed");
  expect(existsSync(join(dir, "effect"))).toBe(false);
});

test("recovery distinguishes a hook before its launch gate from a hook with an unknown result", async () => {
  const first = await fixture();
  const second = await fixture();
  updateProgress(first.id, { phase: "project-hook", status: "running", hook_pgid: null });
  updateProgress(second.id, { phase: "project-hook", status: "running", hook_pgid: 123 });
  recoverCleanupProgress();
  expect(cleanupProgress(first.id)?.status).toBe("pending");
  expect(cleanupProgress(second.id)?.status).toBe("needs-attention");
  expect(getTask(second.id)?.archived).toBe(1);
});

test("repository and project hooks keep their order and repository script path semantics", async () => {
  const f = await fixture('echo project >> "$WISP_HOME/TASKID-effects"');
  mkdirSync(join(f.path, ".wisp"));
  writeFileSync(join(f.path, ".wisp", "value"), "repo\n");
  writeFileSync(join(f.path, ".wisp", "cleanup.sh"), `cat "$(dirname "\${BASH_SOURCE[0]}")/value" >> "$WISP_HOME/${f.id}-effects"`);
  await resumeArchiveCleanups();
  expect(readFileSync(f.count, "utf8")).toBe("repo\nproject\n");
  expect(existsSync(f.path)).toBe(false);
});

test("a timed-out hook is stopped and its workspace remains available for recovery", async () => {
  const f = await fixture("sleep 30");
  db.query("UPDATE archive_cleanups SET timeout_minutes = 0.001 WHERE task_id = ?").run(f.id);
  const started = Date.now();
  await resumeArchiveCleanups();
  expect(Date.now() - started).toBeLessThan(5000);
  expect(cleanupProgress(f.id)?.status).toBe("needs-attention");
  expect(archiveCleanup(f.id)?.last_error).toContain("timed out");
  expect(existsSync(f.path)).toBe(true);
});
