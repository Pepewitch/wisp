import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { route } from "../src/daemon";
import { type WispConfig } from "../src/config";
import { createTask, freeSlot, getTask, newTaskId, setTaskFields, transition } from "../src/store";
import { createWorktree } from "../src/worktree";

/**
 * D1 + D3 + D4 at the HTTP boundary: what the three read surfaces say about a
 * worktree git has forgotten, and what archive does about it.
 *
 * The reported failure shape: `~/.wisp/worktrees/sample-app-tk9zdy`
 * exists and is full of files, has no `.git` at all, and the parent repo no
 * longer lists it. `/api/status` reported the task perfectly clean, the diff
 * pane rendered git's `--no-index` warning plus ~40 lines of usage text, and
 * archive 409'd forever so the row could not be cleared.
 */

const token = "worktree-health-token";

function cfg(repos: WispConfig["repos"] = []): WispConfig {
  return {
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

/** route() directly — no socket, so a background teardown cannot outlive the server. */
function call(path: string, init?: RequestInit, repos: WispConfig["repos"] = []): Response | Promise<Response> {
  const url = new URL(`http://wisp.test${path}`);
  const headers = { authorization: `Bearer ${token}`, ...(init?.body ? { "content-type": "application/json" } : {}) };
  return route(new Request(url, { ...init, headers }), url, url.pathname, cfg(repos), {});
}

async function body<T>(res: Response | Promise<Response>): Promise<T> {
  return (await (await res).json()) as T;
}

function sh(cmd: string[], cwd: string): string {
  const p = Bun.spawnSync({ cmd, cwd, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`${cmd.join(" ")}: ${p.stderr.toString()}`);
  return p.stdout.toString().trim();
}

function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "wisp-health-repo-"));
  sh(["git", "init", "-q"], repo);
  writeFileSync(join(repo, "README.md"), "hi\n");
  sh(["git", "add", "."], repo);
  sh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init"], repo);
  return repo;
}

/** A task on a real worktree whose `.git` file and admin entry are then destroyed. */
async function forgottenTask(): Promise<{ id: string; repo: string; worktree: string; branch: string }> {
  const repo = makeRepo();
  const id = newTaskId();
  const wt = await createWorktree(repo, id, "forgotten", cfg());
  writeFileSync(join(wt.path, "the-agent-left-this.txt"), "untracked by anything\n");
  rmSync(join(wt.path, ".git"), { recursive: true, force: true });
  rmSync(join(repo, ".git", "worktrees"), { recursive: true, force: true });
  const task = createTask({ id, title: "forgotten worktree", repo_path: repo, harness: "fake", model: null, slot: freeSlot() });
  setTaskFields(task.id, { worktree_path: wt.path, branch: wt.branch, base_commit: wt.base_commit });
  transition(task.id, "done", "wrapped up");
  return { id: task.id, repo, worktree: wt.path, branch: wt.branch };
}

/** A live task on a healthy worktree. */
async function healthyTask(): Promise<{ id: string; repo: string; worktree: string; branch: string }> {
  const repo = makeRepo();
  const id = newTaskId();
  const wt = await createWorktree(repo, id, "healthy", cfg());
  const task = createTask({ id, title: "healthy worktree", repo_path: repo, harness: "fake", model: null, slot: freeSlot() });
  setTaskFields(task.id, { worktree_path: wt.path, branch: wt.branch, base_commit: wt.base_commit });
  transition(task.id, "done", "wrapped up");
  return { id: task.id, repo, worktree: wt.path, branch: wt.branch };
}

async function eventually(what: string, ok: () => boolean, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (ok()) return;
    await Bun.sleep(25);
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe("the three read routes on a worktree git has forgotten", () => {
  test("GET /api/tasks/:id answers with a null diffstat and the reason, never a lie about being clean", async () => {
    const { id, worktree } = await forgottenTask();
    const detail = await body<{ diffstat: string | null; worktreeReason: string | null }>(call(`/api/tasks/${id}`));
    expect(detail.diffstat).toBeNull();
    expect(detail.worktreeReason).toContain(worktree);
    expect(detail.worktreeReason).toContain("Git no longer tracks this worktree");
  });

  test("GET /api/tasks/:id/diff is 200 with an empty diff and the reason — a state, not a request failure", async () => {
    const { id, worktree } = await forgottenTask();
    const res = await call(`/api/tasks/${id}/diff`);
    expect(res.status).toBe(200);
    const diff = await body<{
      diff: string;
      truncated: boolean;
      untracked: string[];
      base: string | null;
      worktreeReason: string | null;
    }>(res);
    expect(diff).toMatchObject({ diff: "", truncated: false, untracked: [], base: null });
    expect(diff.worktreeReason).toContain(worktree);
    // the reported bug: git's usage dump rendered verbatim in the pane
    expect(diff.worktreeReason!.split("\n")).toHaveLength(1);
    expect(diff.worktreeReason).not.toContain("--no-index");
  });

  test("GET /api/status carries the branch and the reason, with NO counts and no silent omission", async () => {
    const { id, branch } = await forgottenTask();
    const healthy = await healthyTask();
    const status = await body<{ tasks: Record<string, Record<string, unknown>> }>(call("/api/status"));
    // present — the old code skipped the row entirely, which is why the sidebar
    // showed no marks at all
    expect(status.tasks[id]).toBeDefined();
    expect(status.tasks[id]!.branch).toBe(branch);
    expect(status.tasks[id]!.worktreeReason).toContain("Git no longer tracks this worktree");
    // and NOT zeros, which is the other way to lie about it
    expect(status.tasks[id]).not.toHaveProperty("dirtyFiles");
    expect(status.tasks[id]).not.toHaveProperty("ahead");
    expect(status.tasks[id]).not.toHaveProperty("unpushed");
    // one broken worktree costs no other task its marks
    expect(status.tasks[healthy.id]).toMatchObject({ dirtyFiles: 0, ahead: 0, unpushed: false, worktreeReason: null });
  });

  test("an archived task is not told to archive itself — it is already modelled as gone", async () => {
    const { id } = await forgottenTask();
    setTaskFields(id, { archived: 1 });
    const detail = await body<{ worktreeReason: string | null }>(call(`/api/tasks/${id}`));
    expect(detail.worktreeReason).toBeNull();
  });
});

describe("archiving a worktree git has forgotten (the recovery)", () => {
  test("plain archive succeeds, clears the row, and LEAVES the files where they are", async () => {
    const { id, worktree, branch, repo } = await forgottenTask();
    const res = await call(`/api/tasks/${id}/archive`, { method: "POST", body: "{}" });
    expect(res.status).toBe(200);
    const note = (await body<{ ok: boolean; note: string | null }>(res)).note!;
    expect(note).toContain(worktree);
    expect(note).toContain("removing them is your call");
    expect(getTask(id)!.archived).toBe(1);
    // the sentence is where the user will see it, not only in the response
    expect(getTask(id)!.state_detail).toBe(note);
    await eventually("the prune to finish", () => !sh(["git", "worktree", "list"], repo).includes(worktree));
    expect(existsSync(join(worktree, "the-agent-left-this.txt"))).toBe(true);
    expect(sh(["git", "branch", "--list", branch], repo)).toContain(branch);
  });

  test("force archive deletes the directory — that is what force is for", async () => {
    const { id, worktree } = await forgottenTask();
    const res = await call(`/api/tasks/${id}/archive`, { method: "POST", body: JSON.stringify({ force: true }) });
    expect(res.status).toBe(200);
    expect((await body<{ note: string | null }>(res)).note).toBeNull();
    await eventually("the directory to go", () => !existsSync(worktree));
  });
});

describe("archive answers before it destroys (D4)", () => {
  test("the 200 arrives while the teardown hook is still running", async () => {
    const { id, worktree, repo } = await healthyTask();
    const marker = join(mkdtempSync(join(tmpdir(), "wisp-slow-teardown-")), "done.txt");
    const repos: WispConfig["repos"] = [{ path: repo, archiveScript: `sleep 1.5; echo done > ${marker}` }];

    const started = Date.now();
    const res = await call(`/api/tasks/${id}/archive`, { method: "POST", body: "{}" }, repos);
    const elapsed = Date.now() - started;
    expect(res.status).toBe(200);
    // the whole point of Q11: the response does not wait for the hook or the
    // removal, so the row disappears immediately
    expect(elapsed).toBeLessThan(1_000);
    expect(getTask(id)!.archived).toBe(1);
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(worktree)).toBe(true);

    await eventually("the background teardown to finish", () => existsSync(marker) && !existsSync(worktree));
  });

  test("a teardown that fails after the 200 lands in state_detail rather than vanishing", async () => {
    // a real, healthy worktree — but the task's repo_path is not a git
    // repository, so `git worktree remove` in it fails. That is the shape of
    // every teardown failure: it arrives too late to be a 409.
    const repo = makeRepo();
    const id = newTaskId();
    const wt = await createWorktree(repo, id, "late-failure", cfg());
    const notARepo = mkdtempSync(join(tmpdir(), "wisp-not-a-repo-"));
    const task = createTask({
      id,
      title: "teardown fails late",
      repo_path: notARepo,
      harness: "fake",
      model: null,
      slot: freeSlot(),
    });
    setTaskFields(task.id, { worktree_path: wt.path, branch: wt.branch, base_commit: wt.base_commit });
    transition(task.id, "done", "wrapped up");

    const res = await call(`/api/tasks/${id}/archive`, { method: "POST", body: "{}" });
    expect(res.status).toBe(200); // the refusals all passed; this failure is later
    expect(getTask(id)!.archived).toBe(1);

    await eventually("the failure to reach state_detail", () =>
      (getTask(id)!.state_detail ?? "").startsWith("Archived, but the teardown failed"),
    );
    const detail = getTask(id)!.state_detail!;
    expect(detail).toContain("worktree teardown failed");
    expect(detail).toContain("git worktree remove failed");
    expect(detail.split("\n")).toHaveLength(1); // sanitized: never git's usage text
    expect(detail.length).toBeLessThanOrEqual(300);
  });
});

describe("dirty force-archive commits, and never touches the parent repo's stash list (D3)", () => {
  test("the uncommitted work becomes a commit on the kept branch", async () => {
    const { id, repo, worktree, branch } = await healthyTask();
    writeFileSync(join(worktree, "uncommitted.txt"), "the agent was mid-edit\n");
    mkdirSync(join(worktree, "nested"), { recursive: true });
    writeFileSync(join(worktree, "nested", "new.txt"), "untracked too\n");

    // plain archive refuses first, before anything is destroyed
    const refused = await call(`/api/tasks/${id}/archive`, { method: "POST", body: "{}" });
    expect(refused.status).toBe(409);
    expect((await body<{ error: string }>(refused)).error).toContain("uncommitted changes");
    expect(existsSync(worktree)).toBe(true);
    expect(getTask(id)!.archived).toBe(0);

    const forced = await call(`/api/tasks/${id}/archive`, { method: "POST", body: JSON.stringify({ force: true }) });
    expect(forced.status).toBe(200);
    await eventually("the worktree to go", () => !existsSync(worktree));

    expect(sh(["git", "log", "--format=%s", "-1", branch], repo)).toBe("wisp: uncommitted work at archive");
    const files = sh(["git", "show", "--name-only", "--format=", branch], repo);
    expect(files).toContain("uncommitted.txt");
    expect(files).toContain("nested/new.txt"); // -A takes untracked files too
    // THE point of D3: worktrees share the parent's ref store, so a stash here
    // polluted the user's real working repo and nothing in wisp ever popped it
    expect(sh(["git", "stash", "list"], repo)).toBe("");
  });
});
