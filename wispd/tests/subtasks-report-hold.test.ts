// Routine subtask reports to an idle parent wait a little for siblings still
// working (REPORT_IDLE_HOLD_MS), so a fan-out's results cost the parent one
// turn rather than one each; anything that asks the parent to act goes at once.
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import type { AdapterDef } from "../src/adapters";
import type { WispConfig } from "../src/config";
import { createAndLaunchTask, type NewTaskInput } from "../src/domain/task-create";
import { hasRunningTurn } from "../src/runner";
import { db, getTask, transition, turnsFor } from "../src/store";
import { REPORT_IDLE_HOLD_MS, siblingHoldUntil, SubtaskDelivery } from "../src/subtask-delivery";
import { recordStuckReport } from "../src/subtask-reports";
import type { Task } from "../src/types";

const cfg = (): WispConfig => ({
  instanceId: "123e4567-e89b-42d3-a456-426614174000", port: 0, host: "127.0.0.1", token: "test", webhooks: [], repos: [],
  stuckMinutes: 10, logMaxBytes: 5_000_000, setupTimeoutMinutes: 10, envAllowlist: {}, harnessDefaults: {},
});
const scratch = () => realpathSync(mkdtempSync(join(tmpdir(), "wisp-report-hold-")));
const held = (gate: string): AdapterDef => ({ bin: "bash", exec: ["-c", `while [ ! -e '${gate}' ]; do sleep 0.05; done; printf done`], parse: { format: "text" }, attach: null });
const quick: AdapterDef = { bin: "bash", exec: ["-c", "printf 'finished'"], parse: { format: "text" }, attach: null };

async function repo(): Promise<string> {
  const path = scratch();
  for (const args of [["init", "-q"], ["commit", "-q", "--allow-empty", "-m", "init"]]) {
    const proc = Bun.spawn(["git", "-c", "user.name=Hold Test", "-c", "user.email=hold@example.invalid", ...args], { cwd: path, stdout: "ignore", stderr: "pipe" });
    if ((await proc.exited) !== 0) throw new Error(await new Response(proc.stderr).text());
  }
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

async function launch(input: Partial<NewTaskInput>, adapters: Record<string, AdapterDef>): Promise<Task> {
  const result = await createAndLaunchTask({ repoPath: "", prompt: "work", harness: "quick", fast: false, mode: "worktree", actor: "cli", ...input }, cfg(), adapters, null);
  if ("error" in result) throw new Error(result.error);
  return result.task;
}
async function finished(input: Partial<NewTaskInput>, adapters: Record<string, AdapterDef>): Promise<Task> {
  const task = await launch(input, adapters);
  await until(() => settled(task.id), `task ${task.id} to settle`);
  return getTask(task.id)!;
}
async function working(input: Partial<NewTaskInput>, adapters: Record<string, AdapterDef>): Promise<Task> {
  const task = await launch({ harness: "held", ...input }, adapters);
  await until(() => hasRunningTurn(task.id) !== null && getTask(task.id)!.state === "running", `task ${task.id} to run`);
  return getTask(task.id)!;
}

const reportRows = (parent: string) => db.query("SELECT child_task_id, kind, state, message_id FROM subtask_reports WHERE parent_task_id = ? ORDER BY rowid").all(parent) as
  { child_task_id: string; kind: string; state: string; message_id: string | null }[];
const reportMessages = (parent: string) => db.query("SELECT id, status FROM task_messages WHERE task_id = ? AND origin = 'subtask' ORDER BY rowid").all(parent) as
  { id: string; status: string }[];

describe("routine reports wait for siblings still working", () => {
  test("held while a sibling works, then one message carrying both once the last one settles", async () => {
    const gate = join(scratch(), "open");
    const adapters = { quick, held: held(gate) };
    const parent = await finished({ repoPath: await repo() }, adapters);
    const early = await finished({ subtask: { parentId: parent.id, report: true } }, adapters);
    const late = await working({ subtask: { parentId: parent.id, report: true } }, adapters);
    // a sibling that will not report back is working too, but holds nothing (siblingHoldUntil's own test below)
    const silent = await working({ subtask: { parentId: parent.id, report: false } }, adapters);
    const delivery = new SubtaskDelivery(cfg(), adapters, 0, 60_000);
    try {
      delivery.deliver(parent.id);
      expect(reportMessages(parent.id)).toEqual([]);
      expect(reportRows(parent.id).map((row) => [row.child_task_id, row.state])).toEqual([[early.id, "pending"]]);
      expect(siblingHoldUntil(parent.id, 60_000)).toBeGreaterThan(Date.now());

      await Bun.write(gate, "");
      await until(() => settled(late.id) && settled(silent.id) && reportRows(parent.id).length === 2, "the late child's report");
      delivery.deliver(parent.id);
      const [message] = reportMessages(parent.id);
      expect(reportMessages(parent.id)).toHaveLength(1);
      await until(() => turnsFor(parent.id).length === 2 && settled(parent.id), "the parent's one report turn");
      expect(reportRows(parent.id).map((row) => [row.child_task_id, row.state, row.message_id])).toEqual([
        [early.id, "delivered", message!.id],
        [late.id, "delivered", message!.id],
      ]);
      expect(turnsFor(parent.id)[1]).toMatchObject({ origin: "report", source_message_id: message!.id });
    } finally {
      await delivery.stop();
    }
  }, 20_000);

  test("the hold ends on its own at its deadline, with the sibling still working", async () => {
    const gate = join(scratch(), "open");
    const adapters = { quick, held: held(gate) };
    const parent = await finished({ repoPath: await repo() }, adapters);
    const early = await finished({ subtask: { parentId: parent.id, report: true } }, adapters);
    await working({ subtask: { parentId: parent.id, report: true } }, adapters);
    const delivery = new SubtaskDelivery(cfg(), adapters, 0, 400);
    try {
      delivery.deliver(parent.id);
      expect(reportMessages(parent.id)).toEqual([]);
      // no further pass is asked for: the hold's own wake delivers it
      await until(() => reportRows(parent.id).every((row) => row.state === "delivered"), "the held report to go at its deadline");
      expect(reportRows(parent.id).map((row) => row.child_task_id)).toEqual([early.id]);
    } finally {
      await delivery.stop();
      await Bun.write(gate, "");
    }
  }, 20_000);

  test("a report that asks the parent to act goes at once and brings the held one with it", async () => {
    const gate = join(scratch(), "open");
    const adapters = { quick, held: held(gate) };
    const parent = await finished({ repoPath: await repo() }, adapters);
    const early = await finished({ subtask: { parentId: parent.id, report: true } }, adapters);
    const late = await working({ subtask: { parentId: parent.id, report: true } }, adapters);
    const delivery = new SubtaskDelivery(cfg(), adapters, 0, 60_000);
    try {
      delivery.deliver(parent.id);
      expect(reportMessages(parent.id)).toEqual([]);
      // the working sibling goes quiet: its stuck report is news the parent must act on
      recordStuckReport(late.id, 1);
      expect(siblingHoldUntil(parent.id, 60_000)).toBeNull();
      delivery.deliver(parent.id);
      const [message] = reportMessages(parent.id);
      await until(() => reportRows(parent.id).every((row) => row.state === "delivered"), "both reports");
      expect(reportRows(parent.id).map((row) => [row.child_task_id, row.kind, row.message_id])).toEqual([
        [early.id, "turn", message!.id],
        [late.id, "stuck", message!.id],
      ]);
    } finally {
      await delivery.stop();
      await Bun.write(gate, "");
    }
  }, 20_000);

  test("a child whose turn failed or ended needing input is blocked on its parent: its report goes at once", async () => {
    const gate = join(scratch(), "open");
    const failing: AdapterDef = { bin: "bash", exec: ["-c", "printf 'broke'; exit 1"], parse: { format: "text" }, attach: null };
    const adapters = { quick, failing, held: held(gate) };
    const parent = await finished({ repoPath: await repo() }, adapters);
    const early = await finished({ subtask: { parentId: parent.id, report: true } }, adapters);
    const broken = await finished({ harness: "failing", subtask: { parentId: parent.id, report: true } }, adapters);
    await working({ subtask: { parentId: parent.id, report: true } }, adapters);
    const delivery = new SubtaskDelivery(cfg(), adapters, 0, 60_000);
    try {
      const outcome = (child: string) => (db.query("SELECT json_extract(facts_json, '$.outcome') AS outcome FROM subtask_reports WHERE child_task_id = ?")
        .get(child) as { outcome: string }).outcome;
      expect([outcome(early.id), outcome(broken.id)]).toEqual(["done", "failed"]);
      expect(siblingHoldUntil(parent.id, 60_000)).toBeNull();
      // an ended-needing-input turn is the same ask; a done one alone is routine and waits
      const setOutcome = (child: string, value: string) =>
        db.run("UPDATE subtask_reports SET facts_json = json_set(facts_json, '$.outcome', ?) WHERE child_task_id = ?", [value, child]);
      setOutcome(broken.id, "needs input");
      expect(siblingHoldUntil(parent.id, 60_000)).toBeNull();
      setOutcome(broken.id, "done");
      expect(siblingHoldUntil(parent.id, 60_000)).toBeGreaterThan(Date.now());
      setOutcome(broken.id, "failed");

      delivery.deliver(parent.id);
      const [message] = reportMessages(parent.id);
      await until(() => reportRows(parent.id).every((row) => row.state === "delivered"), "both reports");
      expect(reportRows(parent.id).map((row) => [row.child_task_id, row.message_id])).toEqual([
        [early.id, message!.id],
        [broken.id, message!.id],
      ]);
    } finally {
      await delivery.stop();
      await Bun.write(gate, "");
    }
  }, 20_000);

  test("a report already queued behind the parent's own work goes as soon as it is free", async () => {
    const gate = join(scratch(), "open");
    const adapters = { quick, held: held(gate) };
    const parent = await finished({ repoPath: await repo() }, adapters);
    await finished({ subtask: { parentId: parent.id, report: true } }, adapters);
    await working({ subtask: { parentId: parent.id, report: true } }, adapters);
    const delivery = new SubtaskDelivery(cfg(), adapters, 0, 60_000);
    try {
      // busy: the report queues in line instead of waiting for siblings
      transition(parent.id, "running", "turn 2");
      delivery.deliver(parent.id);
      expect(reportMessages(parent.id).map((message) => message.status)).toEqual(["queued"]);
      // free again, a sibling still working: it has waited already, so it starts now
      transition(parent.id, "done");
      delivery.deliver(parent.id);
      await until(() => reportRows(parent.id).every((row) => row.state === "delivered"), "the queued report");
    } finally {
      await delivery.stop();
      await Bun.write(gate, "");
    }
  }, 20_000);

  test("only a working sibling that reports back holds; the default is two minutes", async () => {
    const gate = join(scratch(), "open");
    const adapters = { quick, held: held(gate) };
    const parent = await finished({ repoPath: await repo() }, adapters);
    await finished({ subtask: { parentId: parent.id, report: true } }, adapters);
    const silent = await working({ subtask: { parentId: parent.id, report: false } }, adapters);
    try {
      expect(siblingHoldUntil(parent.id, 60_000)).toBeNull();
      expect(siblingHoldUntil(parent.id, 0)).toBeNull();
      expect(REPORT_IDLE_HOLD_MS).toBe(120_000);
    } finally {
      await Bun.write(gate, "");
      await until(() => settled(silent.id), "the silent sibling");
    }
  }, 20_000);
});
