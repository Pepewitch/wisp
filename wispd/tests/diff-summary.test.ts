import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiffSummary } from "../../shared/api/task";
import { type WispConfig } from "../src/config";
import { route } from "../src/daemon";
import { createTask, freeSlot, newTaskId, setTaskFields } from "../src/store";
import { testRouteContext } from "./helpers/daemon-context";

/**
 * GET /api/tasks/:id/diff/summary is the top bar's file count. It has to
 * agree with what the Changes pane counts from the full diff, which is one
 * file per `diff --git` header (untracked files arrive as synthetic new-file
 * patches), or the hint and the pane would disagree about the same task.
 */

const cfg: WispConfig = {
  instanceId: "123e4567-e89b-42d3-a456-426614174000",
  port: 0,
  host: "127.0.0.1",
  token: "diff-summary-token",
  webhooks: [],
  repos: [],
  stuckMinutes: 10,
  logMaxBytes: 5_000_000,
  setupTimeoutMinutes: 10,
  envAllowlist: {},
  harnessDefaults: {},
};

function call(path: string): Response | Promise<Response> {
  const url = new URL(`http://wisp.test${path}`);
  return route(new Request(url), url, url.pathname, testRouteContext(cfg, {}));
}

async function body<T>(res: Response | Promise<Response>): Promise<T> {
  return (await (await res).json()) as T;
}

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function sh(cmd: string[], cwd: string): string {
  const p = Bun.spawnSync({ cmd, cwd, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`${cmd.join(" ")}: ${p.stderr.toString()}`);
  return p.stdout.toString().trim();
}

const commit = (repo: string, message: string) =>
  sh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", message], repo);

/** A repo with four committed files; returns it and the base commit. */
function makeRepo(): { path: string; base: string } {
  const path = mkdtempSync(join(tmpdir(), "wisp-diff-summary-"));
  dirs.push(path);
  sh(["git", "init", "-q"], path);
  writeFileSync(join(path, ".gitignore"), "ignored.log\n");
  for (const name of ["keep.ts", "edit.ts", "gone.ts", "move.ts"]) {
    writeFileSync(join(path, name), `export const ${name.split(".")[0]} = ${"1;\n".repeat(20)}`);
  }
  sh(["git", "add", "."], path);
  commit(path, "init");
  return { path, base: sh(["git", "rev-parse", "HEAD"], path) };
}

function makeTask(fields: Parameters<typeof setTaskFields>[1], mode?: "local") {
  const task = createTask({ id: newTaskId(), title: "diff summary", repo_path: "/tmp/repo", harness: "fake", model: null, mode, slot: freeSlot() });
  setTaskFields(task.id, fields);
  return task;
}

/** What the Changes pane counts from the full diff. */
async function paneCount(id: string): Promise<number> {
  const full = await body<{ diff: string; truncated: boolean }>(call(`/api/tasks/${id}/diff`));
  expect(full.truncated).toBe(false);
  return full.diff.split("\n").filter((line) => line.startsWith("diff --git ")).length;
}

describe("GET /api/tasks/:id/diff/summary", () => {
  test("counts committed, staged, unstaged, deleted, renamed and untracked files as the full diff does", async () => {
    const repo = makeRepo();
    // committed on the task's branch since its base
    writeFileSync(join(repo.path, "added.ts"), "export const added = 1;\n");
    sh(["git", "add", "added.ts"], repo.path);
    commit(repo.path, "add");
    // unstaged edit, a deletion and a rename the index knows about
    writeFileSync(join(repo.path, "edit.ts"), "export const edit = 2;\n");
    unlinkSync(join(repo.path, "gone.ts"));
    sh(["git", "mv", "move.ts", "moved.ts"], repo.path);
    // untracked, one of them nested, plus an ignored file that counts for nothing
    writeFileSync(join(repo.path, "notes.md"), "notes\n");
    mkdirSync(join(repo.path, "docs"));
    writeFileSync(join(repo.path, "docs", "plan.md"), "plan\n");
    writeFileSync(join(repo.path, "ignored.log"), "noise\n");
    const task = makeTask({ worktree_path: repo.path, base_commit: repo.base });

    const response = await call(`/api/tasks/${task.id}/diff/summary`);
    expect(response.status).toBe(200);
    const summary = await body<DiffSummary>(response);
    // added, edit, gone, the rename as one file, notes.md, docs/plan.md
    expect(summary).toEqual({ files: 6, worktreeReason: null });
    expect(summary.files).toBe(await paneCount(task.id));
  });

  test("a local task counts against HEAD, not its stale creation commit", async () => {
    const repo = makeRepo();
    // the human committed in their own checkout after the task began
    writeFileSync(join(repo.path, "landed.ts"), "export const landed = 1;\n");
    sh(["git", "add", "landed.ts"], repo.path);
    commit(repo.path, "landed");
    writeFileSync(join(repo.path, "keep.ts"), "export const keep = 2;\n");
    const task = makeTask({ worktree_path: repo.path, base_commit: repo.base }, "local");

    expect(await body<DiffSummary>(call(`/api/tasks/${task.id}/diff/summary`))).toEqual({ files: 1, worktreeReason: null });
    expect(await paneCount(task.id)).toBe(1);
  });

  test("a file dropped from the index but left on disk counts once", async () => {
    const repo = makeRepo();
    sh(["git", "rm", "-q", "--cached", "keep.ts"], repo.path);
    const task = makeTask({ worktree_path: repo.path, base_commit: repo.base });
    const summary = await body<DiffSummary>(call(`/api/tasks/${task.id}/diff/summary`));
    // the pane drops the diff's deletion of a path it also lists as untracked
    const full = await body<{ untracked: string[] }>(call(`/api/tasks/${task.id}/diff`));
    expect(full.untracked).toEqual(["keep.ts"]);
    expect(summary).toEqual({ files: 1, worktreeReason: null });
  });

  test("a clean worktree is zero", async () => {
    const repo = makeRepo();
    const task = makeTask({ worktree_path: repo.path, base_commit: repo.base });
    expect(await body<DiffSummary>(call(`/api/tasks/${task.id}/diff/summary`))).toEqual({ files: 0, worktreeReason: null });
  });

  test("a worktree git cannot read is a 200 with the reason, as the full diff answers", async () => {
    const missing = join(tmpdir(), `wisp-diff-summary-gone-${newTaskId()}`);
    const task = makeTask({ worktree_path: missing, base_commit: "0".repeat(40) });
    const summary = await body<DiffSummary>(call(`/api/tasks/${task.id}/diff/summary`));
    const full = await body<{ worktreeReason: string | null }>(call(`/api/tasks/${task.id}/diff`));
    expect(summary.files).toBe(0);
    expect(summary.worktreeReason).not.toBeNull();
    expect(summary.worktreeReason).toBe(full.worktreeReason);
  });

  test("refuses as the full diff does: unknown task, no worktree, archived", async () => {
    const missing = await call("/api/tasks/tnope9/diff/summary");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "no such task: tnope9" });

    const noWorktree = makeTask({});
    const unset = await call(`/api/tasks/${noWorktree.id}/diff/summary`);
    expect(unset.status).toBe(409);
    expect(await unset.json()).toEqual({ error: "task has no worktree (failed before setup?)" });

    const repo = makeRepo();
    const archived = makeTask({ worktree_path: repo.path, archived: 1 });
    const gone = await call(`/api/tasks/${archived.id}/diff/summary`);
    expect(gone.status).toBe(409);
    expect(await gone.json()).toEqual({ error: "task is archived — worktree removed" });
  });
});
