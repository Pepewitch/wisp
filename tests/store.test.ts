import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { taskMessageAttachmentsFingerprint } from "../src/attachments";
import {
  cancelQueuedTaskMessage,
  claimTaskMessageForStart,
  claimTaskMessageForSteering,
  createTaskMessage,
  createTask,
  createTurn,
  finishTurn,
  freeSlot,
  getTask,
  getTaskMessage,
  getTurn,
  latestTurnOutcomes,
  newTaskId,
  newTaskMessageId,
  nextQueuedMessage,
  releaseTaskMessageClaim,
  releaseOrphanedTaskMessageClaims,
  runningTurns,
  setTaskFields,
  setTurnModel,
  setTurnUsage,
  transition,
  undeliveredOutbox,
  updateQueuedTaskMessage,
} from "../src/store";
import { displayStateWord } from "../src/types";

function makeTask(over: Partial<Parameters<typeof createTask>[0]> = {}) {
  return createTask({
    id: newTaskId(),
    title: "test task",
    repo_path: "/tmp/repo",
    harness: "fake",
    model: null,
    slot: freeSlot(),
    ...over,
  });
}

function createTextMessage(taskId: string, id: string, text: string): void {
  createTaskMessage({
    id,
    taskId,
    text,
    attachmentHash: taskMessageAttachmentsFingerprint([]),
  });
}

describe("task message migrations", () => {
  test("a database from the first durable-message slice gains every later claim field", () => {
    const home = mkdtempSync(join(tmpdir(), "wisp-message-migration-"));
    const path = join(home, "wisp.db");
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE task_messages (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        text TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        delivery TEXT,
        turn_n INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    legacy.close();

    const migrated = Bun.spawnSync({
      cmd: [process.execPath, "-e", `await import("./src/store.ts")`],
      cwd: process.cwd(),
      env: { ...process.env, WISP_HOME: home },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(migrated.exitCode, migrated.stderr.toString()).toBe(0);

    const reopened = new Database(path);
    const columns = (reopened.query(`PRAGMA table_info(task_messages)`).all() as { name: string }[]).map(
      (column) => column.name,
    );
    reopened.close();
    expect(columns).toEqual(
      expect.arrayContaining([
        "claim",
        "claim_turn_n",
        "attachment_hash",
        "delivery_uncertain",
        "attachments_json",
      ]),
    );
  });
});

describe("ids and slots", () => {
  test("task ids are short slugs", () => {
    expect(newTaskId()).toMatch(/^t[a-z0-9]{5}$/);
  });

  test("duplicate task id throws a UNIQUE violation (the daemon retries with a fresh id, L4)", () => {
    const t = makeTask();
    expect(() => makeTask({ id: t.id })).toThrow(/UNIQUE/);
  });

  test("freeSlot skips live tasks and reuses archived slots", () => {
    const a = makeTask();
    const b = makeTask();
    expect(a.slot).not.toBe(b.slot);
    const next = freeSlot();
    expect(next).not.toBe(a.slot);
    expect(next).not.toBe(b.slot);
    setTaskFields(a.id, { archived: 1 });
    expect(freeSlot()).toBe(a.slot);
  });
});

describe("native message delivery claims", () => {
  test("a later row cannot overtake the FIFO head while its admission is in flight", () => {
    const task = makeTask();
    const first = newTaskMessageId();
    const second = newTaskMessageId();
    createTextMessage(task.id, first, "first");
    createTextMessage(task.id, second, "second");

    expect(claimTaskMessageForSteering(first, task.id, 1)?.id).toBe(first);
    expect(claimTaskMessageForSteering(second, task.id, 1)).toBeNull();
    expect(releaseTaskMessageClaim(first, task.id)?.id).toBe(first);
  });

  test("an in-flight native admission cannot be edited, cancelled, or drained as a new turn", () => {
    const task = makeTask();
    const id = newTaskMessageId();
    createTextMessage(task.id, id, "correction");

    expect(claimTaskMessageForSteering(id, task.id, 1)).toMatchObject({
      status: "queued",
      delivery: null,
      turn_n: null,
    });
    expect(updateQueuedTaskMessage(id, task.id, "changed")).toBeNull();
    expect(cancelQueuedTaskMessage(id, task.id)).toBeNull();
    expect(nextQueuedMessage(task.id)).toBeNull();

    expect(releaseTaskMessageClaim(id, task.id)).toMatchObject({
      status: "queued",
      delivery: null,
      turn_n: null,
    });
    expect(nextQueuedMessage(task.id)?.id).toBe(id);
  });

  test("a start claim is likewise excluded from mutation and FIFO selection", () => {
    const task = makeTask();
    const id = newTaskMessageId();
    createTextMessage(task.id, id, "next turn");

    expect(claimTaskMessageForStart(id, task.id, 2)).toMatchObject({
      status: "queued",
      delivery: null,
      turn_n: null,
    });
    expect(updateQueuedTaskMessage(id, task.id, "changed")).toBeNull();
    expect(cancelQueuedTaskMessage(id, task.id)).toBeNull();
    expect(nextQueuedMessage(task.id)).toBeNull();
  });

  test("startup reconciles a created turn and releases an unacknowledged steer", () => {
    const task = makeTask();
    const started = newTaskMessageId();
    createTextMessage(task.id, started, "start");
    claimTaskMessageForStart(started, task.id, 1);
    createTurn(task.id, 1, "start", null, "/tmp/start.log");
    releaseOrphanedTaskMessageClaims();

    const steered = newTaskMessageId();
    createTextMessage(task.id, steered, "steer");
    claimTaskMessageForSteering(steered, task.id, 1);
    releaseOrphanedTaskMessageClaims();

    const orphanTask = makeTask();
    const orphanedStart = newTaskMessageId();
    createTextMessage(orphanTask.id, orphanedStart, "unrecorded start");
    claimTaskMessageForStart(orphanedStart, orphanTask.id, 2);
    releaseOrphanedTaskMessageClaims();

    expect(getTaskMessage(started)).toMatchObject({
      status: "delivered",
      delivery: "started",
      turn_n: 1,
      claim: null,
      delivery_uncertain: 0,
    });
    expect(getTaskMessage(steered)).toMatchObject({
      status: "queued",
      delivery: null,
      claim: null,
      delivery_uncertain: 1,
    });
    expect(getTaskMessage(orphanedStart)).toMatchObject({
      status: "queued",
      claim: null,
      delivery_uncertain: 1,
    });
    expect(nextQueuedMessage(task.id)?.id).toBe(steered);
  });
});

describe("transition + outbox atomicity", () => {
  test("notify states write an outbox row with the matching seq", () => {
    const t = makeTask();
    transition(t.id, "running", "turn 1");
    let rows = undeliveredOutbox().filter((r) => r.task_id === t.id);
    expect(rows.length).toBe(0); // running is not notify-worthy

    transition(t.id, "done", "finished");
    const fresh = getTask(t.id)!;
    expect(fresh.state).toBe("done");
    expect(fresh.seq).toBe(2);
    rows = undeliveredOutbox().filter((r) => r.task_id === t.id);
    expect(rows.length).toBe(1);
    expect(rows[0]!.seq).toBe(2);
    const payload = JSON.parse(rows[0]!.payload);
    expect(payload.state).toBe("done");
    expect(payload.task_id).toBe(t.id);
  });

  test("every notify transition gets its own row (at-least-once, seq-deduped)", () => {
    const t = makeTask();
    transition(t.id, "stuck", "quiet");
    transition(t.id, "running", "recovered");
    transition(t.id, "failed", "boom");
    const rows = undeliveredOutbox().filter((r) => r.task_id === t.id);
    expect(rows.map((r) => r.event)).toEqual(["stuck", "failed"]);
    expect(new Set(rows.map((r) => r.seq)).size).toBe(rows.length);
  });

  test("transition on unknown task throws instead of silently no-oping", () => {
    expect(() => transition("tnope9", "done")).toThrow();
  });
});

describe("turns", () => {
  test("running turns are tracked and finishable", () => {
    const t = makeTask();
    const turnId = createTurn(t.id, 1, "do it", 12345, "/tmp/x.out.log");
    expect(runningTurns(t.id).length).toBe(1);
    finishTurn(turnId, "done", 0, "did it");
    expect(runningTurns(t.id).length).toBe(0);
  });

  test("UNIQUE(task_id, n) rejects a duplicate turn number (L4)", () => {
    const t = makeTask();
    createTurn(t.id, 1, "one", null, "/tmp/x.out.log");
    expect(() => createTurn(t.id, 1, "dup", null, "/tmp/y.out.log")).toThrow(/UNIQUE/);
  });
});

describe("per-turn model + per-task effort (P5b)", () => {
  test("turns start with no model; setTurnModel records what the harness reported", () => {
    const t = makeTask();
    const turnId = createTurn(t.id, 1, "do it", null, "/tmp/x.out.log");
    expect(getTurn(turnId)!.model).toBeNull(); // harness never reported / not finalized yet
    setTurnModel(turnId, "kimi-k3");
    expect(getTurn(turnId)!.model).toBe("kimi-k3");
  });

  test("latestTurnOutcomes maps each task to its LATEST turn's facts", () => {
    const a = makeTask();
    const a1 = createTurn(a.id, 1, "one", null, "/tmp/a1.out.log");
    const a2 = createTurn(a.id, 2, "two", null, "/tmp/a2.out.log");
    setTurnModel(a1, "old-model");
    setTurnModel(a2, "new-model");
    finishTurn(a1, "failed", 1, "delivered before the bad exit"); // earlier turn's facts must not win
    finishTurn(a2, "done", 0, "ok");
    const b = makeTask();
    createTurn(b.id, 1, "one", null, "/tmp/b1.out.log"); // never finalized
    const c = makeTask(); // no turns at all (still creating)
    const outcomes = latestTurnOutcomes();
    expect(outcomes.get(a.id)).toEqual({ model: "new-model", exitCode: 0, hasResult: true });
    expect(outcomes.get(b.id)).toEqual({ model: null, exitCode: null, hasResult: false });
    expect(outcomes.has(c.id)).toBe(false);
  });

  test("tasks snapshot the creation-time effort (null when unset)", () => {
    expect(makeTask({ effort: "medium" }).effort).toBe("medium");
    expect(makeTask().effort).toBeNull();
  });
});

describe("per-turn usage (Theme B)", () => {
  test("turns start with no usage; setTurnUsage records the raw blob", () => {
    const t = makeTask();
    const turnId = createTurn(t.id, 1, "do it", null, "/tmp/x.out.log");
    expect(getTurn(turnId)!.usage_json).toBeNull(); // harness reported nothing (yet or ever)
    setTurnUsage(turnId, JSON.stringify({ input_tokens: 10, output_tokens: 5 }));
    expect(JSON.parse(getTurn(turnId)!.usage_json!)).toEqual({ input_tokens: 10, output_tokens: 5 });
  });
});

describe("the honest failure word (Theme B, Q12)", () => {
  // the rule the list surfaces share: "exited N" only when the work landed —
  // a result exists — and the harness CLI then exited nonzero
  test("failed + result + nonzero exit says 'exited N'", () => {
    expect(displayStateWord("failed", 1, true)).toBe("exited 1");
    expect(displayStateWord("failed", 143, true)).toBe("exited 143");
  });

  test("a result-less failure stays 'failed' — it really did not deliver", () => {
    expect(displayStateWord("failed", 1, false)).toBe("failed"); // died without a terminal message
    expect(displayStateWord("failed", null, true)).toBe("failed"); // exit unknown (re-adopted, killed)
    expect(displayStateWord("failed", 0, false)).toBe("failed"); // exit 0 but no parseable result (H3)
    expect(displayStateWord("failed", null, false)).toBe("failed");
    expect(displayStateWord("failed", undefined, undefined)).toBe("failed"); // a task with no turns
  });

  test("every other state keeps its own word", () => {
    expect(displayStateWord("done", 0, true)).toBe("done");
    expect(displayStateWord("running", null, false)).toBe("running");
    expect(displayStateWord("needs-input", 0, true)).toBe("needs-input");
  });
});
