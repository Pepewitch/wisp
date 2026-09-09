/**
 * Archive teardown as a durable job (ENG-04).
 *
 * Two defects are under test, both from a review. The teardown collected stop
 * failures and then deleted the worktree anyway — files removed under a live
 * process. And it was a detached promise, so a daemon that died mid-teardown
 * left a worktree and attachment bytes that no row admitted to owning.
 *
 * So: a failing stage must STOP the sequence and leave the job behind, and a
 * job resumed from any stage must converge without destroying anything else.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { WispConfig } from "../src/config";
import { route } from "../src/daemon";
import { resumeArchiveCleanups } from "../src/routes/archive";
import {
  ARCHIVE_STAGES,
  archiveCleanup,
  archiveTaskWithCleanup,
  clearArchiveCleanup,
  pendingArchiveCleanups,
  type ArchiveStage,
} from "../src/archive-jobs";
import {
  createTask,
  createTurn,
  finishTurn,
  freeSlot,
  getTask,
  newTaskId,
  setTaskFields,
  transition,
} from "../src/store";
import { createWorktree } from "../src/worktree";

const token = "archive-cleanup-token";

/**
 * Each case owns its own jobs. Without this, the fail-closed case leaves a
 * pending row and every later `resumeArchiveCleanups()` retries it — CI logged
 * the same git failure dozens of times during unrelated cases (a review's
 * note), which makes the suite's output lie about what is failing.
 */
afterEach(() => {
  for (const job of pendingArchiveCleanups()) clearArchiveCleanup(job.task_id);
});

function cfg(repos: WispConfig["repos"] = []): WispConfig {
  return {
    instanceId: "123e4567-e89b-42d3-a456-426614174000",
    port: 0,
    host: "127.0.0.1",
    token,
    webhooks: [],
    repos,
    stuckMinutes: 10,
    logMaxBytes: 5_000_000,
    setupTimeoutMinutes: 10,
    envAllowlist: {},
    harnessDefaults: {},
  };
}

function call(path: string, init?: RequestInit, repos: WispConfig["repos"] = []): Response | Promise<Response> {
  const url = new URL(`http://wisp.test${path}`);
  const headers = { authorization: `Bearer ${token}`, ...(init?.body ? { "content-type": "application/json" } : {}) };
  return route(new Request(url, { ...init, headers }), url, url.pathname, cfg(repos), {});
}

function sh(cmd: string[], cwd: string): string {
  const p = Bun.spawnSync({ cmd, cwd, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`${cmd.join(" ")}: ${p.stderr.toString()}`);
  return p.stdout.toString().trim();
}

function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "wisp-cleanup-repo-"));
  sh(["git", "init", "-q"], repo);
  writeFileSync(join(repo, "README.md"), "hi\n");
  sh(["git", "add", "."], repo);
  sh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init"], repo);
  return repo;
}

async function eventually(what: string, predicate: () => boolean, ms = 8_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(50);
  }
}

interface Fixture {
  id: string;
  repo: string;
  worktree: string;
  branch: string;
  baseCommit: string;
  attachmentDir: string;
}

/**
 * A finished task on a healthy worktree, with attachment bytes on disk so the
 * LAST cleanup stage has something observable to do — which is how the
 * ordering assertions can tell "stopped early" from "did everything".
 */
async function finishedTask(repoPath?: string): Promise<Fixture> {
  const repo = makeRepo();
  const id = newTaskId();
  const wt = await createWorktree(repo, id, cfg());
  const task = createTask({
    id,
    title: "cleanup fixture",
    repo_path: repoPath ?? repo,
    harness: "fake",
    model: null,
    slot: freeSlot(),
  });
  setTaskFields(task.id, { worktree_path: wt.path, branch: wt.branch, base_commit: wt.base_commit });
  transition(task.id, "done", "wrapped up");
  // tasks/<id>/attachments — the tree removeTaskAttachments deletes
  const attachmentDir = join(process.env.WISP_HOME!, "tasks", id, "attachments");
  mkdirSync(attachmentDir, { recursive: true });
  writeFileSync(join(attachmentDir, "shot.png"), "not really a png");
  return { id, repo, worktree: wt.path, branch: wt.branch, baseCommit: wt.base_commit, attachmentDir };
}

describe("a successful archive owns its teardown and then lets go of it", () => {
  test("the job exists with the flip and is gone once cleanup finishes", async () => {
    const fixture = await finishedTask();

    const response = await call(`/api/tasks/${fixture.id}/archive`, { method: "POST", body: "{}" });
    expect(response.status).toBe(200);
    expect(getTask(fixture.id)!.archived).toBe(1);

    await eventually("the teardown to finish", () => archiveCleanup(fixture.id) === null);
    expect(existsSync(fixture.worktree)).toBe(false);
    expect(existsSync(fixture.attachmentDir)).toBe(false);
    // the branch is user work and is never part of teardown
    expect(sh(["git", "branch", "--list", fixture.branch], fixture.repo)).toContain(fixture.branch);
  }, 20_000);
});

describe("a failing stage stops the sequence", () => {
  /**
   * The review's fail-closed case, with a real failure rather than an
   * injected one: the task's `repo_path` is not a git repository, so
   * `git worktree remove` cannot run. Everything after that stage deletes
   * something, so nothing after it may run.
   */
  test("the worktree and the attachments are both kept, and the job says why", async () => {
    const notARepo = mkdtempSync(join(tmpdir(), "wisp-cleanup-not-a-repo-"));
    const fixture = await finishedTask(notARepo);

    const response = await call(`/api/tasks/${fixture.id}/archive`, { method: "POST", body: "{}" });
    expect(response.status).toBe(200); // the refusals all passed; this failure is later

    await eventually("the failure to be recorded", () => archiveCleanup(fixture.id)?.last_error !== null);
    const job = archiveCleanup(fixture.id)!;
    expect(job.stage).toBe("remove-worktree");
    expect(job.last_error).toContain("worktree teardown failed");
    expect(job.attempts).toBeGreaterThan(0);

    // Fail-closed: the files are still there, and the NEXT stage never ran.
    expect(existsSync(fixture.worktree)).toBe(true);
    expect(existsSync(fixture.attachmentDir)).toBe(true);
    expect(getTask(fixture.id)!.state_detail).toContain("Cleanup is incomplete and will be retried");
  }, 20_000);

  /**
   * The ORIGINAL defect, which the repo_path case only proves by proxy: the
   * stop failed and the deletion ran anyway. Here the stop itself fails — the
   * job says a turn must be killed, and the turn's row says it is running with
   * a pid nothing can signal — so `killTurnForArchive` throws and every
   * destructive stage after it must be skipped (a review's note).
   */
  test("a stop that fails keeps the worktree and the attachments", async () => {
    const fixture = await finishedTask();
    // A running turn whose pid cannot be signalled: force-archive will try to
    // kill it, fail, and must not proceed to the removals.
    const turnId = createTurn(fixture.id, 1, "unstoppable", 0x7fffffff, "/dev/null", null, null);
    transition(fixture.id, "running", "turn 1");

    archiveTaskWithCleanup(fixture.id, null, {
      task_id: fixture.id,
      stage: "stop-turn",
      force: true,
      stop_turn: true,
      removable: true,
      repo_path: fixture.repo,
      worktree_path: fixture.worktree,
      branch: fixture.branch,
      archive_script: null,
      timeout_minutes: 5,
    });

    await resumeArchiveCleanups();

    const job = archiveCleanup(fixture.id);
    expect(job).not.toBeNull();
    expect(job!.stage).toBe("stop-turn");
    expect(job!.last_error).toContain("could not stop the running turn");
    // Fail-closed: nothing destructive ran behind the failed stop.
    expect(existsSync(fixture.worktree)).toBe(true);
    expect(existsSync(fixture.attachmentDir)).toBe(true);
    expect(getTask(fixture.id)!.state_detail).toContain("Cleanup is incomplete");

    finishTurn(turnId, "failed", null, null);
  }, 30_000);

  test("a retry after the cause is fixed converges and clears the job", async () => {
    const notARepo = mkdtempSync(join(tmpdir(), "wisp-cleanup-fixable-"));
    const fixture = await finishedTask(notARepo);
    await call(`/api/tasks/${fixture.id}/archive`, { method: "POST", body: "{}" });
    await eventually("the first failure", () => archiveCleanup(fixture.id)?.last_error !== null);

    // What an operator repairing this would do: point the job at the real repo.
    const job = archiveCleanup(fixture.id)!;
    archiveTaskWithCleanup(fixture.id, null, { ...job, repo_path: fixture.repo });
    await resumeArchiveCleanups();

    expect(archiveCleanup(fixture.id)).toBeNull();
    expect(existsSync(fixture.worktree)).toBe(false);
    expect(existsSync(fixture.attachmentDir)).toBe(false);
    expect(getTask(fixture.id)!.state_detail).toContain("has now finished");
  }, 20_000);
});

describe("a job resumed after a crash converges from whatever stage it reached", () => {
  /**
   * One case per stage: the daemon is presumed to have died with the job
   * checkpointed there, and the resume has to finish the rest without needing
   * the stages before it.
   */
  for (const stage of ARCHIVE_STAGES) {
    test(`resuming at ${stage} finishes the teardown`, async () => {
      const fixture = await finishedTask();
      archiveTaskWithCleanup(fixture.id, null, {
        task_id: fixture.id,
        stage: stage as ArchiveStage,
        force: false,
        stop_turn: false,
        removable: true,
        repo_path: fixture.repo,
        worktree_path: fixture.worktree,
        branch: fixture.branch,
        archive_script: null,
        timeout_minutes: 5,
      });

      await resumeArchiveCleanups();

      expect(archiveCleanup(fixture.id)).toBeNull();
      // A resume starts AT its checkpoint, so a job already past the worktree
      // stage does not go back for it — the point is convergence to "no job
      // left", not repeating work a previous daemon finished.
      if (stage !== "remove-attachments") expect(existsSync(fixture.worktree)).toBe(false);
      // …and the LAST stage always runs, whichever one the job resumed at
      expect(existsSync(fixture.attachmentDir)).toBe(false);
      expect(getTask(fixture.id)!.archived).toBe(1);
    }, 20_000);
  }

  test("a resumed job runs the archive hook the archive was configured with", async () => {
    const fixture = await finishedTask();
    const marker = join(mkdtempSync(join(tmpdir(), "wisp-cleanup-hook-")), "ran.txt");
    // The project is NOT in the config any more — it was removed after the
    // archive. The hook still has to run, because it is on the job.
    archiveTaskWithCleanup(fixture.id, null, {
      task_id: fixture.id,
      stage: "remove-worktree",
      force: false,
      stop_turn: false,
      removable: true,
      repo_path: fixture.repo,
      worktree_path: fixture.worktree,
      branch: fixture.branch,
      archive_script: `echo ran > ${marker}`,
      timeout_minutes: 5,
    });

    await resumeArchiveCleanups();

    expect(existsSync(marker)).toBe(true);
    expect(existsSync(fixture.worktree)).toBe(false);
    expect(archiveCleanup(fixture.id)).toBeNull();
  }, 20_000);

  test("a job with nothing left to remove settles instead of retrying forever", async () => {
    const fixture = await finishedTask();
    archiveTaskWithCleanup(fixture.id, null, {
      task_id: fixture.id,
      stage: "remove-attachments",
      force: false,
      stop_turn: false,
      removable: false,
      repo_path: fixture.repo,
      worktree_path: null,
      branch: null,
      archive_script: null,
      timeout_minutes: 5,
    });

    await resumeArchiveCleanups();
    expect(archiveCleanup(fixture.id)).toBeNull();
  }, 20_000);
});
