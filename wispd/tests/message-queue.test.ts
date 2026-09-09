import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import type { AdapterDef } from "../src/adapters";
import type { WispConfig } from "../src/config";
import {
  hasRunningTurn,
  killTurnForArchive,
  recoverOrphanedTurns,
  startTurn,
  submitTaskMessage,
} from "../src/runner";
import {
  createTask,
  createTaskMessage,
  freeSlot,
  getTask,
  messagesFor,
  newTaskId,
  setTaskFields,
  transition,
  turnsFor,
} from "../src/store";

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

/** Adapter that runs a bash snippet; the prompt lands in $0 and is ignored. */
function bashAdapter(script: string): AdapterDef {
  return { bin: "bash", exec: ["-c", script], parse: { format: "text" }, attach: null };
}

function makeTask() {
  const task = createTask({
    id: newTaskId(),
    title: "message queue test",
    repo_path: "/tmp/repo",
    harness: "fake",
    model: null,
    slot: freeSlot(),
  });
  setTaskFields(task.id, { worktree_path: mkdtempSync(join(tmpdir(), "wisp-queue-")) });
  return getTask(task.id)!;
}

async function until(pred: () => boolean, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await Bun.sleep(50);
  }
}

describe("what may start a queued message", () => {
  test("a settled task starts the message the moment it is sent", async () => {
    const task = makeTask();
    transition(task.id, "done", "committed the fix");

    const result = await submitTaskMessage(getTask(task.id)!, "create pr", bashAdapter('printf "ok\\n"'), cfg);

    expect(result.disposition).toBe("started");
    await until(() => turnsFor(task.id)[0]?.status === "done");
  });

  test("a summary that merely discusses archiving is not a control signal", async () => {
    const task = makeTask();
    // A harness's own last words become state_detail, and a task about wisp
    // itself can end by reporting on the force-archive path. Reading that text
    // as intent wedged the queue for the rest of the task's life: every later
    // message answered "queued for the next turn" and no turn ever came.
    transition(task.id, "done", "Fixed the barrier that was blocking force-archive.");

    const result = await submitTaskMessage(getTask(task.id)!, "create pr", bashAdapter('printf "ok\\n"'), cfg);

    expect(result.disposition).toBe("started");
    await until(() => turnsFor(task.id)[0]?.status === "done");
    expect(turnsFor(task.id).map((turn) => [turn.n, turn.prompt])).toEqual([[1, "create pr"]]);
  });

  test("restart recovery picks up a message that was left queued", async () => {
    const def = bashAdapter('printf "ok\\n"');
    const task = makeTask();
    transition(task.id, "done", "committed the fix");
    // the row a wedged daemon leaves behind: queued, unclaimed, nothing running
    createTaskMessage({ id: "queued-through-a-restart", taskId: task.id, text: "create pr", attachmentHash: "" });

    await recoverOrphanedTurns({ fake: def }, cfg);

    await until(() => turnsFor(task.id)[0]?.status === "done");
    expect(turnsFor(task.id).map((turn) => turn.prompt)).toEqual(["create pr"]);
  });

  test(
    "a turn killed for force-archive leaves its queue where it is",
    async () => {
      const def = bashAdapter("sleep 30");
      const task = makeTask();
      startTurn(task, "long turn", def, cfg);
      await until(() => hasRunningTurn(task.id) !== null);
      const queued = await submitTaskMessage(getTask(task.id)!, "create pr", def, cfg);
      expect(queued.disposition).toBe("queued-next");

      await killTurnForArchive(task.id);

      // the worktree is about to be removed: nothing may start in its place
      await Bun.sleep(250);
      expect(turnsFor(task.id)).toHaveLength(1);
      expect(messagesFor(task.id).map((message) => [message.text, message.status])).toEqual([
        ["create pr", "queued"],
      ]);
    },
    15_000,
  );
});
