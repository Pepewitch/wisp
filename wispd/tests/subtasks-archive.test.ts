// Archiving and purging a family: the opt-in, all-or-nothing, per-row force,
// reviewers forced through two levels with their rounds ended in the same
// transaction, a reviewer archived alone, and what purge refuses.
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, spyOn, test } from "bun:test";
import type { AdapterDef } from "../src/adapters";
import { archiveCleanup, clearArchiveCleanup } from "../src/archive-jobs";
import { setAutopilot, autopilotRow } from "../src/autopilot/store";
import { planBulkPurge } from "../src/bulk-purge";
import type { WispConfig } from "../src/config";
import { archiveTaskRows } from "../src/domain/archive";
import { createAndLaunchTask, type NewTask, type NewTaskInput, type NewTaskRefusal } from "../src/domain/task-create";
import { subscribe } from "../src/events";
import { hasRunningTurn } from "../src/runner";
import { db, getTask, randomId, turnsFor } from "../src/store";
import { isOrphan } from "../src/subtasks";
import { taskAudit } from "../src/task-audit";
import { exportTask, purgeTask } from "../src/task-retention";
import type { Task } from "../src/types";
import * as worktree from "../src/worktree";

const cfg: WispConfig = {
  instanceId: "123e4567-e89b-42d3-a456-426614174000", port: 0, host: "127.0.0.1", token: "test", webhooks: [], repos: [],
  stuckMinutes: 10, logMaxBytes: 5_000_000, setupTimeoutMinutes: 10, envAllowlist: {}, harnessDefaults: {}, subtasksPreview: true,
};
const adapters: Record<string, AdapterDef> = { quick: { bin: "bash", exec: ["-c", "printf done"], parse: { format: "text" }, attach: null } };

async function git(cwd: string, ...args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", "-c", "user.name=Archive Test", "-c", "user.email=archive@example.invalid", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if ((await proc.exited) !== 0) throw new Error(`git ${args.join(" ")}: ${await new Response(proc.stderr).text()}`);
  return (await new Response(proc.stdout).text()).trim();
}

async function repo(): Promise<string> {
  const path = realpathSync(mkdtempSync(join(tmpdir(), "wisp-subtasks-archive-")));
  await git(path, "init", "-q");
  await git(path, "commit", "-q", "--allow-empty", "-m", "init");
  return path;
}

const settled = (id: string) => getTask(id)!.state !== "creating" && hasRunningTurn(id) === null && turnsFor(id).every((t) => t.status !== "running");
async function until(pred: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(25);
  }
}

async function make(input: Partial<NewTaskInput>): Promise<Task> {
  const result: NewTask | NewTaskRefusal = await createAndLaunchTask(
    { repoPath: "", prompt: "work", harness: "quick", fast: false, mode: "worktree", actor: "cli", ...input }, cfg, adapters, null);
  if ("error" in result) throw new Error(result.error);
  await until(() => settled(result.task.id), `task ${result.task.id} to settle`);
  return getTask(result.task.id)!;
}

const child = (parent: Task, extra: Partial<NewTaskInput> = {}) => make({ subtask: { parentId: parent.id }, ...extra });
const reviewer = (author: Task) => make({
  subtask: { parentId: author.id, kind: "review" }, verifyRole: "reviewer", actor: "autopilot",
  base: { ref: "refs/heads/main", commit: author.base_commit!, from: "pr#7" },
});

/** A running round on the author, its review held by this reviewer. */
function runningRound(author: Task, reviewerTask: Task): { round: string; review: string; workflow: string } {
  setAutopilot(author.id, { autoReview: true });
  const workflow = autopilotRow(author.id)!.id;
  const round = randomId("r", 10), review = randomId("v", 10), at = new Date().toISOString();
  db.run(`INSERT INTO auto_review_rounds (id, task_id, workflow_id, pr, head, round, token, state, created_at) VALUES (?, ?, ?, 7, ?, 1, 'tok', 'running', ?)`,
    [round, author.id, workflow, author.base_commit, at]);
  db.run(`INSERT INTO round_reviews (id, round_id, role, reviewer_task_id, token, state, created_at) VALUES (?, ?, 'primary', ?, 'tok', 'running', ?)`,
    [review, round, reviewerTask.id, at]);
  return { round, review, workflow };
}

const archived = (id: string) => getTask(id)!.archived === 1;

describe("archiving a family", () => {
  test("a parent with a live subtask is refused unless the request opts in, and then both go", async () => {
    const parent = await make({ repoPath: await repo() });
    const kid = await child(parent);
    const refused = await archiveTaskRows([parent], false, cfg, { actor: "web" });
    expect(refused).toMatchObject({
      status: 409,
      error: `task ${parent.id} has 1 live subtask — archive them with it (subtasks: "archive"), or force them ("force")`,
      refusedSubtasks: [{ id: kid.id, title: kid.title, error: "a live subtask", needs: "subtasks" }],
    });
    expect([archived(parent.id), archived(kid.id)]).toEqual([false, false]);
    const done = await archiveTaskRows([parent], false, cfg, { actor: "web", subtasks: "archive" });
    if ("error" in done) throw new Error(done.error);
    expect(done.archived.map((row) => row.task.id)).toEqual([parent.id, kid.id]);
    expect([archived(parent.id), archived(kid.id)]).toEqual([true, true]);
    expect(archiveCleanup(kid.id)).toMatchObject({ force: false });
    expect(taskAudit(kid.id, 10).find((entry) => entry.action === "archive")).toMatchObject({ actor: "web", detail: `with task ${parent.id}` });
  });

  test("all or nothing: a dirty child refuses the whole family and is named; force forces each child", async () => {
    const parent = await make({ repoPath: await repo() });
    const clean = await child(parent);
    const dirty = await child(parent);
    writeFileSync(join(dirty.worktree_path!, "unsaved.txt"), "work in progress");
    const refused = await archiveTaskRows([parent], false, cfg, { subtasks: "archive" });
    expect(refused).toMatchObject({ status: 409, refusedSubtasks: [{ id: dirty.id, error: expect.stringContaining("uncommitted") }] });
    expect([parent, clean, dirty].map((task) => archived(task.id))).toEqual([false, false, false]);
    const forced = await archiveTaskRows([parent], false, cfg, { subtasks: "force" });
    if ("error" in forced) throw new Error(forced.error);
    expect([parent, clean, dirty].map((task) => archived(task.id))).toEqual([true, true, true]);
    // force is per row: the parent was asked for unforced
    expect([archiveCleanup(parent.id)?.force, archiveCleanup(dirty.id)?.force]).toEqual([false, true]);
  });

  test("reviewers go with their author through two levels, forced, and the author's running rounds end in the same archive", async () => {
    const parent = await make({ repoPath: await repo() });
    const parentReviewer = await reviewer(parent);
    const kid = await child(parent);
    const kidReviewer = await reviewer(kid);
    const { round, workflow } = runningRound(parent, parentReviewer);
    // reviewers need no opt-in: a parent whose only children are reviewers archives as before
    const own = await archiveTaskRows([kid], false, cfg, { actor: "web" });
    if ("error" in own) throw new Error(own.error);
    expect([archived(kid.id), archived(kidReviewer.id), archived(parent.id)]).toEqual([true, true, false]);
    expect(archiveCleanup(kidReviewer.id)).toMatchObject({ force: true });
    const done = await archiveTaskRows([parent], false, cfg, { actor: "web", stopAutopilot: true });
    if ("error" in done) throw new Error(done.error);
    expect(archived(parentReviewer.id)).toBe(true);
    expect(db.query("SELECT state, summary FROM auto_review_rounds WHERE id = ?").get(round)).toEqual({ state: "superseded", summary: "the task was archived" });
    expect(db.query("SELECT state FROM round_reviews WHERE round_id = ?").get(round)).toEqual({ state: "superseded" });
    expect(db.query("SELECT detail FROM workflow_history WHERE workflow_id = ? AND kind = 'review'").all(workflow))
      .toEqual([{ detail: expect.stringContaining("ended: the task was archived") }]);
  });

  test("a reviewer a person archives on its own ends its review as an error; auto-review retiring it does not", async () => {
    const author = await make({ repoPath: await repo() });
    const byPerson = await reviewer(author);
    const { review } = runningRound(author, byPerson);
    const done = await archiveTaskRows([byPerson], false, cfg, { actor: "web" });
    if ("error" in done) throw new Error(done.error);
    expect(db.query("SELECT state, summary FROM round_reviews WHERE id = ?").get(review)).toEqual({ state: "error", summary: "archived by a person" });
    const retired = await reviewer(author);
    const second = randomId("v", 10);
    db.run(`INSERT INTO round_reviews (id, round_id, role, reviewer_task_id, token, state, created_at)
      SELECT ?, round_id, 'second', ?, 'tok', 'pass', created_at FROM round_reviews WHERE id = ?`, [second, retired.id, review]);
    await archiveTaskRows([retired], true, cfg, { actor: "autopilot", stopAutopilot: true });
    expect(db.query("SELECT state FROM round_reviews WHERE id = ?").get(second)).toEqual({ state: "pass" });
  });

  test("a child archived on its own leaves its parent live, which hears about it", async () => {
    const parent = await make({ repoPath: await repo() });
    const kid = await child(parent);
    const events: string[] = [];
    const stop = subscribe((event) => { if (event.type === "task") events.push(event.taskId); });
    await archiveTaskRows([kid], false, cfg, {});
    stop();
    expect([archived(kid.id), archived(parent.id)]).toEqual([true, false]);
    expect(events.indexOf(kid.id)).toBeLessThan(events.lastIndexOf(parent.id));
  });

  test("a child created while the family was being checked refuses the archive", async () => {
    const parent = await make({ repoPath: await repo() });
    await child(parent);
    let late: Task | null = null;
    const original = worktree.archivePreflight;
    const preflight = spyOn(worktree, "archivePreflight").mockImplementation(async (...args) => {
      if (!late) late = await child(parent);
      return original(...args);
    });
    try {
      const refused = await archiveTaskRows([parent], false, cfg, { subtasks: "archive" });
      expect(refused).toMatchObject({ status: 409, error: expect.stringContaining("was created while task") });
    } finally { preflight.mockRestore(); }
    expect(archived(parent.id)).toBe(false);
  });

  test("a project removal covers the children and forces the reviewers in its batch", async () => {
    const parent = await make({ repoPath: await repo() });
    const kid = await child(parent);
    const review = await reviewer(parent);
    const done = await archiveTaskRows([parent, kid, review], false, cfg, { reason: "project removed" });
    if ("error" in done) throw new Error(done.error);
    expect([parent, kid, review].map((task) => archived(task.id))).toEqual([true, true, true]);
    expect(archiveCleanup(review.id)).toMatchObject({ force: true });
  });
});

describe("purging a family", () => {
  test("a parent with an unarchived child is refused, in the bulk plan too; once purged, its archived children are orphans", async () => {
    const parent = await make({ repoPath: await repo() });
    const kid = await child(parent);
    // the parent archived alone, the child still live: a state only the database can build now
    db.run("UPDATE tasks SET archived = 1 WHERE id = ?", [parent.id]);
    await expect(purgeTask(getTask(parent.id)!)).rejects.toThrow("This task has 1 unarchived subtask");
    const plan = await planBulkPurge(new Date(Date.now() + 60_000).toISOString());
    expect(plan.tasks.find((row) => row.id === parent.id)).toMatchObject({ bytes: null, error: expect.stringContaining("unarchived subtask") });
    expect((await planBulkPurge(plan.cutoff)).fingerprint).toBe(plan.fingerprint);
    await archiveTaskRows([kid], false, cfg, {});
    for (const id of [parent.id, kid.id]) clearArchiveCleanup(id);
    expect((await exportTask(getTask(parent.id)!)).subtasks).toEqual([kid.id]);
    expect((await exportTask(getTask(kid.id)!)).task).toMatchObject({ parent_task_id: parent.id });
    await purgeTask(getTask(parent.id)!);
    expect(getTask(parent.id)).toBeNull();
    expect(getTask(kid.id)).toMatchObject({ parent_task_id: null, subtask_kind: "explore", archived: 1 });
    expect(isOrphan(getTask(kid.id)!)).toBe(true);
  });
});
