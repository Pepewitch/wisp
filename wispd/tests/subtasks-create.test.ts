// Creating subtasks: the invariants, each kind's base, the caps, and the
// first prompt. Real git repositories (a bare origin carrying a pull ref);
// GitHub is a fake answering only the open-PR lookup.
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import type { AdapterDef } from "../src/adapters";
import type { OpenPullRequest } from "../src/autopilot/github";
import type { WispConfig } from "../src/config";
import type { SubtaskDeps } from "../src/domain/subtask-create";
import { createAndLaunchTask, type NewTask, type NewTaskInput, type NewTaskRefusal } from "../src/domain/task-create";
import { subscribe } from "../src/events";
import { hasRunningTurn, submitTaskMessage } from "../src/runner";
import { getTask, getTaskMessage, turnsFor } from "../src/store";
import { SubtaskCapError } from "../src/task-admission";
import { portRange, taskPreambleLines } from "../src/turn-input";
import type { Task } from "../src/types";

const cfg = (extra: Partial<WispConfig> = {}): WispConfig => ({
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
  subtasksPreview: true,
  ...extra,
});

const scratch = () => realpathSync(mkdtempSync(join(tmpdir(), "wisp-subtasks-")));
/** A turn that lasts until its gate file exists: what holds a slot for as long as a test needs. */
const held = (gate: string): AdapterDef => ({ bin: "bash", exec: ["-c", `while [ ! -e '${gate}' ]; do sleep 0.05; done; printf done`], parse: { format: "text" }, attach: null });
const adapters: Record<string, AdapterDef> = { quick: { bin: "bash", exec: ["-c", "printf done"], parse: { format: "text" }, attach: null } };

async function git(cwd: string, ...args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", "-c", "user.name=Subtask Test", "-c", "user.email=subtasks@example.invalid", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if ((await proc.exited) !== 0) throw new Error(`git ${args.join(" ")}: ${await new Response(proc.stderr).text()}`);
  return (await new Response(proc.stdout).text()).trim();
}

/** A clone of a bare origin; the origin also carries refs/pull/7/head, one commit past main. */
async function project(): Promise<{ repo: string; prHead: string }> {
  const root = scratch();
  const origin = join(root, "origin.git");
  const repo = join(root, "repo");
  await git(root, "init", "-q", "--bare", "-b", "main", origin);
  await git(root, "clone", "-q", origin, repo);
  await git(repo, "commit", "-q", "--allow-empty", "-m", "init");
  await git(repo, "push", "-q", "origin", "HEAD:refs/heads/main");
  await git(repo, "commit", "-q", "--allow-empty", "-m", "the PR's change");
  const prHead = await git(repo, "rev-parse", "HEAD");
  await git(repo, "push", "-q", "origin", "HEAD:refs/pull/7/head");
  await git(repo, "reset", "-q", "--hard", "HEAD~1");
  // the fetched copy is what a task would not have: prove the fetch brings it
  await git(repo, "reflog", "expire", "--expire=now", "--all");
  await git(repo, "gc", "-q", "--prune=now");
  return { repo, prHead };
}

const settled = (id: string) => getTask(id)!.state !== "creating" && hasRunningTurn(id) === null && turnsFor(id).every((t) => t.status !== "running");
async function until(pred: () => boolean, what: string, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(25);
  }
}

function created(result: NewTask | NewTaskRefusal): Task {
  if ("error" in result) throw new Error(result.error);
  return result.task;
}

const input = (extra: Partial<NewTaskInput>): NewTaskInput => ({
  repoPath: "", prompt: "look into it", harness: "quick", fast: false, mode: "worktree", actor: "cli", ...extra,
});

/** A parent with a branch and a finished turn. */
async function parentIn(repo: string, config = cfg()): Promise<Task> {
  const parent = created(await createAndLaunchTask(input({ repoPath: repo, prompt: "build the parser" }), config, adapters, null));
  await until(() => settled(parent.id), "the parent to settle");
  return getTask(parent.id)!;
}

const noGitHub: SubtaskDeps = {
  origin: async () => "example/sample",
  github: { openPullRequests: async () => { throw new Error("GitHub must not be asked"); } },
};
const pulls = (list: Partial<OpenPullRequest>[]): SubtaskDeps => ({
  origin: async () => "example/sample",
  github: {
    openPullRequests: async () => ({
      defaultBranch: "main", viewer: "someone",
      pulls: list.map((pull) => ({ number: 7, headRefName: "", baseRefName: "main", createdAt: "", isCrossRepository: false, author: "someone", ...pull })),
    }),
  },
});

describe("creating a subtask", () => {
  test("refused while the feature is off; Wisp's reviewers are subtasks either way", async () => {
    const { repo } = await project();
    const parent = await parentIn(repo);
    const off = cfg({ subtasksPreview: false });
    expect(await createAndLaunchTask(input({ subtask: { parentId: parent.id } }), off, adapters, null))
      .toEqual({ kind: "conflict", error: "subtasks are not enabled on this daemon" });
    const reviewer = created(await createAndLaunchTask(input({
      subtask: { parentId: parent.id, kind: "review" }, verifyRole: "reviewer", actor: "autopilot",
      base: { ref: "refs/heads/main", commit: parent.base_commit!, from: "pr#7" },
    }), off, adapters, null));
    expect(reviewer).toMatchObject({ parent_task_id: parent.id, subtask_kind: "review", report_to_parent: 0, base_from: "pr#7", repo_path: repo });
  });

  test("the invariants: a live root parent, worktree mode, the parent's repository, and no autopilot yet", async () => {
    const { repo } = await project();
    const parent = await parentIn(repo);
    const child = created(await createAndLaunchTask(input({ subtask: { parentId: parent.id } }), cfg(), adapters, null));
    const refusal = (extra: Partial<NewTaskInput>) => createAndLaunchTask(input({ subtask: { parentId: parent.id }, ...extra }), cfg(), adapters, null);
    expect(await createAndLaunchTask(input({ subtask: { parentId: "tnone1" } }), cfg(), adapters, null)).toEqual({ kind: "invalid", error: "no such parent task: tnone1" });
    expect(await createAndLaunchTask(input({ subtask: { parentId: child.id } }), cfg(), adapters, null))
      .toEqual({ kind: "conflict", error: `subtasks have one level: task ${child.id} is itself a subtask; use --parent ${parent.id}` });
    expect(await refusal({ mode: "local" })).toMatchObject({ kind: "invalid", error: expect.stringContaining("local mode is refused") });
    expect(await refusal({ repoPath: parent.worktree_path! })).toMatchObject({ kind: "invalid", error: expect.stringContaining("omit the repository") });
    expect(await refusal({ repoPath: (await project()).repo })).toMatchObject({ kind: "invalid", error: expect.stringContaining("omit the repository") });
    expect(await refusal({ autopilot: { autoMerge: false, autoFix: true } })).toMatchObject({ kind: "conflict", error: expect.stringContaining("not available on subtasks") });
    // the parent's own path is the same repository, so naming it is fine
    expect(created(await refusal({ repoPath: repo }))).toMatchObject({ repo_path: repo, parent_task_id: parent.id });
  });

  test("an explore child takes the project's base when its worktree is made, and reports only when asked", async () => {
    const { repo } = await project();
    const parent = await parentIn(repo);
    const events: string[] = [];
    const stop = subscribe((event) => { if (event.type === "task") events.push(event.taskId); });
    const child = created(await createAndLaunchTask(input({ subtask: { parentId: parent.id } }), cfg(), adapters, null));
    stop();
    // the parent hears that its list of children changed
    expect(events).toContain(parent.id);
    expect(child).toMatchObject({ parent_task_id: parent.id, subtask_kind: "explore", report_to_parent: 0, base_from: "project", base_commit: null, repo_path: repo });
    await until(() => settled(child.id), "the child to settle");
    expect(getTask(child.id)).toMatchObject({ state: "done", base_commit: parent.base_commit, base_ref: "origin/main" });
    const reporting = created(await createAndLaunchTask(input({ subtask: { parentId: parent.id, report: true } }), cfg(), adapters, null));
    expect(reporting.report_to_parent).toBe(1);
    await until(() => settled(reporting.id), "the reporting child to settle");
  });

  test("a continue child starts from the parent's committed tip; a parent still being created is refused", async () => {
    const { repo } = await project();
    const parent = await parentIn(repo);
    await git(parent.worktree_path!, "commit", "-q", "--allow-empty", "-m", "the parent's work");
    const tip = await git(parent.worktree_path!, "rev-parse", "HEAD");
    const child = created(await createAndLaunchTask(input({ subtask: { parentId: parent.id, kind: "continue" } }), cfg(), adapters, null));
    expect(child).toMatchObject({ subtask_kind: "continue", base_from: `parent:${parent.id}` });
    await until(() => settled(child.id), "the child to settle");
    // pinned at the request and kept through the launch
    expect(getTask(child.id)).toMatchObject({ state: "done", base_commit: tip, base_ref: parent.branch });
    const gate = join(scratch(), "open");
    const creating = created(await createAndLaunchTask(input({ repoPath: repo, harness: "held" }), cfg(), { ...adapters, held: held(gate) }, null));
    expect(await createAndLaunchTask(input({ subtask: { parentId: creating.id, kind: "continue" } }), cfg(), adapters, null))
      .toMatchObject({ kind: "conflict", error: expect.stringContaining("still being created") });
    await Bun.write(gate, "");
    await until(() => settled(creating.id), "the held parent to settle");
  });

  test("a review child starts from the parent's PR head, fetched; no PR, a fork, GitHub down and a missing head are each refused", async () => {
    const { repo, prHead } = await project();
    const parent = await parentIn(repo);
    const review = (deps: SubtaskDeps) => createAndLaunchTask(input({ subtask: { parentId: parent.id, kind: "review" } }), cfg(), adapters, null, deps);
    expect(await review(pulls([]))).toEqual({ kind: "conflict", error: `task ${parent.id} has no open PR; pass --base` });
    expect(await review(pulls([{ headRefName: parent.branch!, isCrossRepository: true }]))).toMatchObject({ kind: "conflict", error: expect.stringContaining("from a fork") });
    expect(await review({ ...noGitHub, github: { openPullRequests: async () => { throw new Error("rate limited"); } } }))
      .toMatchObject({ kind: "conflict", error: expect.stringContaining("couldn't reach GitHub") });
    expect(await review(pulls([{ number: 8, headRefName: parent.branch! }]))).toMatchObject({ kind: "conflict", error: expect.stringContaining("couldn't read PR #8's head") });
    const child = created(await review(pulls([{ headRefName: parent.branch! }])));
    expect(child).toMatchObject({ subtask_kind: "review", base_from: "pr#7" });
    await until(() => settled(child.id), "the review child to settle");
    expect(getTask(child.id)).toMatchObject({ state: "done", base_commit: prHead, base_ref: "refs/pull/7/head" });
    // an explicit base comes first: no GitHub call at all
    const explicit = created(await createAndLaunchTask(input({ subtask: { parentId: parent.id, kind: "review" }, base: "main" }), cfg(), adapters, null, noGitHub));
    expect(explicit).toMatchObject({ subtask_kind: "review", base_from: "explicit" });
    await until(() => settled(explicit.id), "the explicit child to settle");
  });

  test("the total cap counts live non-reviewer children; reviewers are exempt", async () => {
    const { repo } = await project();
    const config = cfg({ maxSubtasks: 2 });
    const parent = await parentIn(repo, config);
    for (let i = 0; i < 2; i++) {
      const child = created(await createAndLaunchTask(input({ subtask: { parentId: parent.id } }), config, adapters, null));
      await until(() => settled(child.id), "a child to settle");
    }
    expect(await createAndLaunchTask(input({ subtask: { parentId: parent.id } }), config, adapters, null))
      .toEqual({ kind: "subtask-cap", error: `task ${parent.id} already has 2 live subtasks, its limit; archive one first, or raise maxSubtasks in config.json` });
    const reviewer = created(await createAndLaunchTask(input({
      subtask: { parentId: parent.id, kind: "review" }, verifyRole: "reviewer", actor: "autopilot",
      base: { ref: "refs/heads/main", commit: parent.base_commit!, from: "pr#7" },
    }), config, adapters, null));
    await until(() => settled(reviewer.id), "the reviewer to settle");
  });

  test("the running cap refuses a new child, a direct send, and holds a queued start until a sibling settles", async () => {
    const { repo } = await project();
    const config = cfg({ maxRunningSubtasks: 2 });
    const parent = await parentIn(repo, config);
    const [gateA, gateB, gateA2] = [join(scratch(), "a"), join(scratch(), "b"), join(scratch(), "a2")];
    const gated = { ...adapters, heldA: held(gateA), heldB: held(gateB) };
    const a = created(await createAndLaunchTask(input({ subtask: { parentId: parent.id }, harness: "heldA" }), config, gated, null));
    const b = created(await createAndLaunchTask(input({ subtask: { parentId: parent.id }, harness: "heldB" }), config, gated, null));
    await until(() => hasRunningTurn(a.id) !== null && hasRunningTurn(b.id) !== null, "both children to run");
    expect(await createAndLaunchTask(input({ subtask: { parentId: parent.id } }), config, gated, null)).toMatchObject({ kind: "subtask-cap" });
    // A reviewer is held to the global limit only
    const reviewer = created(await createAndLaunchTask(input({
      subtask: { parentId: parent.id, kind: "review" }, verifyRole: "reviewer", actor: "autopilot",
      base: { ref: "refs/heads/main", commit: parent.base_commit!, from: "pr#7" },
    }), config, gated, null));
    await until(() => settled(reviewer.id), "the reviewer to settle");
    // A queues its next turn behind its running one: its own slot covers that
    gated.heldA = held(gateA2);
    const queued = await submitTaskMessage(getTask(a.id)!, "and then this", gated.heldA, config, [], undefined, gated);
    expect(queued.disposition).toBe("queued-next");
    // the cap is lowered while both run: when A's turn ends, its queued start must wait for B
    config.maxRunningSubtasks = 1;
    await Bun.write(gateA, "");
    await until(() => turnsFor(a.id)[0]?.status === "done", "A's first turn to end");
    await until(() => getTask(a.id)!.state_detail === `waiting for a subtask slot under ${parent.id}`, "A to wait for a slot");
    expect(getTaskMessage(queued.message.id)).toMatchObject({ status: "queued" });
    expect(getTask(a.id)!.state).not.toBe("failed");
    // a direct send to an idle sibling is refused outright
    await expect(submitTaskMessage(getTask(a.id)!, "now", gated.heldA, config, [], undefined, gated)).rejects.toBeInstanceOf(SubtaskCapError);
    // B settles: A's message starts on its own
    await Bun.write(gateB, "");
    await until(() => getTaskMessage(queued.message.id)?.delivery === "started", "A's queued message to start");
    await Bun.write(gateA2, "");
    await until(() => settled(a.id) && settled(b.id), "both children to settle");
  });

  test("a child's first prompt quotes its parent after its own words; Wisp's facts go in the preamble", async () => {
    const { repo } = await project();
    const parent = await parentIn(repo);
    const child = created(await createAndLaunchTask(input({ subtask: { parentId: parent.id }, prompt: "check the edge cases" }), cfg(), adapters, null));
    await until(() => settled(child.id), "the child to settle");
    expect(turnsFor(child.id)[0]!.prompt).toBe(`check the edge cases\n\nParent task ${parent.id}, quoted:\n> build the parser`);
    const lines = taskPreambleLines(getTask(child.id)!).join("\n");
    expect(lines).toContain(`This is an explore subtask of task ${parent.id}`);
    expect(lines).toContain("Never commit to or push your parent's branch");
    expect(lines).toContain("off for subtasks");
    expect(taskPreambleLines(getTask(parent.id)!).join("\n")).not.toContain("subtask");
    expect(taskPreambleLines({ ...getTask(child.id)!, verify_role: "reviewer" }).join("\n")).not.toContain("subtask");
    expect(taskPreambleLines({ ...getTask(child.id)!, subtask_kind: "review" }).join("\n")).toContain("Never push");
    expect(taskPreambleLines({ ...getTask(child.id)!, subtask_kind: "continue" }).join("\n")).toContain("git merge");
    expect(portRange(getTask(child.id)!)).not.toBeNull();
    expect(portRange(getTask(parent.id)!)).toBeNull();
  });
});
