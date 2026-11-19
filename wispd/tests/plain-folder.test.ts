// A project folder with no Git commit: its tasks run in the folder itself,
// what needs Git is refused by name, and "Initialize Git" turns it into a
// repository whose tasks can have worktrees again.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdapterDef } from "../src/adapters";
import type { WispConfig } from "../src/config";
import { createAndLaunchTask, type NewTask, type NewTaskInput, type NewTaskRefusal } from "../src/domain/task-create";
import { folderGit } from "../src/folder-git";
import { initProjectGit } from "../src/project-git";
import { initProjectGitRoute, reposRoute } from "../src/routes/projects";
import { diffSummaryRoute } from "../src/routes/tasks";
import { hasRunningTurn } from "../src/runner";
import { getTask, turnsFor } from "../src/store";
import { taskPreambleLines } from "../src/turn-input";
import type { Task } from "../src/types";
import { localWorktree, worktreeHealth } from "../src/worktree";

const DIRS: string[] = [];
afterAll(() => {
  for (const dir of DIRS) rmSync(dir, { recursive: true, force: true });
});

const scratch = (prefix = "wisp-plain-"): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  DIRS.push(dir);
  return dir;
};

// the first commit needs an identity on a CI runner that has none
const IDENTITY = {
  GIT_AUTHOR_NAME: "Plain Test",
  GIT_AUTHOR_EMAIL: "plain@example.invalid",
  GIT_COMMITTER_NAME: "Plain Test",
  GIT_COMMITTER_EMAIL: "plain@example.invalid",
};
for (const [key, value] of Object.entries(IDENTITY)) process.env[key] ??= value;

function sh(cwd: string, ...args: string[]): string {
  const p = Bun.spawnSync({ cmd: ["git", ...args], cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, ...IDENTITY } });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
  return p.stdout.toString().trim();
}

function plainFolder(): string {
  const dir = scratch();
  writeFileSync(join(dir, "notes.md"), "a plan\n");
  return dir;
}

function gitRepo(): string {
  const dir = scratch("wisp-plain-repo-");
  sh(dir, "init", "-q");
  sh(dir, "commit", "-q", "--allow-empty", "-m", "init");
  return dir;
}

const cfg = (repos: string[] = []): WispConfig => ({
  instanceId: "123e4567-e89b-42d3-a456-426614174000",
  port: 0,
  host: "127.0.0.1",
  token: "test",
  webhooks: [],
  repos,
  stuckMinutes: 10,
  logMaxBytes: 5_000_000,
  setupTimeoutMinutes: 10,
  envAllowlist: {},
  harnessDefaults: {},
});

const quick: AdapterDef = { bin: "bash", exec: ["-c", "printf done"], parse: { format: "text" }, attach: null };
const adapters = { quick };

const input = (repoPath: string, extra: Partial<NewTaskInput> = {}): NewTaskInput => ({
  repoPath, prompt: "write the plan", harness: "quick", fast: false, mode: "worktree", modeAsked: false, actor: "cli", ...extra,
});

function created(result: NewTask | NewTaskRefusal): Task {
  if ("error" in result) throw new Error(`refused: ${result.error}`);
  return result.task;
}

async function settled(id: string): Promise<Task> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const task = getTask(id)!;
    if (task.state !== "creating" && hasRunningTurn(id) === null && turnsFor(id).every((turn) => turn.status !== "running")) return task;
    if (Date.now() > deadline) throw new Error(`task ${id} did not settle (${task.state})`);
    await Bun.sleep(25);
  }
}

describe("what Git knows about a folder", () => {
  test("a plain folder, a repository with no commit, a repository, and a folder inside one", async () => {
    expect(await folderGit(plainFolder())).toBe("none");
    const unborn = scratch();
    sh(unborn, "init", "-q");
    expect(await folderGit(unborn)).toBe("unborn");
    const repo = gitRepo();
    expect(await folderGit(repo)).toBe("repo");
    mkdirSync(join(repo, "sub"));
    expect(await folderGit(join(repo, "sub"))).toBe("repo");
    // HEAD on an orphan branch still has refs to fork a worktree from
    sh(repo, "checkout", "-q", "--orphan", "gh-pages");
    expect(await folderGit(repo)).toBe("repo");
    // and a folder git cannot answer for is never guessed to be plain
    expect(await folderGit(join(repo, "missing"))).toBe("repo");
  });

  test("a local task's folder with no Git has no branch and no base, and says why it shows no changes", async () => {
    const dir = plainFolder();
    expect(await localWorktree(dir)).toEqual({ path: dir, branch: null, base_commit: null, base_ref: null, base_note: null, plain: "none" });
    const health = await worktreeHealth(dir, { local: true });
    expect(health).toMatchObject({ ok: false, kind: "plain" });
    expect(health.reason).toContain("not a Git repository");
    // a worktree task's folder that Git forgot is still the fault it always was
    expect((await worktreeHealth(dir)).kind).toBe("detached");
    // and a local checkout with a commit is healthy as before
    expect((await worktreeHealth(gitRepo(), { local: true })).ok).toBe(true);
  });
});

describe("creating a task in a plain folder", () => {
  test("left to Wisp, it runs in the folder itself and finishes, with nothing for Git to show", async () => {
    const dir = plainFolder();
    const task = created(await createAndLaunchTask(input(dir), cfg(), adapters, null));
    expect(task.mode).toBe("local");
    const done = await settled(task.id);
    expect(done.state).toBe("done");
    expect(done).toMatchObject({ worktree_path: dir, branch: null, base_commit: null });
    // the agent is never told about a branch or asked to commit
    const preamble = taskPreambleLines(done).join("\n");
    expect(preamble).toContain(`directly in the project folder ${dir}`);
    expect(preamble).toContain("do not run git init or commit unless asked");
    expect(preamble).not.toContain("branch null");
    const summary = (await (await diffSummaryRoute(done)).json()) as { files: number; worktreeReason: string };
    expect(summary.files).toBe(0);
    expect(summary.worktreeReason).toContain("not a Git repository");
  });

  test("a worktree, a base, autopilot or a subtask is refused by name, and nothing is left behind", async () => {
    const dir = plainFolder();
    const refusal = async (extra: Partial<NewTaskInput>) => createAndLaunchTask(input(dir, extra), cfg(), adapters, null);
    expect(await refusal({ modeAsked: true })).toMatchObject({
      kind: "invalid",
      error: expect.stringContaining("is not a Git repository, so a worktree task cannot start there"),
    });
    expect(await refusal({ base: "main" })).toMatchObject({ kind: "invalid", error: expect.stringContaining("base, auto-merge, auto-fix and auto-review need Git") });
    expect(await refusal({ autopilot: { autoMerge: false, autoFix: true } })).toMatchObject({ kind: "invalid", error: expect.stringContaining("need Git") });

    const parent = await settled(created(await refusal({})).id);
    // one task at a time, and the way out is one that works without Git
    expect(await refusal({})).toMatchObject({
      kind: "conflict",
      error: expect.stringContaining(`runs one task at a time — send ${parent.id} a message, or archive it first`),
    });
    expect(await refusal({ repoPath: "", subtask: { parentId: parent.id } })).toMatchObject({
      kind: "invalid",
      error: `a subtask runs in its own worktree, and ${dir} is not a Git repository`,
    });
  });

  test("a repository with no commit yet is the same case, named for what it lacks", async () => {
    const dir = scratch();
    sh(dir, "init", "-q");
    expect(await createAndLaunchTask(input(dir, { modeAsked: true }), cfg(), adapters, null)).toMatchObject({
      error: expect.stringContaining("has no commits yet"),
    });
    const task = await settled(created(await createAndLaunchTask(input(dir), cfg(), adapters, null)).id);
    expect(task).toMatchObject({ state: "done", mode: "local", branch: null });
  });

  test("a Git repository is unaffected: left to Wisp, it still gets a worktree", async () => {
    const repo = gitRepo();
    const task = await settled(created(await createAndLaunchTask(input(repo), cfg(), adapters, null)).id);
    expect(task.mode).toBe("worktree");
    expect(task.branch).toStartWith("wisp/");
  });
});

describe("Initialize Git", () => {
  test("commits the folder's current files, honouring its .gitignore, and is refused once there is a commit", async () => {
    const dir = plainFolder();
    writeFileSync(join(dir, ".gitignore"), "secret.env\n");
    writeFileSync(join(dir, "secret.env"), "TOKEN=1\n");
    expect(await initProjectGit(dir)).toEqual({ ok: true, git: "repo" });
    expect(sh(dir, "ls-files").split("\n").sort()).toEqual([".gitignore", "notes.md"]);
    expect(sh(dir, "log", "--format=%s")).toBe("Initial commit");
    expect(await initProjectGit(dir)).toMatchObject({ ok: false, status: 409, error: expect.stringContaining("already a Git repository") });
  });

  test("an empty folder gets an empty first commit, so worktrees have something to fork", async () => {
    const dir = scratch();
    expect(await initProjectGit(dir)).toEqual({ ok: true, git: "repo" });
    expect(sh(dir, "rev-list", "--count", "HEAD")).toBe("1");
  });

  test("a folder inside a parent repository with no commit is refused, never committed into the parent", async () => {
    const parent = scratch();
    sh(parent, "init", "-q");
    const child = join(parent, "child");
    mkdirSync(child);
    writeFileSync(join(child, "a.txt"), "a\n");
    expect(await initProjectGit(child)).toMatchObject({ ok: false, error: expect.stringContaining("inside another Git repository") });
    expect(await folderGit(parent)).toBe("unborn");
  });

  test("the route serves registered projects only, and GET /api/repos reports each folder's Git state", async () => {
    const plain = plainFolder();
    const repo = gitRepo();
    const config = cfg([plain, repo]);
    const post = (path: string) =>
      initProjectGitRoute(new Request("http://wisp/api/projects/git", { method: "POST", body: JSON.stringify({ path }) }), config);

    // the list also carries projects known only from other tests' task history
    const listed = async () =>
      Object.fromEntries(
        ((await (await reposRoute(config)).json()) as { repos: { path: string; git: string | null }[] }).repos
          .filter((r) => r.path === plain || r.path === repo)
          .map((r) => [r.path, r.git]),
      );
    expect(await listed()).toEqual({ [plain]: "none", [repo]: "repo" });

    expect((await post(scratch())).status).toBe(404);
    expect((await post("relative/path")).status).toBe(400);
    const ok = await post(plain);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ path: plain, git: "repo" });
    expect((await post(plain)).status).toBe(409);
    expect(await listed()).toEqual({ [plain]: "repo", [repo]: "repo" });
  });
});
