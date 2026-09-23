import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateAdapters } from "../src/adapters";
import { loadConfig } from "../src/config";
import type { AutopilotGitHub, OpenPullRequest, PrSnapshot } from "../src/autopilot/github";
import { isTaskMerging } from "../src/autopilot/merging";
import { publishedWork } from "../src/autopilot/published";
import { AutopilotRuntime, choosePull } from "../src/autopilot/runtime";
import { autopilotRow, autopilotStatus, autopilotTurnNotes, checkpointOf, resumeAutopilot, setAutopilot, writeAutopilotCheckpoint } from "../src/autopilot/store";
import { formatAutopilot, prCommand } from "../src/cli-pr";
import { autopilotRoute } from "../src/routes/autopilot";
import { createTaskRoute, listTasksRoute } from "../src/routes/tasks";
import { interruptTurn, startNextQueuedMessage } from "../src/runner";
import { workflowRoute } from "../src/routes/workflows";
import { taskMessageAttachmentsFingerprint } from "../src/attachments";
import { createTask, createTaskMessage, db, freeSlot, getTask, newTaskId, newTaskMessageId, setTaskFields, transition } from "../src/store";
import { taskPreamble } from "../src/turn-input";
import type { Task } from "../src/types";
import { pauseTaskWorkflows } from "../src/workflows/store";

const HEAD = "c".repeat(40);
const START = Date.parse("2026-09-23T12:00:00Z");
const created: string[] = [];
afterEach(() => { for (const id of created.splice(0)) db.run("DELETE FROM tasks WHERE id = ?", [id]); });

function doneTask(over: Partial<Parameters<typeof createTask>[0]> = {}): Task {
  const id = newTaskId();
  createTask({ id, title: "Autopilot fixture", repo_path: "/fixture/repo", harness: "fake", model: null, slot: freeSlot(), ...over });
  created.push(id);
  setTaskFields(id, { worktree_path: "/fixture/worktree", branch: `wisp/${id}-fixture` });
  transition(id, "done");
  return getTask(id)!;
}

function snapshot(over: Partial<PrSnapshot> = {}): PrSnapshot {
  return {
    number: 7, url: "https://github.com/o/r/pull/7", state: "OPEN", isDraft: false, isCrossRepository: false,
    head: HEAD, headRefName: "wisp/fixture", baseRefName: "main", defaultBranch: "main", mergeState: "CLEAN",
    reviewDecision: null, queued: false, providerAutoMerge: false, mergedBy: null, viewer: "owner",
    checks: [{ name: "test", status: "COMPLETED", conclusion: "SUCCESS", required: true, url: "" }],
    actionsSuitesPending: 0, actionsSuitesWaiting: 0, reviews: [], unresolvedThreads: 0, mergeMethod: "SQUASH", ...over,
  };
}

/** A PR the task could have opened: by the viewer, after the task existed. */
function pull(over: Partial<OpenPullRequest> = {}): OpenPullRequest {
  return { number: 7, headRefName: "wisp/fixture", baseRefName: "main", createdAt: new Date(Date.now() + 60_000).toISOString(), isCrossRepository: false, author: "owner", ...over };
}

/** A fake GitHub the test can steer, and that records every merge it is asked for. */
function fakeGitHub(initial: { pulls?: OpenPullRequest[]; pr?: PrSnapshot } = {}) {
  const state = {
    pulls: initial.pulls ?? [pull()],
    pr: initial.pr ?? snapshot(),
    required: ["test"],
    merges: [] as { number: number; method: string; head: string }[],
    mergeResult: { ok: true, detail: "" } as { ok: boolean; detail: string },
    onMerge: null as null | (() => Promise<void> | void),
    onSnapshot: null as null | (() => void),
  };
  const github: AutopilotGitHub = {
    async snapshot() { state.onSnapshot?.(); return structuredClone(state.pr); },
    async openPullRequests() { return { defaultBranch: "main", viewer: "owner", pulls: state.pulls }; },
    async requiredChecks() { return state.required; },
    async merge(input) {
      state.merges.push({ number: input.number, method: input.method, head: input.head });
      await state.onMerge?.();
      if (state.mergeResult.ok) state.pr = { ...state.pr, state: "MERGED", mergedBy: "owner" };
      return state.mergeResult;
    },
  };
  return { state, github };
}

function runtime(github: AutopilotGitHub, clock: { now: number }, adapters = {}) {
  return new AutopilotRuntime(loadConfig(), adapters, {
    now: () => new Date(clock.now), github,
    repository: async () => "o/r", branches: async (task) => [task.branch!],
    published: async () => ({ ok: true }),
  });
}

/** Bound to #7, with its head and its ready-for-review long enough ago that checks are believed. */
function seed(taskId: string, clock: { now: number }, extra: Record<string, unknown> = {}) {
  const past = new Date(START).toISOString();
  writeAutopilotCheckpoint(autopilotRow(taskId)!, { pr: 7, heads: { [HEAD]: past }, readySince: past, ...extra }, new Date(clock.now));
}

/** Make the row due and run one pass. */
async function pass(rt: AutopilotRuntime, taskId: string, clock: { now: number }) {
  db.run("UPDATE workflows SET next_check_at = ? WHERE task_id = ? AND type = 'pr-autopilot' AND state != 'completed'", [new Date(clock.now).toISOString(), taskId]);
  await rt.tick();
}

describe("arming", () => {
  test("toggling on arms one row, toggling again changes nothing, toggling off stands down", () => {
    const task = doneTask();
    expect(autopilotStatus(task.id)).toMatchObject({ autoMerge: false, state: "off" });
    expect(setAutopilot(task.id, { autoMerge: true })).toMatchObject({ autoMerge: true, state: "waiting", reason: "Waiting for a PR" });
    const row = autopilotRow(task.id)!;
    setAutopilot(task.id, { autoMerge: true });
    expect(autopilotRow(task.id)!.id).toBe(row.id);
    expect(autopilotRow(task.id)!.revision).toBe(row.revision);
    expect(setAutopilot(task.id, { autoMerge: false })).toMatchObject({ autoMerge: false, state: "off" });
    expect(autopilotRow(task.id)).toBeNull();
  });

  test("auto-fix is not offered yet, and a local task cannot auto-merge", () => {
    const task = doneTask();
    expect(() => setAutopilot(task.id, { autoFix: true })).toThrow("not available yet");
    const local = doneTask({ mode: "local" });
    expect(() => setAutopilot(local.id, { autoMerge: true })).toThrow("own branch");
  });

  test("autopilot is not a workflow to the rest of the daemon", async () => {
    const task = doneTask();
    setAutopilot(task.id, { autoMerge: true });
    const list = await workflowRoute(new Request("http://wisp.test/x"), `/api/tasks/${task.id}/workflows`);
    expect(await list.json()).toEqual([]);
    const row = autopilotRow(task.id)!;
    const path = `/api/workflows/${row.id}/pause`;
    expect((await workflowRoute(new Request(`http://wisp.test${path}`, { method: "POST", body: "{}" }), path)).status).toBe(409);
    const listed = (await listTasksRoute(new URL("http://wisp.test/api/tasks")).json()) as Array<{ id: string; has_workflow: boolean; autopilot: unknown }>;
    const entry = listed.find((t) => t.id === task.id)!;
    // the workflow ring would hide a needs-input or failed fill for a PR's lifetime
    expect(entry.has_workflow).toBe(false);
    expect(entry.autopilot).toMatchObject({ autoMerge: true, state: "waiting" });
  });
});

describe("the loop", () => {
  test("binds to the task's PR, waits out a fresh head, then squash-merges exactly that head", async () => {
    const task = doneTask();
    const clock = { now: START };
    const { state, github } = fakeGitHub();
    const rt = runtime(github, clock);
    setAutopilot(task.id, { autoMerge: true });
    await pass(rt, task.id, clock);
    expect(autopilotStatus(task.id)).toMatchObject({ pr: 7, state: "waiting", reason: "Waiting for checks to start" });
    expect(state.merges).toHaveLength(0);
    clock.now += 3 * 60_000;
    await pass(rt, task.id, clock);
    expect(state.merges).toEqual([{ number: 7, method: "SQUASH", head: HEAD }]);
    expect(autopilotStatus(task.id)).toMatchObject({ state: "merged", reason: "Merged by Wisp", pr: 7, autoMerge: false });
    // the agent hears once that its branch is finished, and never again
    const merged = autopilotTurnNotes(task.id);
    expect(merged.notes).toEqual(["PR #7 was merged by Wisp. Its branch is finished: start any further change on a new branch from origin/main."]);
    // not spent until a turn really starts with it
    expect(autopilotTurnNotes(task.id).notes).toHaveLength(1);
    merged.delivered();
    expect(autopilotTurnNotes(task.id).notes).toEqual([]);
  });

  test("with no open PR it waits; the oldest PR onto the base wins over a stacked child", async () => {
    const task = doneTask();
    const clock = { now: START };
    const { state, github } = fakeGitHub({ pulls: [] });
    const rt = runtime(github, clock);
    setAutopilot(task.id, { autoMerge: true });
    await pass(rt, task.id, clock);
    expect(autopilotStatus(task.id)).toMatchObject({ pr: null, reason: "Waiting for a PR" });
    const later = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();
    state.pulls = [
      pull({ number: 9, headRefName: "wisp/child", baseRefName: "wisp/fixture", createdAt: later(1) }),
      pull({ number: 8, headRefName: "wisp/fixture", baseRefName: "main", createdAt: later(2) }),
    ];
    await pass(rt, task.id, clock);
    expect(autopilotStatus(task.id).pr).toBe(8);
  });

  test("a busy task is never merged, and settling brings its check forward", async () => {
    const task = doneTask();
    const clock = { now: START + 10 * 60_000 };
    const { state, github } = fakeGitHub();
    const rt = runtime(github, clock);
    setAutopilot(task.id, { autoMerge: true });
    seed(task.id, clock);
    transition(task.id, "running");
    await pass(rt, task.id, clock);
    expect(state.merges).toHaveLength(0);
    expect(autopilotStatus(task.id).reason).toBe("Waiting for the task to finish");
    transition(task.id, "needs-input");
    await pass(rt, task.id, clock);
    expect(autopilotStatus(task.id).reason).toBe("Waiting for your answer");
    expect(state.merges).toHaveLength(0);
  });

  test("Stop holds it until the owner's next turn has finished, then it carries on by itself", async () => {
    const task = doneTask();
    const clock = { now: START + 10 * 60_000 };
    const { state, github } = fakeGitHub();
    const rt = runtime(github, clock);
    setAutopilot(task.id, { autoMerge: true });
    seed(task.id, clock);
    pauseTaskWorkflows(task.id);
    expect(autopilotStatus(task.id)).toMatchObject({ state: "held", autoMerge: true });
    // stopping only a background process leaves the task done — still held
    await pass(rt, task.id, clock);
    expect(state.merges).toHaveLength(0);
    expect(autopilotStatus(task.id).state).toBe("held");
    setTaskFields(task.id, { turn_count: task.turn_count + 1 });
    await pass(rt, task.id, clock);
    expect(state.merges).toHaveLength(1);
  });

  test("Continue now releases a Stop hold early", async () => {
    const task = doneTask();
    setAutopilot(task.id, { autoMerge: true });
    pauseTaskWorkflows(task.id);
    expect(autopilotStatus(task.id).state).toBe("held");
    expect(resumeAutopilot(task.id)).toMatchObject({ state: "waiting" });
    expect(checkpointOf(autopilotRow(task.id)!).stopHold).toBeUndefined();
  });

  test("an agent or context change does not switch it off: it follows the task", async () => {
    const task = doneTask();
    const clock = { now: START };
    const { github } = fakeGitHub();
    const rt = runtime(github, clock);
    setAutopilot(task.id, { autoMerge: true });
    db.run("UPDATE tasks SET context_n = context_n + 1 WHERE id = ?", [task.id]);
    expect(autopilotRow(task.id)!.state).toBe("paused");
    expect(autopilotStatus(task.id)).toMatchObject({ state: "waiting", reason: "Following the task's agent change" });
    await rt.tick();
    expect(autopilotRow(task.id)!.state).toBe("active");
  });

  test("archive stands it down through the existing trigger", () => {
    const task = doneTask();
    setAutopilot(task.id, { autoMerge: true });
    setTaskFields(task.id, { archived: 1 });
    expect(autopilotRow(task.id)).toBeNull();
    expect(autopilotStatus(task.id).autoMerge).toBe(false);
  });

  test("a closed PR turns auto-merge off rather than moving on to another", async () => {
    const task = doneTask();
    const clock = { now: START };
    const { state, github } = fakeGitHub();
    const rt = runtime(github, clock);
    setAutopilot(task.id, { autoMerge: true });
    state.pr = snapshot({ state: "CLOSED" });
    await pass(rt, task.id, clock);
    expect(autopilotStatus(task.id)).toMatchObject({ state: "off", reason: "Auto-merge off — #7 was closed" });
  });

  test("a merge that lands before a crash is still recorded as Wisp's", async () => {
    const task = doneTask();
    const clock = { now: START };
    const { state, github } = fakeGitHub({ pr: snapshot({ state: "MERGED" }) });
    const rt = runtime(github, clock);
    setAutopilot(task.id, { autoMerge: true });
    writeAutopilotCheckpoint(autopilotRow(task.id)!, { pr: 7, mergeAttempt: { head: HEAD, at: new Date(START).toISOString() } }, new Date(clock.now));
    await pass(rt, task.id, clock);
    expect(state.merges).toHaveLength(0);
    expect(autopilotStatus(task.id)).toMatchObject({ state: "merged", reason: "Merged by Wisp" });
  });

  test("merge failures retry, then pause for Resume; GitHub's own auto-merge also pauses", async () => {
    const task = doneTask();
    const clock = { now: START + 10 * 60_000 };
    const { state, github } = fakeGitHub();
    const rt = runtime(github, clock);
    setAutopilot(task.id, { autoMerge: true });
    seed(task.id, clock);
    state.mergeResult = { ok: false, detail: "Base branch was modified" };
    for (let attempt = 1; attempt <= 3; attempt++) await pass(rt, task.id, clock);
    expect(state.merges).toHaveLength(3);
    expect(autopilotStatus(task.id)).toMatchObject({ state: "paused", reason: "Merge failed: Base branch was modified" });
    await pass(rt, task.id, clock);
    expect(state.merges).toHaveLength(3);
    resumeAutopilot(task.id);
    state.pr = snapshot({ providerAutoMerge: true });
    await pass(rt, task.id, clock);
    expect(autopilotStatus(task.id)).toMatchObject({ state: "paused", reason: expect.stringContaining("GitHub auto-merge was turned on") });
  });

  test("turning it off while GitHub is being asked wins over the answer", async () => {
    const task = doneTask();
    const clock = { now: START + 10 * 60_000 };
    const { state, github } = fakeGitHub();
    const rt = runtime(github, clock);
    setAutopilot(task.id, { autoMerge: true });
    seed(task.id, clock);
    state.onSnapshot = () => { setAutopilot(task.id, { autoMerge: false }); };
    await pass(rt, task.id, clock);
    expect(state.merges).toHaveLength(0);
  });

  test("no new turn can start while the merge runs, and the queue drains when it ends", async () => {
    const task = doneTask();
    const clock = { now: START + 10 * 60_000 };
    const { state, github } = fakeGitHub();
    const rt = runtime(github, clock);
    setAutopilot(task.id, { autoMerge: true });
    seed(task.id, clock);
    let during = false;
    state.onMerge = () => { during = isTaskMerging(task.id); };
    await pass(rt, task.id, clock);
    expect(during).toBe(true);
    expect(isTaskMerging(task.id)).toBe(false);
  });
});

async function until(check: () => boolean, what: string) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (check()) return;
    await Bun.sleep(25);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** A harness that writes the prompt it was given to a file, so a test can read exactly what the agent saw. */
function capture() {
  const dir = mkdtempSync(join(tmpdir(), "wisp-autopilot-turn-"));
  const file = join(dir, "prompt.txt");
  const adapters = validateAdapters({ capture: { bin: "bash", exec: ["-c", `printf '%s' "$0" > '${file}'; printf 'done\\n'`], parse: { format: "text" } } });
  return { dir, file, adapters };
}
function queue(taskId: string, text: string) {
  createTaskMessage({ id: newTaskMessageId(), taskId, text, attachmentHash: taskMessageAttachmentsFingerprint([]) });
}

describe("binding and the edges of a merge", () => {
  test("only a PR this task could have opened is adopted", () => {
    const task = doneTask();
    const bases = new Set(["main"]);
    const later = new Date(Date.parse(task.created_at) + 60_000).toISOString();
    const before = new Date(Date.parse(task.created_at) - 60_000).toISOString();
    // someone else's PR the worktree checked out, and the owner's older PR, are never adopted
    expect(choosePull([pull({ number: 3, author: "colleague", createdAt: later })], task, "owner", bases)).toBeNull();
    expect(choosePull([pull({ number: 4, createdAt: before })], task, "owner", bases)).toBeNull();
    expect(choosePull([pull({ number: 5, isCrossRepository: true, createdAt: later })], task, "owner", bases)).toBeNull();
    expect(choosePull([pull({ number: 6, createdAt: later })], task, "", bases)).toBeNull();
    // the task's own branch name wins over an older PR from another checkout
    const own = pull({ number: 8, headRefName: task.branch!, createdAt: new Date(Date.parse(later) + 60_000).toISOString() });
    expect(choosePull([pull({ number: 7, headRefName: "wisp/other", createdAt: later }), own], task, "owner", bases)?.number).toBe(8);
  });

  test("a gh merge whose read-back lags is confirmed on the next look, not counted as a failure", async () => {
    const task = doneTask();
    const clock = { now: START + 10 * 60_000 };
    const { state, github } = fakeGitHub();
    github.merge = async (input) => { state.merges.push({ number: input.number, method: input.method, head: input.head }); return { ok: true, detail: "" }; };
    const rt = runtime(github, clock);
    setAutopilot(task.id, { autoMerge: true });
    seed(task.id, clock);
    await pass(rt, task.id, clock);
    expect(autopilotStatus(task.id)).toMatchObject({ state: "merging", reason: "Confirming the merge" });
    expect(checkpointOf(autopilotRow(task.id)!).mergeAttempt?.head).toBe(HEAD);
    state.pr = snapshot({ state: "MERGED" });
    await pass(rt, task.id, clock);
    expect(autopilotStatus(task.id)).toMatchObject({ state: "merged", reason: "Merged by Wisp" });
  });

  test("a paused row still notices that its PR was merged", async () => {
    const task = doneTask();
    const clock = { now: START };
    const { state, github } = fakeGitHub();
    const rt = runtime(github, clock);
    setAutopilot(task.id, { autoMerge: true });
    seed(task.id, clock);
    db.run("UPDATE workflows SET state = 'paused', reason = 'Merge failed: x' WHERE task_id = ? AND type = 'pr-autopilot'", [task.id]);
    state.pr = snapshot({ state: "MERGED" });
    await pass(rt, task.id, clock);
    expect(autopilotStatus(task.id)).toMatchObject({ state: "merged", reason: "#7 was merged" });
  });

  test("marking a draft ready restarts the wait for its checks", async () => {
    const task = doneTask();
    const clock = { now: START + 10 * 60_000 };
    const { state, github } = fakeGitHub({ pr: snapshot({ isDraft: true }) });
    const rt = runtime(github, clock);
    setAutopilot(task.id, { autoMerge: true });
    seed(task.id, clock);
    await pass(rt, task.id, clock);
    expect(autopilotStatus(task.id).reason).toContain("Draft");
    state.pr = snapshot({ isDraft: false });
    await pass(rt, task.id, clock);
    expect(state.merges).toHaveLength(0);
    expect(autopilotStatus(task.id).reason).toBe("Waiting for checks to start");
    clock.now += 3 * 60_000;
    await pass(rt, task.id, clock);
    expect(state.merges).toHaveLength(1);
  });

  test("a task settling brings its check forward through the event bus", async () => {
    const task = doneTask();
    const clock = { now: START };
    const { github } = fakeGitHub({ pulls: [] });
    const rt = runtime(github, clock);
    setAutopilot(task.id, { autoMerge: true });
    db.run("UPDATE workflows SET next_check_at = '9999-01-01T00:00:00.000Z' WHERE task_id = ? AND type = 'pr-autopilot'", [task.id]);
    rt.start();
    try {
      transition(task.id, "running");
      transition(task.id, "done");
      await until(() => autopilotRow(task.id)!.check_count > 0, "the settle kick");
    } finally {
      await rt.stop();
    }
  });

  test("a PR that exists but is not the task's own is named, not hidden behind \"waiting for a PR\"", async () => {
    const task = doneTask();
    const clock = { now: START };
    const { github } = fakeGitHub({ pulls: [pull({ number: 11, author: "ci-bot" })] });
    const rt = runtime(github, clock);
    setAutopilot(task.id, { autoMerge: true });
    await pass(rt, task.id, clock);
    expect(autopilotStatus(task.id)).toMatchObject({ pr: null, reason: "Waiting for this task's own PR (#11 was opened by @ci-bot, not @owner)" });
  });

  test("a turn after Stop that FAILS does not release the hold", async () => {
    const task = doneTask();
    const clock = { now: START + 10 * 60_000 };
    const { state, github } = fakeGitHub();
    const rt = runtime(github, clock);
    setAutopilot(task.id, { autoMerge: true });
    seed(task.id, clock);
    pauseTaskWorkflows(task.id);
    setTaskFields(task.id, { turn_count: task.turn_count + 1 });
    transition(task.id, "failed", "exited 1");
    await pass(rt, task.id, clock);
    expect(autopilotStatus(task.id).state).toBe("held");
    expect(state.merges).toHaveLength(0);
  });

  test("while a merge is being confirmed, a turn is told not to push", () => {
    const task = doneTask();
    const clock = { now: START };
    setAutopilot(task.id, { autoMerge: true });
    seed(task.id, clock, { mergeAttempt: { head: HEAD, at: new Date(START).toISOString() } });
    expect(autopilotTurnNotes(task.id).notes[0]).toContain("Do not push to its branch");
  });

  test("Stop holds it even when there was no turn left to stop", async () => {
    const task = doneTask();
    setAutopilot(task.id, { autoMerge: true });
    await interruptTurn(task.id).catch(() => undefined);
    expect(autopilotStatus(task.id).state).toBe("held");
  });
});

describe("what the agent is told", () => {
  test("a turn queued during the merge waits for it, then hears the branch is finished", async () => {
    const { dir, file, adapters } = capture();
    const task = doneTask({ harness: "capture" });
    setTaskFields(task.id, { worktree_path: dir, turn_count: 1 });
    const clock = { now: START + 10 * 60_000 };
    const { state, github } = fakeGitHub();
    const rt = runtime(github, clock, adapters);
    setAutopilot(task.id, { autoMerge: true });
    seed(task.id, clock);
    let refused: unknown = "not asked";
    state.onMerge = () => {
      queue(task.id, "also fix the typo");
      refused = startNextQueuedMessage(task.id, adapters, loadConfig());
    };
    await pass(rt, task.id, clock);
    expect(refused).toBeNull();
    await until(() => existsSync(file), "the queued turn");
    const prompt = readFileSync(file, "utf8");
    expect(prompt).toContain("PR #7 was merged by Wisp. Its branch is finished");
    expect(prompt).not.toContain("Auto-merge is on");
    expect(prompt.endsWith("also fix the typo")).toBe(true);
    await until(() => getTask(task.id)?.state === "done", "the turn to settle");
  });

  test("a later turn's slash command is left alone; the note waits for a plain turn", async () => {
    const { dir, file, adapters } = capture();
    const task = doneTask({ harness: "capture" });
    setTaskFields(task.id, { worktree_path: dir, turn_count: 1 });
    setAutopilot(task.id, { autoMerge: true });
    queue(task.id, "/compact");
    expect(startNextQueuedMessage(task.id, adapters, loadConfig())).not.toBeNull();
    await until(() => existsSync(file), "the command turn");
    expect(readFileSync(file, "utf8")).toBe("/compact");
    await until(() => getTask(task.id)?.state === "done", "the turn to settle");
  });

  test("while auto-merge is on, every turn says a push is wanted and the merge is Wisp's", () => {
    const task = doneTask();
    expect(autopilotTurnNotes(task.id).notes).toEqual([]);
    setAutopilot(task.id, { autoMerge: true });
    const [note] = autopilotTurnNotes(task.id).notes;
    expect(note).toContain("push the branch, and open a pull request");
    expect(note).toContain("Wisp merges this task's pull request");
    expect(note).toContain("Other pull requests are unaffected");
    const preamble = taskPreamble(task, [note!]);
    expect(preamble.indexOf(note!)).toBeLessThan(preamble.indexOf("Task:"));
  });
});

describe("the published-work check", () => {
  function repo() {
    const dir = mkdtempSync(join(tmpdir(), "wisp-autopilot-git-"));
    const git = (...args: string[]) => {
      const result = Bun.spawnSync(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args], { cwd: dir });
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      return result.stdout.toString().trim();
    };
    git("init", "-q", "-b", "wisp/fixture");
    writeFileSync(join(dir, "a.txt"), "one\n");
    git("add", ".");
    git("commit", "-q", "-m", "one");
    return { dir, git, head: git("rev-parse", "HEAD") };
  }
  const task = (dir: string): Task => ({ ...doneTask(), repo_path: dir, worktree_path: dir });
  const signal = new AbortController().signal;

  test("the PR head matching the branch, with only untracked files around, is published", async () => {
    const { dir, head } = repo();
    writeFileSync(join(dir, "codedb.snapshot"), "an index some tool dropped here");
    expect(await publishedWork(task(dir), "wisp/fixture", head, signal)).toEqual({ ok: true });
  });

  test("a local commit the PR lacks, or a tracked edit, blocks the merge", async () => {
    const { dir, git, head } = repo();
    writeFileSync(join(dir, "a.txt"), "two\n");
    expect(await publishedWork(task(dir), "wisp/fixture", head, signal)).toEqual({ ok: false, reason: "Worktree has uncommitted changes" });
    git("commit", "-q", "-am", "two");
    expect(await publishedWork(task(dir), "wisp/fixture", head, signal)).toEqual({ ok: false, reason: "Worktree has commits the PR does not" });
  });

  test("a PR ahead of the local branch is fine; a head nobody can find is not verifiable", async () => {
    const { dir, git, head } = repo();
    writeFileSync(join(dir, "a.txt"), "two\n");
    git("commit", "-q", "-am", "two");
    const ahead = git("rev-parse", "HEAD");
    git("reset", "-q", "--hard", head);
    expect(await publishedWork(task(dir), "wisp/fixture", ahead, signal)).toEqual({ ok: true });
    expect(await publishedWork(task(dir), "wisp/fixture", "d".repeat(40), signal)).toEqual({ ok: false, reason: "Can't verify the worktree" });
  });

  test("a PR head only the remote has is fetched, then checked", async () => {
    const origin = repo();
    const clone = mkdtempSync(join(tmpdir(), "wisp-autopilot-clone-"));
    const cloned = Bun.spawnSync(["git", "clone", "-q", origin.dir, clone]);
    expect(cloned.exitCode, cloned.stderr.toString()).toBe(0);
    // "Update branch", or a suggestion committed on GitHub: the remote moved on
    writeFileSync(join(origin.dir, "a.txt"), "remote only\n");
    origin.git("commit", "-q", "-am", "remote only");
    const remoteHead = origin.git("rev-parse", "HEAD");
    expect(Bun.spawnSync(["git", "cat-file", "-e", remoteHead], { cwd: clone }).exitCode).not.toBe(0);
    expect(await publishedWork(task(clone), "wisp/fixture", remoteHead, signal)).toEqual({ ok: true });
  });

  test("a worktree that moved on to unrelated work has not unpublished the PR", async () => {
    const { dir, git, head } = repo();
    git("checkout", "-q", "--orphan", "wisp/second");
    git("rm", "-q", "-rf", ".");
    writeFileSync(join(dir, "b.txt"), "unrelated\n");
    git("add", ".");
    git("commit", "-q", "-m", "unrelated");
    writeFileSync(join(dir, "b.txt"), "dirty on another line of work\n");
    expect(await publishedWork(task(dir), "wisp/fixture", head, signal)).toEqual({ ok: true });
  });

  test("work built on the PR under another name, or on a detached HEAD, is caught", async () => {
    const { dir, git, head } = repo();
    // renamed: the PR's branch name is gone locally, the extra commit is not
    git("branch", "-m", "wisp/renamed");
    writeFileSync(join(dir, "a.txt"), "two\n");
    git("commit", "-q", "-am", "two");
    expect(await publishedWork(task(dir), "wisp/fixture", head, signal)).toEqual({ ok: false, reason: "Branch wisp/renamed has unpushed commits built on the PR" });
    // detached, with an extra commit and nothing else pointing at it
    const second = repo();
    second.git("checkout", "-q", "--detach");
    writeFileSync(join(second.dir, "a.txt"), "two\n");
    second.git("commit", "-q", "-am", "two");
    expect(await publishedWork(task(second.dir), "wisp/fixture", second.head, signal)).toEqual({ ok: false, reason: "Worktree has commits the PR does not" });
    // an unpushed branch built on the PR, while HEAD sits back on the PR itself
    const third = repo();
    third.git("checkout", "-q", "-b", "wisp/extra");
    writeFileSync(join(third.dir, "a.txt"), "two\n");
    third.git("commit", "-q", "-am", "two");
    third.git("checkout", "-q", "wisp/fixture");
    expect(await publishedWork(task(third.dir), "wisp/fixture", third.head, signal)).toEqual({ ok: false, reason: "Branch wisp/extra has unpushed commits built on the PR" });
  });

  test("a stacked child that was pushed for its own PR does not hold its parent back", async () => {
    const { dir, git, head } = repo();
    git("checkout", "-q", "-b", "wisp/child");
    writeFileSync(join(dir, "a.txt"), "child\n");
    git("commit", "-q", "-am", "child");
    // what `git push` leaves behind: a remote-tracking ref at the child's tip
    git("update-ref", "refs/remotes/origin/wisp/child", "HEAD");
    expect(await publishedWork(task(dir), "wisp/fixture", head, signal)).toEqual({ ok: true });
  });

  test("a rebase in progress on the PR's line is not something to merge under", async () => {
    const { dir, git, head } = repo();
    const gitDir = git("rev-parse", "--git-dir");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(dir, gitDir, "rebase-merge"));
    expect(await publishedWork(task(dir), "wisp/fixture", head, signal)).toEqual({ ok: false, reason: "Worktree has a rebase or merge in progress" });
  });
});

describe("API and CLI", () => {
  const call = (taskId: string, method: string, body?: unknown, suffix = "") => {
    const path = `/api/tasks/${taskId}/autopilot${suffix}`;
    return autopilotRoute(new Request(`http://wisp.test${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), path);
  };

  test("a create request says what to arm, and a bad one is refused before any task exists", async () => {
    const create = (body: Record<string, unknown>) => createTaskRoute(new Request("http://wisp.test/api/tasks", {
      method: "POST", body: JSON.stringify({ repoPath: "/tmp/nowhere", prompt: "p", harness: "fake", ...body }),
    }), loadConfig(), {});
    expect((await create({ autopilot: "yes" })).status).toBe(400);
    expect((await create({ autopilot: { autoFix: true } })).status).toBe(400);
    expect((await create({ autopilot: { autoMerge: "on" } })).status).toBe(400);
    const local = await create({ mode: "local", autopilot: { autoMerge: true } });
    expect(local.status).toBe(400);
    expect(await local.text()).toContain("auto-merge needs a worktree task");
  });

  test("the route validates, toggles, and resumes", async () => {
    const task = doneTask();
    expect((await call(task.id, "PUT", { autoMerge: "yes" })).status).toBe(400);
    expect((await call(task.id, "PUT", { whatever: true })).status).toBe(400);
    expect((await call(task.id, "PUT", { autoFix: true })).status).toBe(400);
    expect((await call(task.id, "POST", {}, "/resume")).status).toBe(409);
    expect(await (await call(task.id, "PUT", { autoMerge: true })).json()).toMatchObject({ autoMerge: true });
    expect(await (await call(task.id, "GET")).json()).toMatchObject({ autoMerge: true, state: "waiting" });
    expect((await call("tnope1", "GET")).status).toBe(404);
  });

  test("wisp pr prints one line and drives the same route", async () => {
    expect(formatAutopilot({ autoMerge: true, autoFix: false, pr: 7, state: "waiting", reason: "Waiting for checks (2 running)", updatedAt: null }))
      .toBe("auto-merge: on · PR #7 · waiting · Waiting for checks (2 running)");
    expect(formatAutopilot({ autoMerge: false, autoFix: false, pr: 7, state: "merged", reason: "Merged by Wisp", updatedAt: null }))
      .toBe("auto-merge: done · PR #7 · Merged by Wisp");
    const calls: unknown[] = [];
    const api = async (...args: unknown[]) => { calls.push(args); return { autoMerge: true, autoFix: false, pr: null, state: "waiting", reason: "Waiting for a PR", updatedAt: null }; };
    await prCommand(["tabcde", "merge", "on"], { json: true }, api);
    await prCommand(["tabcde", "resume"], { json: true }, api);
    expect(calls).toEqual([["/api/tasks/tabcde/autopilot", "PUT", { autoMerge: true }], ["/api/tasks/tabcde/autopilot/resume", "POST", {}]]);
    await expect(prCommand(["tabcde", "merge", "maybe"], {}, api)).rejects.toThrow("usage");
  });
});
