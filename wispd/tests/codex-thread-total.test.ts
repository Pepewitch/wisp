import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import type { AdapterDef } from "../src/adapters";
import type { WispConfig } from "../src/config";
import { startTurn } from "../src/runner";
import { createTask, freeSlot, getTask, newTaskId, setTaskFields, turnsFor } from "../src/store";

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

async function until(pred: () => boolean, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await Bun.sleep(50);
  }
}

// A fake app-server. Turn 1 (thread/start) makes one call, so its total equals
// its last. Turn 2 (thread/resume) replays nothing, re-sends that same count
// (as codex does on rate-limit news) and then makes one real call. Each turn's
// frames go out in ONE write with turn/start's response, so the driver handles
// the turn's updates before it has the turn's id, every run.
const FAKE_CODEX = `#!/usr/bin/env bun
import { createInterface } from "node:readline";
const frame = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const usage = (input, output) => ({ totalTokens: input + output, inputTokens: input, cachedInputTokens: 0,
  cacheWriteInputTokens: 0, outputTokens: output, reasoningOutputTokens: 0 });
const earlier = usage(1000, 10);
let resumed = false;
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  const request = JSON.parse(line);
  if (request.method === "initialize") {
    frame({ jsonrpc: "2.0", id: request.id, result: {} });
  } else if (request.method === "thread/start" || request.method === "thread/resume") {
    resumed = request.method === "thread/resume";
    frame({ jsonrpc: "2.0", id: request.id, result: { thread: { id: "stored-total-thread" }, model: "fake" } });
  } else if (request.method === "turn/start") {
    const turnId = resumed ? "turn-2" : "turn-1";
    const chunk = [{ jsonrpc: "2.0", id: request.id, result: { turn: { id: turnId } } }];
    const notify = (method, params) => chunk.push({ jsonrpc: "2.0", method, params });
    const update = (total, last) =>
      notify("thread/tokenUsage/updated", { threadId: "stored-total-thread", turnId, tokenUsage: { total, last } });
    if (resumed) {
      update(earlier, earlier);
      update(usage(3000, 30), usage(2000, 20));
    } else {
      update(earlier, earlier);
    }
    notify("item/completed", {
      threadId: "stored-total-thread",
      turnId,
      item: { type: "agentMessage", id: "agent-" + turnId, text: "DONE " + turnId, phase: "final_answer" },
    });
    notify("turn/completed", { threadId: "stored-total-thread", turn: { id: turnId, status: "completed", error: null } });
    process.stdout.write(chunk.map((value) => JSON.stringify(value) + "\\n").join(""));
  }
}
`;

describe("codex thread total across turns", () => {
  test("a resume with no replay starts from the total the previous turn stored", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wisp-codex-total-"));
    const harnessPath = join(dir, "fake-codex");
    writeFileSync(harnessPath, FAKE_CODEX);
    chmodSync(harnessPath, 0o755);
    const def: AdapterDef = {
      bin: harnessPath,
      exec: ["exec", "--dangerously-bypass-approvals-and-sandbox"],
      liveInput: "codex-app-server",
      parse: { format: "json", strategy: "codex-jsonl" },
      attach: null,
    };
    const task = createTask({
      id: newTaskId(),
      title: "codex thread total",
      repo_path: "/tmp/repo",
      harness: "fake",
      model: null,
      slot: freeSlot(),
    });
    setTaskFields(task.id, { worktree_path: mkdtempSync(join(tmpdir(), "wisp-codex-total-wt-")) });

    startTurn(getTask(task.id)!, "first", def, cfg);
    await until(() => turnsFor(task.id)[0]?.status === "done");
    expect(getTask(task.id)?.session_id).toBe("stored-total-thread");
    expect(JSON.parse(turnsFor(task.id)[0]!.usage_json!)).toMatchObject({
      input_tokens: 1000,
      thread_id: "stored-total-thread",
      thread_total: { input_tokens: 1000, output_tokens: 10 },
    });

    startTurn(getTask(task.id)!, "second", def, cfg);
    await until(() => turnsFor(task.id)[1]?.status === "done");
    // Without the stored total, the re-sent earlier call (total == last)
    // would look like the thread's first call and be counted again.
    expect(JSON.parse(turnsFor(task.id)[1]!.usage_json!)).toMatchObject({
      input_tokens: 2000,
      output_tokens: 20,
      thread_total: { input_tokens: 3000, output_tokens: 30 },
    });
  });
});
