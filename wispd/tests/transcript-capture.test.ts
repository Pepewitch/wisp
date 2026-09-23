import { existsSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { createActivityFormatter, type AdapterDef } from "../src/adapters";
import type { WispConfig } from "../src/config";
import { acquireDiagnosticExport } from "../src/recording/diagnostic";
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

function makeTask() {
  const task = createTask({
    id: newTaskId(),
    title: "transcript capture test",
    repo_path: "/tmp/repo",
    harness: "fake",
    model: null,
    slot: freeSlot(),
  });
  setTaskFields(task.id, { worktree_path: mkdtempSync(join(tmpdir(), "wisp-capture-")) });
  return getTask(task.id)!;
}

async function until(pred: () => boolean, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await Bun.sleep(50);
  }
}

describe("what the primary transcript keeps", () => {
  test("a claude turn's transcript drops empty-thinking signatures and token estimates, the diagnostic keeps both", async () => {
    const signature = "S".repeat(9_000);
    const events = [
      { type: "system", subtype: "thinking_tokens", estimated_tokens: 50, estimated_tokens_delta: 50 },
      { type: "assistant", message: { content: [{ type: "thinking", thinking: "", signature }] } },
      { type: "assistant", message: { content: [{ type: "thinking", thinking: "visible reasoning", signature: "kept-signature" }] } },
      { type: "assistant", message: { content: [{ type: "text", text: "all done" }] } },
      { type: "result", result: "all done", session_id: "session-compact" },
    ];
    const script = ["IFS= read -r first", ...events.map((event) => `printf '%s\\n' '${JSON.stringify(event)}'`)].join("; ");
    const def: AdapterDef = {
      bin: "bash",
      exec: ["-c", script],
      liveInput: "claude-stream-json",
      parse: { format: "json", resultType: "result", result: "result", session: "session_id" },
      events: "claude-stream-json",
      activity: "claude-stream-json",
      attach: null,
    };
    const task = makeTask();
    startTurn(task, "original", def, cfg);
    await until(() => turnsFor(task.id)[0]?.status === "done");

    const [turn] = turnsFor(task.id);
    expect(turn).toMatchObject({ result: "all done", capture_state: "complete" });
    const log = readFileSync(turn!.log_file, "utf8");
    expect(log).not.toContain(signature);
    expect(log).not.toContain("thinking_tokens");
    expect(log).toContain("kept-signature");
    // The row that says "the agent is thinking" survives without its signature.
    const activity = log.split("\n").filter(Boolean).flatMap(createActivityFormatter(def));
    expect(activity.filter((item) => item.kind === "thinking").map((item) => item.text)).toEqual([null, "visible reasoning"]);

    const lease = acquireDiagnosticExport(cfg, turn!.id);
    try {
      const diagnostic = lease.paths.map((path) => readFileSync(path, "utf8")).join("");
      expect(diagnostic).toContain(signature);
      expect(diagnostic).toContain("thinking_tokens");
    } finally {
      lease.release();
    }
  });

  function overflowingTurn(lines: number): AdapterDef {
    const script = [
      "IFS= read -r first",
      `for i in $(seq 1 ${lines}); do printf '{"type":"assistant","message":{"content":[{"type":"text","text":"activity-%04d-%0300d"}]}}\\n' "$i" 0; done`,
      `printf '%s\\n' '{"type":"result","result":"the end","session_id":"session-tail"}'`,
    ].join("; ");
    return {
      bin: "bash",
      exec: ["-c", script],
      liveInput: "claude-stream-json",
      parse: { format: "json", resultType: "result", result: "result", session: "session_id" },
      attach: null,
    };
  }

  test("a turn past its budget keeps its beginning and its end, and loses only the middle", async () => {
    const budgetCfg: WispConfig = { ...cfg, turnTranscriptBytes: 16 * 1024, logMaxBytes: 16 * 1024 };
    const task = makeTask();
    startTurn(task, "original", overflowingTurn(300), budgetCfg);
    await until(() => turnsFor(task.id)[0]?.status === "done", 20_000);

    const [turn] = turnsFor(task.id);
    expect(turn).toMatchObject({ result: "the end", capture_state: "degraded" });
    const log = readFileSync(turn!.log_file, "utf8");
    const gap = log.indexOf("from the middle of this turn were not retained; its most recent activity follows");
    expect(gap).toBeGreaterThan(log.indexOf("activity-0001"));
    expect(log.indexOf("activity-0300")).toBeGreaterThan(gap);
    expect(log.indexOf('"result":"the end"')).toBeGreaterThan(gap);
    expect(log).not.toContain("activity-0150");
    expect(turn!.omitted_records).toBeGreaterThan(0);
    expect(turn!.omitted_records).toBeLessThan(300);
    expect(turn!.capture_detail).toContain(`${turn!.omitted_records} records from the middle of the turn were not retained`);
    const errPath = turn!.log_file.replace(/\.out\.log$/, ".err.log");
    expect(statSync(turn!.log_file).size + statSync(errPath).size).toBeLessThanOrEqual(16 * 1024);
  });

  test("an overflow the tail window holds whole leaves a complete transcript", async () => {
    const budgetCfg: WispConfig = { ...cfg, turnTranscriptBytes: 16 * 1024, logMaxBytes: 16 * 1024 };
    const task = makeTask();
    // ~340-byte records: about 26 fit the head and 17 the tail window.
    startTurn(task, "original", overflowingTurn(32), budgetCfg);
    await until(() => turnsFor(task.id)[0]?.status === "done", 20_000);

    const [turn] = turnsFor(task.id);
    expect(turn).toMatchObject({ result: "the end", capture_state: "complete", omitted_records: 0, capture_detail: null });
    const log = readFileSync(turn!.log_file, "utf8");
    for (let i = 1; i <= 32; i++) expect(log).toContain(`activity-${String(i).padStart(4, "0")}`);
    expect(log).toContain("· the activity since the budget was reached follows in full");
  });

  test("activity the transcript does not keep still counts as output for stuck detection", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wisp-liveness-"));
    const gate = join(dir, "gate");
    const done = join(dir, "done");
    const tokens = JSON.stringify({ type: "system", subtype: "thinking_tokens", estimated_tokens: 1 });
    const script = [
      "IFS= read -r first",
      `printf '%s\\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"started"}]}}'`,
      `while [ ! -f ${gate} ]; do sleep 0.02; done`,
      `printf '%s\\n' '${tokens}'`,
      `while [ ! -f ${done} ]; do sleep 0.02; done`,
      `printf '%s\\n' '{"type":"result","result":"finished","session_id":"session-live"}'`,
    ].join("; ");
    const def: AdapterDef = {
      bin: "bash",
      exec: ["-c", script],
      liveInput: "claude-stream-json",
      parse: { format: "json", resultType: "result", result: "result", session: "session_id" },
      events: "claude-stream-json",
      attach: null,
    };
    const task = makeTask();
    startTurn(task, "original", def, cfg);
    const log = () => turnsFor(task.id)[0]!.log_file;
    await until(() => existsSync(log()) && readFileSync(log(), "utf8").includes("started"));
    const size = statSync(log()).size;
    const anHourAgo = new Date(Date.now() - 3_600_000);
    utimesSync(log(), anHourAgo, anHourAgo);

    writeFileSync(gate, "");
    await until(() => statSync(log()).mtimeMs > Date.now() - 60_000);
    // Nothing was written: the token estimate only refreshed the mtime.
    expect(statSync(log()).size).toBe(size);
    writeFileSync(done, "");
    await until(() => turnsFor(task.id)[0]?.status === "done");
  });
});
