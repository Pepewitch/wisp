import { closeSync, mkdtempSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { createIncrementalOutcomeReducer, type AdapterDef } from "../src/adapters";
import type { WispConfig } from "../src/config";
import { STOP_FAILED } from "../src/interrupt-state";
import { TurnRecorder, type RecorderCheckpoint } from "../src/recording/turn-recorder";
import { finalizeTurn, startTurn } from "../src/runner";
import {
  createTask,
  createTurn,
  db,
  finishTurn,
  freeSlot,
  getTask,
  getTurn,
  newTaskId,
  setTaskFields,
  setTurnCaptureCheckpoint,
  setTurnInterrupt,
  transition,
  turnsFor,
  undeliveredOutbox,
} from "../src/store";
import { settleStrandedTasks } from "../src/turn-finalize";

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

/** Shaped like the builtin claude definition's parse mapping. */
const streamJson: AdapterDef["parse"] = {
  format: "json",
  resultType: "result",
  result: "result",
  session: "session_id",
  model: "model",
};

const recorderAdapter: AdapterDef = { bin: "true", exec: [], parse: streamJson, attach: null };

/** A live stream-json harness played by a bash script (the prompt arrives on stdin). */
function liveAdapter(script: string): AdapterDef {
  return { bin: "bash", exec: ["-c", script], liveInput: "claude-stream-json", parse: streamJson, attach: null };
}

function makeTask() {
  const task = createTask({
    id: newTaskId(),
    title: "turn fidelity test",
    repo_path: "/tmp/repo",
    harness: "fake",
    model: null,
    slot: freeSlot(),
  });
  setTaskFields(task.id, { worktree_path: mkdtempSync(join(tmpdir(), "wisp-fidelity-")) });
  return getTask(task.id)!;
}

async function until(pred: () => boolean, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await Bun.sleep(50);
  }
}

/** A recorder-owned turn row plus its two open transcript files. */
function recorderTurn() {
  const task = makeTask();
  transition(task.id, "running", "turn 1");
  const dir = mkdtempSync(join(tmpdir(), "wisp-fidelity-log-"));
  const outPath = join(dir, "turn.out.log");
  const errPath = join(dir, "turn.err.log");
  const turnId = createTurn(task.id, 1, "prompt", null, outPath, null, null, "recorder-v1");
  const outFd = openSync(outPath, "a");
  const errFd = openSync(errPath, "a");
  const close = () => {
    closeSync(outFd);
    closeSync(errFd);
  };
  return { task, turnId, outPath, errPath, outFd, errFd, close };
}

function storedCheckpoint(turnId: number): RecorderCheckpoint {
  return JSON.parse(getTurn(turnId)!.outcome_json!) as RecorderCheckpoint;
}

/** Make every write of this turn's outcome checkpoint fail until the returned function runs. */
function failCheckpointWrites(turnId: number): () => void {
  const name = `fail_checkpoint_${turnId}`;
  db.run(`CREATE TEMP TRIGGER ${name} BEFORE UPDATE OF outcome_json ON turns WHEN NEW.id = ${turnId}
          BEGIN SELECT RAISE(ABORT, 'checkpoint write refused'); END`);
  return () => db.run(`DROP TRIGGER IF EXISTS temp.${name}`);
}

/** Past the transcript's 16 KiB per-string bound, and past half the reducer's 64 KiB fact bound. */
const LONG = `${"r".repeat(40_000)}END`;

describe("a recorder turn keeps its final result whole", () => {
  test("a result longer than the transcript's per-string bound is stored in full, on both record paths", () => {
    for (const via of ["line", "event"] as const) {
      const turn = recorderTurn();
      try {
        const recorder = new TurnRecorder(turn.turnId, recorderAdapter, cfg, turn.outFd, turn.errFd);
        const event = { type: "result", result: LONG, session_id: "s-long" };
        if (via === "line") recorder.recordStdoutLine(JSON.stringify(event));
        else recorder.recordEvent(event);
        const outcome = recorder.finish();

        expect(outcome.parsed.result).toBe(LONG);
        expect(storedCheckpoint(turn.turnId).resultEvent).toMatchObject({ result: LONG });
        // The transcript's copy is still bounded: only the outcome is exempt.
        const stored = readFileSync(turn.outPath, "utf8");
        expect(stored).toContain("bytes omitted]");
        expect(stored.length).toBeLessThan(LONG.length);
      } finally {
        turn.close();
      }
    }
  });

  test(
    "a live turn whose final report runs past 16 KiB settles with all of it",
    async () => {
      const script = [
        "IFS= read -r first",
        `printf '%s\\n' '{"type":"system","subtype":"init","session_id":"s-long-live"}'`,
        `printf '{"type":"result","result":"%s","session_id":"s-long-live"}\\n' "$(printf '%020000d' 0)END"`,
      ].join("; ");
      const task = makeTask();
      startTurn(task, "write a long report", liveAdapter(script), cfg);
      await until(() => turnsFor(task.id)[0]?.status === "done", 12_000);

      const [turn] = turnsFor(task.id);
      expect(turn!.result).toBe(`${"0".repeat(20_000)}END`);
      expect(getTask(task.id)).toMatchObject({ state: "done", session_id: "s-long-live" });
    },
    15_000,
  );
});

describe("a restart early in a recorder turn keeps its session", () => {
  test("the session is checkpointed the moment it appears, not on the next cadence", () => {
    const turn = recorderTurn();
    try {
      const recorder = new TurnRecorder(turn.turnId, recorderAdapter, cfg, turn.outFd, turn.errFd);
      recorder.recordStdoutLine('{"type":"system","subtype":"init","session_id":"s-early","model":"m-early"}');

      // No finish(): this is what a daemon killed right now leaves behind.
      expect(storedCheckpoint(turn.turnId)).toMatchObject({ earlySession: "s-early", earlyModel: "m-early" });
      recorder.finish();
    } finally {
      turn.close();
    }
  });

  test("recovery folds the transcript past the checkpoint's mark and names what happened honestly", async () => {
    const turn = recorderTurn();
    turn.close();
    writeFileSync(
      turn.outPath,
      [
        '{"type":"system","subtype":"init","session_id":"s-folded","model":"m-folded"}',
        '{"type":"assistant","message":{"content":[{"type":"text","text":"working on it"}]}}',
        '{"type":"assis', // a record the old daemon never finished writing
      ].join("\n"),
    );
    // The checkpoint a daemon writes at the start of a turn: nothing folded yet.
    const reducer = createIncrementalOutcomeReducer(recorderAdapter, undefined, { maxFactStringBytes: 64 * 1024 })!;
    const checkpoint: RecorderCheckpoint = { ...reducer.checkpoint(), transcript: { stdout: 0, stderr: 0 } };
    setTurnCaptureCheckpoint(turn.turnId, {
      state: "complete",
      capturedBytes: 0,
      omittedBytes: 0,
      omittedRecords: 0,
      categoriesJson: "{}",
      detail: null,
      outcomeJson: JSON.stringify(checkpoint),
    });

    await finalizeTurn(turn.task.id, turn.turnId, recorderAdapter, null, turn.outPath, turn.errPath);

    const task = getTask(turn.task.id)!;
    expect(task.session_id).toBe("s-folded");
    expect(getTurn(turn.turnId)).toMatchObject({ status: "failed", model: "m-folded" });
    expect(task.state).toBe("failed");
    expect(task.state_detail).not.toContain("unreadable");
    expect(task.state_detail).toContain("without a result");
  });

  test("one failed checkpoint write does not end checkpointing for the rest of the turn", () => {
    const turn = recorderTurn();
    const allow = failCheckpointWrites(turn.turnId);
    try {
      const recorder = new TurnRecorder(turn.turnId, recorderAdapter, cfg, turn.outFd, turn.errFd);
      recorder.recordStdoutLine('{"type":"system","subtype":"init","session_id":"s-retry"}');
      allow();
      recorder.recordStdoutLine('{"type":"result","result":"done after all","session_id":"s-retry"}');

      expect(storedCheckpoint(turn.turnId)).toMatchObject({
        earlySession: "s-retry",
        resultEvent: { result: "done after all" },
      });
      recorder.finish();
    } finally {
      allow();
      turn.close();
    }
  });
});

describe("a harness that leaves a process holding its output", () => {
  // Waits out the post-exit drain grace (2 s) by design, then settles; the
  // leftover itself would hold the turn open for 30 s.
  test(
    "the turn settles shortly after the harness exits, not when the leftover does",
    async () => {
      const script = [
        "IFS= read -r first",
        // inherits stdout and stderr, and outlives the harness by far
        "sleep 30 &",
        `printf '%s\\n' '{"type":"result","result":"left one behind","session_id":"s-leftover"}'`,
      ].join("\n");
      const task = makeTask();
      startTurn(task, "start something and exit", liveAdapter(script), cfg);
      const pid = turnsFor(task.id)[0]!.pid!;
      try {
        await until(() => turnsFor(task.id)[0]?.status !== "running", 12_000);
        expect(turnsFor(task.id)[0]).toMatchObject({ status: "done", result: "left one behind" });
        expect(getTask(task.id)).toMatchObject({ state: "done", session_id: "s-leftover" });
        expect(readFileSync(turnsFor(task.id)[0]!.log_file, "utf8")).toContain("still held its output open");
      } finally {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          // already gone
        }
      }
    },
    15_000,
  );
});

describe("a turn and its task settle together", () => {
  test("a task write that fails leaves the turn running for recovery, not settled under a running task", async () => {
    const task = makeTask();
    transition(task.id, "running", "turn 1");
    const dir = mkdtempSync(join(tmpdir(), "wisp-fidelity-atomic-"));
    const outPath = join(dir, "turn.out.log");
    writeFileSync(outPath, '{"type":"result","result":"all done","session_id":"s-atomic"}\n');
    const turnId = createTurn(task.id, 1, "prompt", null, outPath);
    const name = `refuse_state_${task.id}`;
    db.run(`CREATE TEMP TRIGGER ${name} BEFORE UPDATE OF state ON tasks WHEN NEW.id = '${task.id}'
            BEGIN SELECT RAISE(ABORT, 'task write refused'); END`);
    try {
      await expect(finalizeTurn(task.id, turnId, recorderAdapter, 0, outPath, join(dir, "turn.err.log"))).rejects.toThrow(
        "task write refused",
      );
    } finally {
      db.run(`DROP TRIGGER IF EXISTS temp.${name}`);
    }
    expect(getTurn(turnId)!.status).toBe("running");
    expect(getTask(task.id)!.state).toBe("running");
  });

  test("boot settles a running or stuck task whose turn already settled, from that turn", () => {
    const strandedTurn = (status: "done" | "failed" | "interrupted", state: "running" | "stuck", detail?: string) => {
      const task = makeTask();
      transition(task.id, state, "turn 1");
      const turnId = createTurn(task.id, 1, "prompt", null, "/nonexistent/turn.out.log");
      if (detail) setTurnInterrupt(turnId, detail);
      finishTurn(turnId, status, 0, status === "done" ? "the answer" : null);
      return task.id;
    };
    const done = strandedTurn("done", "running");
    const failed = strandedTurn("failed", "stuck");
    const interrupted = strandedTurn("interrupted", "running", "turn interrupted — session kept");
    const stopRetry = strandedTurn("interrupted", "stuck", `${STOP_FAILED}: retry Stop`);
    const live = makeTask();
    transition(live.id, "running", "turn 1");
    createTurn(live.id, 1, "prompt", null, "/nonexistent/turn.out.log");

    const stranded = [done, failed, interrupted, stopRetry];
    const outboxRows = () => undeliveredOutbox().filter((row) => stranded.includes(row.task_id)).map((row) => row.id);
    const rowsBefore = outboxRows();
    const seqBefore = getTask(done)!.seq;

    settleStrandedTasks();

    // A correction of stale state, not news: no webhook fires, days late.
    expect(outboxRows()).toEqual(rowsBefore);
    // Clients still hear about it through the task's own sequence.
    expect(getTask(done)!.seq).toBe(seqBefore + 1);
    expect(getTask(done)).toMatchObject({ state: "done", state_detail: "the answer" });
    expect(getTask(failed)!.state).toBe("failed");
    expect(getTask(interrupted)).toMatchObject({ state: "needs-input", state_detail: "turn interrupted — session kept" });
    // an unresolved Stop's stuck state is its retry control, and stays
    expect(getTask(stopRetry)).toMatchObject({ state: "stuck", state_detail: "turn 1" });
    // a task whose turn is still running is not stranded
    expect(getTask(live.id)!.state).toBe("running");
  });
});
