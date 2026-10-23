// Who started a turn and who sent a message, recorded with the rows
// themselves (migration 26): what a subtask's report will be judged by.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import type { AdapterDef } from "../src/adapters";
import type { WispConfig } from "../src/config";
import { startTurn, submitTaskMessage } from "../src/runner";
import { createTask, freeSlot, getTask, getTaskMessage, newTaskId, setTaskFields, transition, turnsFor } from "../src/store";

const cfg = { maxConcurrentTasks: 100 } as WispConfig;
const quick: AdapterDef = { bin: "bash", exec: ["-c", "printf done"], parse: { format: "text" }, attach: null };
const missing: AdapterDef = { bin: join(tmpdir(), "wisp-no-such-harness"), exec: [], parse: { format: "text" }, attach: null };

function idleTask(harness: string): string {
  const id = newTaskId();
  const dir = mkdtempSync(join(tmpdir(), "wisp-provenance-"));
  createTask({ id, title: "provenance", repo_path: dir, harness, model: null, mode: "local", slot: freeSlot() });
  setTaskFields(id, { worktree_path: dir, branch: "main" });
  transition(id, "done");
  return id;
}

async function until(pred: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await Bun.sleep(25);
  }
}

describe("turn and message provenance", () => {
  test("a turn whose spawn failed still names the message that started it", async () => {
    const id = idleTask("missing");
    const sent = await submitTaskMessage(getTask(id)!, "start", missing, cfg, [], "mprovenance1", { missing });
    await until(() => turnsFor(id)[0]?.status === "failed");
    expect(turnsFor(id)[0]).toMatchObject({ status: "failed", source_message_id: sent.message.id });
    expect(sent.message.id).toBe("mprovenance1");
  });

  test("a message stores its sender, and a retry with the same id keeps the first one", async () => {
    const id = idleTask("quick");
    const first = await submitTaskMessage(getTask(id)!, "from an agent", quick, cfg, [], "mprovenance2", { quick }, undefined, "allow-steer", "agent:tother");
    expect(getTaskMessage(first.message.id)).toMatchObject({ actor: "agent:tother" });
    await until(() => turnsFor(id)[0]?.status === "done");
    await submitTaskMessage(getTask(id)!, "from an agent", quick, cfg, [], "mprovenance2", { quick }, undefined, "allow-steer", "web");
    expect(getTaskMessage(first.message.id)).toMatchObject({ actor: "agent:tother" });
    expect(turnsFor(id)[0]).toMatchObject({ source_message_id: "mprovenance2" });
  });

  test("a first turn has no source message", async () => {
    const id = idleTask("quick");
    startTurn(getTask(id)!, "first", quick, cfg);
    await until(() => turnsFor(id)[0]?.status === "done");
    expect(turnsFor(id)[0]).toMatchObject({ n: 1, source_message_id: null });
  });
});
