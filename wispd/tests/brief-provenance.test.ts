import { describe, expect, test } from "bun:test";
import type { AdapterDef } from "../src/adapters";
import { latestHumanInput, markPendingAnswersUncertain, observeAnswer, settleAnswerObservation } from "../src/brief-inputs";
import { briefView, publishBrief, recordBriefRun } from "../src/brief-store";
import {
  cancelQueuedTaskMessage,
  createTask,
  createTaskMessage,
  createTurn,
  db,
  freeSlot,
  getTask,
  markTaskMessageDelivered,
  newTaskId,
  newTaskMessageId,
  updateQueuedTaskMessage,
} from "../src/store";

const INSTANCE = "0f3c9a8e-7b21-4d5e-9c6a-1e2f3a4b5c6d";
const adapters: Record<string, AdapterDef> = { fake: { bin: "true", exec: [], parse: { format: "text" }, attach: null, briefs: true } };

/** A task with briefs on, its first turn running and bound — no process needed to publish. */
function boundTask(prompt = "Stop duplicate saves.") {
  const task = createTask({ id: newTaskId(), title: "provenance", repo_path: "/tmp/repo", harness: "fake", model: null, slot: freeSlot(), brief: true });
  const turnId = createTurn(task.id, 1, prompt, null, "/tmp/provenance.log");
  db.run(`UPDATE tasks SET turn_count = 1 WHERE id = ?`, [task.id]);
  const runId = `br_${crypto.randomUUID().replaceAll("-", "")}`;
  recordBriefRun({ runId, generation: 1 }, { taskId: task.id, turnId, n: 1, contextN: 1 }, INSTANCE);
  return { task: getTask(task.id)!, turnId, runId };
}

function say(taskId: string, text: string, origin: "human" | "workflow" = "human") {
  return createTaskMessage({ id: newTaskMessageId(), taskId, text, attachmentHash: "", origin }, false);
}

function save(taskId: string, runId: string, outcome: string, expected = 0) {
  return publishBrief(taskId, runId, expected, { version: 1, outcome, remaining: [] }, INSTANCE);
}

const view = (taskId: string) => briefView(getTask(taskId)!, adapters);

describe("the person's latest input", () => {
  test("with nothing else said, it is the task prompt as stored", () => {
    const { task } = boundTask("Fix the save bug.");
    expect(latestHumanInput(task.id)?.input).toMatchObject({ kind: "task-prompt", text: "Fix the save bug.", turnN: 1, delivery: "started" });
  });

  test("a workflow's message never counts, even after a finished workflow clears its link", () => {
    const { task } = boundTask();
    const mine = say(task.id, "Also check autosave.");
    const automated = say(task.id, "Heartbeat: keep going.", "workflow");
    db.run(`UPDATE task_messages SET workflow_id = 'wfixture' WHERE id = ?`, [automated.id]);
    expect(latestHumanInput(task.id)?.input.id).toBe(mine.id);
    db.run(`UPDATE task_messages SET workflow_id = NULL WHERE id = ?`, [automated.id]);
    expect(latestHumanInput(task.id)?.input.id).toBe(mine.id);
  });

  test("an older queued message delivered after a newer answer does not become the latest", () => {
    const { task, turnId } = boundTask();
    const queued = say(task.id, "Then look at the exporter.");
    const answer = observeAnswer(task.id, turnId, "q1", [{ index: 0, question: "Keep the old export format?" }], [{ index: 0, answer: " yes " }])!;
    settleAnswerObservation(answer, "delivered");
    markTaskMessageDelivered(queued.id, "started", 2);
    const latest = latestHumanInput(task.id)!.input;
    expect(latest).toMatchObject({ kind: "answer", text: "yes", question: "Keep the old export format?", delivery: "delivered" });
  });

  test("a cancelled message counts only while its delivery is uncertain", () => {
    const { task } = boundTask();
    const earlier = say(task.id, "First thought.");
    const withdrawn = say(task.id, "Never mind that.");
    cancelQueuedTaskMessage(withdrawn.id, task.id);
    expect(latestHumanInput(task.id)?.input.id).toBe(earlier.id);

    // a retry that was cancelled after an unconfirmed native admission: it may have arrived
    const risky = say(task.id, "Push it now.");
    db.run(`UPDATE task_messages SET status = 'cancelled', delivery_uncertain = 1 WHERE id = ?`, [risky.id]);
    expect(latestHumanInput(task.id)?.input).toMatchObject({ id: risky.id, delivery: "uncertain" });
    expect(view(task.id).reasons).toContain("input-uncertain");
  });

  test("a long input is an explicit excerpt with its full length", () => {
    const { task } = boundTask();
    say(task.id, "x".repeat(5000));
    expect(latestHumanInput(task.id)?.input).toMatchObject({ truncated: true, length: 5000 });
    expect([...latestHumanInput(task.id)!.input.text]).toHaveLength(2000);
  });

  test("rows from before origin tracking are flagged rather than trusted", () => {
    const { task } = boundTask();
    const old = say(task.id, "Something said long ago.");
    db.run(`UPDATE task_messages SET origin = 'legacy' WHERE id = ?`, [old.id]);
    expect(latestHumanInput(task.id)?.input.legacy).toBe(true);
    expect(view(task.id).reasons).toContain("coverage-legacy");
  });
});

describe("freshness against a saved brief", () => {
  test("input after a save makes the report older, and an identical retry cannot hide it", () => {
    const { task, runId } = boundTask();
    say(task.id, "Also check autosave.");
    expect(save(task.id, runId, "Fixed.")).toEqual({ kind: "saved", revision: 1 });
    // said before the save: the report already saw it
    expect(view(task.id).reasons).not.toContain("newer-input");
    const savedAt = db.query(`SELECT saved_at, source_json FROM task_briefs WHERE task_id = ?`).get(task.id);

    say(task.id, "And the shortcut.");
    expect(view(task.id).reasons).toContain("newer-input");
    // the agent retries the same brief after the new message: same time, same snapshot, still older
    expect(save(task.id, runId, "Fixed.")).toEqual({ kind: "unchanged", revision: 1 });
    expect(db.query(`SELECT saved_at, source_json FROM task_briefs WHERE task_id = ?`).get(task.id)).toEqual(savedAt);
    expect(view(task.id).reasons).toContain("newer-input");
    // a deliberate replacement sees the new message
    expect(save(task.id, runId, "Fixed, shortcut too.", 1)).toEqual({ kind: "saved", revision: 2 });
    expect(view(task.id).reasons).not.toContain("newer-input");
  });

  test("an answer after a save is newer input; editing a queued message is a change, not a new one", () => {
    const { task, turnId, runId } = boundTask();
    const queued = say(task.id, "Next: the exporter.");
    save(task.id, runId, "Fixed.");
    updateQueuedTaskMessage(queued.id, task.id, "Next: the exporter, but keep the format.");
    expect(view(task.id).reasons).toContain("input-changed");
    expect(view(task.id).reasons).not.toContain("newer-input");
    const answer = observeAnswer(task.id, turnId, "q2", [{ index: 0, question: "Proceed?" }], [{ index: 0, answer: "yes" }])!;
    expect(view(task.id).reasons).toEqual(expect.arrayContaining(["newer-input", "input-uncertain"]));
    settleAnswerObservation(answer, "delivered");
    expect(view(task.id).reasons).not.toContain("input-uncertain");
    expect(view(task.id).latestInput).toMatchObject({ kind: "answer", question: "Proceed?" });
  });

  test("an answer caught mid-write by a crash stays uncertain, and a failed one is not the latest", () => {
    const { task, turnId } = boundTask();
    const before = say(task.id, "Earlier message.");
    const failed = observeAnswer(task.id, turnId, "q3", [{ index: 0, question: "Use the cache?" }], [{ index: 0, answer: "no" }])!;
    settleAnswerObservation(failed, "failed");
    expect(latestHumanInput(task.id)?.input.id).toBe(before.id);
    observeAnswer(task.id, turnId, "q4", [{ index: 0, question: "Ship it?" }], [{ index: 0, answer: "yes" }]);
    markPendingAnswersUncertain();
    expect(latestHumanInput(task.id)?.input).toMatchObject({ kind: "answer", delivery: "uncertain", question: "Ship it?" });
  });

  test("answers are recorded only while briefs are on", () => {
    const { task, turnId } = boundTask();
    db.run(`UPDATE tasks SET brief_enabled = 0 WHERE id = ?`, [task.id]);
    expect(observeAnswer(task.id, turnId, "q5", [{ index: 0, question: "?" }], [{ index: 0, answer: "ok" }])).toBeNull();
    expect(db.query(`SELECT COUNT(*) AS n FROM task_answer_observations WHERE task_id = ?`).get(task.id)).toEqual({ n: 0 });
  });
});
