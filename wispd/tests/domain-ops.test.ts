// The task create and archive operations, called the way any non-HTTP caller
// would: parsed input in, a result or a named refusal out, and the audit
// written by the operation itself.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import type { AdapterDef } from "../src/adapters";
import type { WispConfig } from "../src/config";
import { archiveTaskRows } from "../src/domain/archive";
import { createAndLaunchTask, type NewTaskInput } from "../src/domain/task-create";
import { hasRunningTurn, interruptTurn, startTurn } from "../src/runner";
import { createTask, freeSlot, getTask, listTasks, newTaskId, setTaskFields, transition, turnsFor } from "../src/store";
import { taskAudit } from "../src/task-audit";

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

const quick: AdapterDef = { bin: "bash", exec: ["-c", "printf done"], parse: { format: "text" }, attach: null };
const slow: AdapterDef = { bin: "bash", exec: ["-c", "sleep 30"], parse: { format: "text" }, attach: null };
const adapters = { quick, slow };

async function until(pred: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await Bun.sleep(25);
  }
}

const settled = (id: string) => () =>
  getTask(id)!.state !== "creating" && hasRunningTurn(id) === null && turnsFor(id).every((turn) => turn.status !== "running");
const recorded = (id: string, action: string) => taskAudit(id, 500).filter((entry) => entry.action === action);
const tasksIn = (repo: string) => listTasks(true).filter((task) => task.repo_path === repo);

async function gitRepo(): Promise<string> {
  const repo = mkdtempSync(join(tmpdir(), "wisp-domain-repo-"));
  for (const args of [["init", "-q"], ["commit", "-q", "--allow-empty", "-m", "init"]]) {
    const proc = Bun.spawn(["git", "-c", "user.name=Domain Test", "-c", "user.email=domain@example.invalid", ...args], {
      cwd: repo, stdout: "ignore", stderr: "pipe",
    });
    if ((await proc.exited) !== 0) throw new Error(`git ${args.join(" ")}: ${await new Response(proc.stderr).text()}`);
  }
  return repo;
}

const input = (repoPath: string, extra: Partial<NewTaskInput> = {}): NewTaskInput => ({
  repoPath, prompt: "write the thing", harness: "quick", fast: false, brief: false, mode: "local", actor: "cli", ...extra,
});

describe("creating a task without HTTP", () => {
  test("each refusal is named, and none leaves a task behind", async () => {
    const repo = await gitRepo();
    const refusal = async (extra: Partial<NewTaskInput>, config = cfg) => createAndLaunchTask(input(repo, extra), config, adapters, null);
    expect(await refusal({ harness: "nope" })).toMatchObject({ kind: "invalid", error: expect.stringContaining("unknown harness 'nope'") });
    expect(await refusal({ repoPath: join(repo, "missing") })).toMatchObject({ kind: "invalid", error: expect.stringContaining("does not exist") });
    expect(await refusal({ effort: "high" })).toMatchObject({ kind: "invalid", error: "harness 'quick' has no effort support" });
    expect(await refusal({ base: "main" })).toMatchObject({ kind: "invalid", error: expect.stringContaining("worktree tasks only") });
    // the route refuses this at the request boundary; the operation refuses it for every other caller
    expect(await refusal({ autopilot: { autoMerge: true, autoFix: false } })).toMatchObject({ kind: "invalid", error: expect.stringContaining("need a worktree task") });
    expect(await refusal({ attachments: "not a list" })).toMatchObject({ kind: "attachment", status: 400 });
    expect(await refusal({}, { ...cfg, maxConcurrentTasks: 0 })).toMatchObject({ kind: "at-capacity" });
    expect(tasksIn(repo)).toEqual([]);
  });

  test("a created task is audited by the operation, titled from the caller's words, and launched", async () => {
    const repo = await gitRepo();
    const created = await createAndLaunchTask(
      input(repo, { prompt: "the caller's words", firstTurnPrompt: "the caller's words\n\nplus a suffix", actor: "agent:orch9" }),
      cfg,
      adapters,
      null,
    );
    if ("error" in created) throw new Error(created.error);
    expect(created.task).toMatchObject({ title: "the caller's words", state: "creating", repo_path: repo });
    expect(created.autopilot).toMatchObject({ autoMerge: false, autoFix: false });
    expect(recorded(created.task.id, "create")).toEqual([expect.objectContaining({ actor: "agent:orch9", detail: "quick, local" })]);
    await until(settled(created.task.id));
    expect(turnsFor(created.task.id)[0]).toMatchObject({ prompt: "the caller's words\n\nplus a suffix", status: "done" });

    // one checkout, one local task
    const second = await createAndLaunchTask(input(repo), cfg, adapters, null);
    expect(second).toMatchObject({ kind: "conflict", error: expect.stringContaining(`task ${created.task.id} is already running locally`) });
    expect(tasksIn(repo).map((task) => task.id)).toEqual([created.task.id]);
  });

  test("requested autopilot is armed before the launch and audited as the creator's", async () => {
    const repo = await gitRepo();
    const created = await createAndLaunchTask(
      input(repo, { mode: "worktree", autopilot: { autoMerge: true, autoFix: false }, actor: "desktop" }),
      cfg,
      adapters,
      null,
    );
    if ("error" in created) throw new Error(created.error);
    expect(created.autopilot).toMatchObject({ autoMerge: true, autoFix: false });
    expect(recorded(created.task.id, "autopilot")).toEqual([expect.objectContaining({ actor: "desktop", detail: "auto-merge on" })]);
    await until(settled(created.task.id));
    expect(getTask(created.task.id)).toMatchObject({ state: "done", mode: "worktree" });
  });
});

function idleLocalTask(): string {
  const task = createTask({
    id: newTaskId(), title: "domain archive", repo_path: "/tmp/domain-archive-repo", harness: "quick", model: null, mode: "local", slot: freeSlot(),
  });
  setTaskFields(task.id, { worktree_path: mkdtempSync(join(tmpdir(), "wisp-domain-")), branch: `wisp/${task.id}` });
  transition(task.id, "done", "setup done");
  return task.id;
}

describe("archiving without HTTP", () => {
  test("one refusal archives nothing; the archive is audited with the caller's actor and reason", async () => {
    const idle = idleLocalTask();
    const busy = idleLocalTask();
    startTurn(getTask(busy)!, "wait", slow, cfg);
    await until(() => hasRunningTurn(busy) !== null);

    const refused = await archiveTaskRows([getTask(idle)!, getTask(busy)!], false, cfg, { actor: "cli" });
    expect(refused).toMatchObject({ status: 409, task: { id: busy }, error: expect.stringContaining("is still running") });
    expect(getTask(idle)!.archived).toBe(0);
    expect(recorded(idle, "archive")).toEqual([]);

    await interruptTurn(busy, 200);
    await until(settled(busy));
    const done = await archiveTaskRows([getTask(idle)!, getTask(busy)!], false, cfg, { actor: "cli", reason: "project removed from Wisp" });
    if ("error" in done) throw new Error(done.error);
    expect(done.archived.map((row) => row.task.id)).toEqual([idle, busy]);
    for (const id of [idle, busy]) {
      expect(getTask(id)!.archived).toBe(1);
      expect(recorded(id, "archive")).toEqual([expect.objectContaining({ actor: "cli", detail: "project removed from Wisp" })]);
    }
  });
});
