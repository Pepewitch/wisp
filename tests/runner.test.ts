import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { BUILTIN_ADAPTERS, type AdapterDef } from "../src/adapters";
import { writeMessageAttachments, writeTurnAttachments } from "../src/attachments";
import type { WispConfig } from "../src/config";
import { processStartTime } from "../src/procid";
import { FACTORY_PROTOCOL_VERSION } from "../src/probes";
import {
  failStaleCreatingTasks,
  finalizeTurn,
  hasRunningTurn,
  interruptTurn,
  killTurnForArchive,
  markInterrupted,
  pidIdentity,
  recordKillReason,
  recoverOrphanedTurns,
  startTurn,
  submitTaskMessage,
} from "../src/runner";
import {
  createTask,
  createTurn,
  freeSlot,
  getTask,
  messagesFor,
  newTaskId,
  setTaskFields,
  transition,
  turnsFor,
  undeliveredOutbox,
} from "../src/store";
import { fixture } from "./fixtures";

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
    title: "runner test",
    repo_path: "/tmp/repo",
    harness: "fake",
    model: null,
    slot: freeSlot(),
  });
  setTaskFields(task.id, { worktree_path: mkdtempSync(join(tmpdir(), "wisp-runner-")) });
  return getTask(task.id)!;
}

async function until(pred: () => boolean, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await Bun.sleep(50);
  }
}

describe("finalizeTurn matrix (a prior audit + test gap #1)", () => {
  // stream-json adapter shaped like the builtin claude/droid defs
  const jsonAdapter: AdapterDef = {
    bin: "true",
    exec: [],
    parse: { format: "json", resultType: "result", result: "result", session: "session_id" },
    attach: null,
  };
  const RESULT_LINE = '{"type":"result","result":"all done","session_id":"sess-live"}';

  /** Create a running task+turn, write the logs, finalize, and return the rows. */
  async function finalize(opts: {
    def?: AdapterDef;
    exit: number | null;
    out: string;
    err?: string;
    pre?: (turnId: number) => void;
  }) {
    const task = makeTask();
    transition(task.id, "running", "turn 1");
    const dir = mkdtempSync(join(tmpdir(), "wisp-finalize-"));
    const outPath = join(dir, "turn.out.log");
    const errPath = join(dir, "turn.err.log");
    writeFileSync(outPath, opts.out);
    if (opts.err !== undefined) writeFileSync(errPath, opts.err);
    const turnId = createTurn(task.id, 1, "prompt", 99999, outPath);
    opts.pre?.(turnId);
    await finalizeTurn(task.id, turnId, opts.def ?? jsonAdapter, opts.exit, outPath, errPath);
    return { task: getTask(task.id)!, turn: turnsFor(task.id)[0]! };
  }

  test("exit 0 with a parsed result → done, result and session recorded", async () => {
    const { task, turn } = await finalize({ exit: 0, out: `{"type":"start","session_id":"sess-live"}\n${RESULT_LINE}\n` });
    expect(turn.status).toBe("done");
    expect(turn.result).toBe("all done");
    expect(task.state).toBe("done");
    expect(task.session_id).toBe("sess-live");
    expect(turn.model).toBeNull(); // this adapter declares no parse.model — no guessing
  });

  test("a positive terminal payload marked isError fails even when the protocol process exits 0", async () => {
    const droidLike: AdapterDef = {
      ...jsonAdapter,
      parse: { format: "json", resultType: "completion", result: "finalText", session: "session_id" },
      errors: "droid-stream-json",
    };
    const { task, turn } = await finalize({
      def: droidLike,
      exit: 0,
      out: '{"type":"completion","finalText":"Droid turn failed","session_id":"s","isError":true}\n',
    });
    expect(turn.status).toBe("failed");
    expect(task.state).toBe("failed");
    expect(task.state_detail).toBe("turn reported failure: Droid turn failed");
  });

  test("the model the harness reported is recorded on the turn row (P5b)", async () => {
    const withModel: AdapterDef = { ...jsonAdapter, parse: { ...jsonAdapter.parse, model: "model" } };
    const { turn } = await finalize({
      def: withModel,
      exit: 0,
      out: `{"type":"system","subtype":"init","session_id":"sess-live","model":"kimi-k3"}\n${RESULT_LINE}\n`,
    });
    expect(turn.status).toBe("done");
    expect(turn.model).toBe("kimi-k3");
  });

  test("the harness's usage report is persisted raw on the turn row (Theme B)", async () => {
    const withUsage: AdapterDef = { ...jsonAdapter, parse: { ...jsonAdapter.parse, usage: "usage" } };
    const { turn } = await finalize({
      def: withUsage,
      exit: 0,
      out: `{"type":"result","result":"all done","session_id":"s-1","usage":{"input_tokens":12,"output_tokens":3}}`,
    });
    expect(turn.status).toBe("done");
    expect(JSON.parse(turn.usage_json!)).toEqual({ input_tokens: 12, output_tokens: 3 });
  });

  test("usage is persisted on the failure path too — the tokens were spent either way", async () => {
    const withUsage: AdapterDef = { ...jsonAdapter, parse: { ...jsonAdapter.parse, usage: "usage" } };
    const { task, turn } = await finalize({
      def: withUsage,
      exit: 1,
      out: `{"type":"result","result":"delivered before the bad exit","session_id":"s-2","usage":{"input_tokens":7}}`,
    });
    expect(task.state).toBe("failed");
    expect(JSON.parse(turn.usage_json!)).toEqual({ input_tokens: 7 });
  });

  test("a turn whose stream carries no usage keeps the column null", async () => {
    const withUsage: AdapterDef = { ...jsonAdapter, parse: { ...jsonAdapter.parse, usage: "usage" } };
    const { turn } = await finalize({ def: withUsage, exit: 0, out: RESULT_LINE });
    expect(turn.usage_json).toBeNull();
  });

  test("the model is recorded even for a failed turn whose init event reported one (P5b)", async () => {
    const withModel: AdapterDef = { ...jsonAdapter, parse: { ...jsonAdapter.parse, model: "model" } };
    const { task, turn } = await finalize({
      def: withModel,
      exit: 3,
      out: `{"type":"system","subtype":"init","session_id":"sess-x","model":"claude-opus-5"}\n`,
    });
    expect(turn.status).toBe("failed");
    expect(turn.model).toBe("claude-opus-5");
    expect(task.state).toBe("failed");
  });

  test("exit 0 with no output → failed, loudly (H3: bare exit 0 is not a positive signal)", async () => {
    const { task, turn } = await finalize({ exit: 0, out: "" });
    expect(turn.status).toBe("failed");
    expect(task.state).toBe("failed");
    expect(task.state_detail).toContain("no parseable result");
    expect(task.state_detail).toContain("allowEmptyResult");
  });

  test("exit 0 with garbage output → failed, loudly (H3)", async () => {
    const { task, turn } = await finalize({ exit: 0, out: "not json at all\n<<<garbage>>>\n{broken json\n" });
    expect(turn.status).toBe("failed");
    expect(turn.result).toBeNull();
    expect(task.state).toBe("failed");
    expect(task.state_detail).toContain("no parseable result");
  });

  test("nonzero exit → failed with exit code + stderr tail; session salvaged for resume", async () => {
    const { task, turn } = await finalize({
      exit: 3,
      out: '{"type":"start","session_id":"sess-salvaged"}\n{"type":"assistant","text":"partial work"}\n',
      err: "boom line 1\nboom line 2\n",
    });
    expect(turn.status).toBe("failed");
    expect(task.state).toBe("failed");
    expect(task.state_detail).toContain("exited 3");
    expect(task.state_detail).toContain("boom line 2");
    // the harness session survives a crash — the next `send` resumes it
    expect(task.session_id).toBe("sess-salvaged");
  });

  test("null exit code (re-adoption) with a parsed result → done", async () => {
    const { task, turn } = await finalize({ exit: null, out: `${RESULT_LINE}\n` });
    expect(turn.status).toBe("done");
    expect(task.state).toBe("done");
  });

  // P5e: a failed turn names its actual cause (from the harness's own error
  // events via the adapter's error strategy), not just "turn exited 1" — the
  // dogfooding gap: codex reports failures on stdout, so a stderr tail is blind.
  describe("failure detail + limit classification", () => {
    test("codex: stderr is noise, the cause comes from the stdout turn.failed event", async () => {
      const { task, turn } = await finalize({
        def: BUILTIN_ADAPTERS.codex!,
        exit: 1,
        out: fixture("codex-failed-turn.jsonl"),
        err: "Reading additional input from stdin...\n",
      });
      expect(turn.status).toBe("failed");
      expect(task.state).toBe("failed");
      expect(task.state_detail).toBe(
        "turn exited 1: The 'no-such-model-xyz' model is not supported when using Codex with a ChatGPT account.",
      );
      expect(task.session_id).toBe("010c5312-6e66-56b1-91aa-ff594327d3bd"); // session still salvaged
    });

    test("claude: the is_error result event names the unknown model", async () => {
      const { task } = await finalize({
        def: BUILTIN_ADAPTERS.claude!,
        exit: 1,
        out: fixture("claude-unknown-model.jsonl"),
        err: `[claude-code:unrecognized_model] {"model":"bogus-model","query_source":"sdk"}\n`,
      });
      expect(task.state_detail).toContain("turn exited 1");
      expect(task.state_detail).toContain("There's an issue with the selected model (bogus-model)");
    });

    test("droid: stdout empty, first stderr line names the cause — the help-text tail does not drown it", async () => {
      const { task } = await finalize({
        def: BUILTIN_ADAPTERS.droid!,
        exit: 1,
        out: "",
        err: fixture("droid-unknown-model.stderr.txt"),
      });
      expect(task.state_detail).toBe("turn exited 1: Invalid model: bogus-model");
    });

    test("limit-shaped failure: state_detail is prefixed 'limit: ' so consumers can react to quota exhaustion", async () => {
      const { task } = await finalize({
        def: BUILTIN_ADAPTERS.droid!,
        exit: 1,
        out: `{"type":"error","message":"Unrecoverable 402: usage limit reached"}\n`,
        err: "",
      });
      expect(task.state).toBe("failed");
      expect(task.state_detail).toBe("limit: turn exited 1: Unrecoverable 402: usage limit reached");
    });

    test("transient-shaped failure: state_detail is prefixed 'transient: '", async () => {
      const { task } = await finalize({
        def: BUILTIN_ADAPTERS.droid!,
        exit: 1,
        out: `{"type":"error","source":"agent_loop","message":"Floating point NaN (not-a-number) is detected in generation."}\n`,
        err: "",
      });
      expect(task.state_detail).toBe(
        "transient: turn exited 1: Floating point NaN (not-a-number) is detected in generation.",
      );
    });

    test("limit wins when a detail matches both classifications", async () => {
      const def: AdapterDef = { ...BUILTIN_ADAPTERS.droid!, limitMarkers: ["floating point nan"] };
      const { task } = await finalize({
        def,
        exit: 1,
        out: `{"type":"error","source":"agent_loop","message":"Floating point NaN (not-a-number) is detected in generation."}\n`,
        err: "",
      });
      expect(task.state_detail).toBe(
        "limit: turn exited 1: Floating point NaN (not-a-number) is detected in generation.",
      );
    });

    test("a non-limit/non-transient failure is not prefixed", async () => {
      const { task } = await finalize({
        def: BUILTIN_ADAPTERS.droid!,
        exit: 1,
        out: `{"type":"error","message":"disk on fire"}\n`,
        err: "",
      });
      expect(task.state_detail).toBe("turn exited 1: disk on fire");
    });

    test("a wisp-killed turn never gets the limit prefix, even over a limit-shaped log", async () => {
      const { task } = await finalize({
        def: BUILTIN_ADAPTERS.droid!,
        exit: null,
        out: `{"type":"error","message":"Unrecoverable 402: usage limit reached"}\n`,
        pre: (turnId) => recordKillReason(turnId, "log cap exceeded (test)"),
      });
      expect(task.state_detail).toBe("turn killed: log cap exceeded (test)");
    });
  });

  test("null exit code (re-adoption) with no result → failed as 'unknown'", async () => {
    const { task, turn } = await finalize({ exit: null, out: "" });
    expect(turn.status).toBe("failed");
    expect(task.state).toBe("failed");
    expect(task.state_detail).toContain("exited unknown");
  });

  test("interrupt wins over everything — even a clean exit with a result and a kill reason", async () => {
    const { task, turn } = await finalize({
      exit: 0,
      out: `${RESULT_LINE}\n`,
      pre: (turnId) => {
        recordKillReason(turnId, "log cap exceeded (test)");
        markInterrupted(turnId, "turn interrupted — session kept, send a correction");
      },
    });
    expect(turn.status).toBe("interrupted");
    expect(task.state).toBe("needs-input");
    expect(task.state_detail).toBe("turn interrupted — session kept, send a correction");
  });

  test("kill reason wins over a clean exit with a result", async () => {
    const { task, turn } = await finalize({
      exit: 0,
      out: `${RESULT_LINE}\n`,
      pre: (turnId) => recordKillReason(turnId, "log cap exceeded (5000000 bytes)"),
    });
    expect(turn.status).toBe("failed");
    expect(task.state).toBe("failed");
    expect(task.state_detail).toBe("turn killed: log cap exceeded (5000000 bytes)");
  });

  test("allowEmptyResult opts a json adapter out of the result requirement", async () => {
    const { task, turn } = await finalize({
      def: { ...jsonAdapter, allowEmptyResult: true },
      exit: 0,
      out: "",
    });
    expect(turn.status).toBe("done");
    expect(turn.result).toBeNull();
    expect(task.state).toBe("done");
  });

  test("text adapters keep the plain exit-code contract (no result payload to demand)", async () => {
    const { task, turn } = await finalize({
      def: { bin: "true", exec: [], parse: { format: "text" }, attach: null },
      exit: 0,
      out: "",
    });
    expect(turn.status).toBe("done");
    expect(task.state).toBe("done");
  });
});

describe("image turns (S3, spike ts7efd)", () => {
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]); // 11 B
  const JPG = Buffer.from([0xff, 0xd8, 0xff, 4, 5]); // 5 B

  test(
    "stdin-envelope turn: no positional prompt, one NDJSON line (image blocks before the text block), stdin closed",
    async () => {
      const def: AdapterDef = {
        bin: "bash",
        // bash -c: the first extra arg is $0 (not counted), so the strategy's
        // two argv elements yield $#=1 — a leaked positional prompt would make
        // it 2; cat relays stdin to the log, and only EOF (stdin closed) lets
        // this turn end
        exec: ["-c", 'echo "argc=$#"; cat'],
        imageInput: "claude-stream-json",
        parse: { format: "text" },
        attach: null,
      };
      const task = makeTask();
      const stored = writeTurnAttachments(task.id, 1, [
        { name: "red.png", mediaType: "image/png", data: PNG },
        { name: "shot.jpg", mediaType: "image/jpeg", data: JPG },
      ]);
      startTurn(task, "what colors?", def, cfg, stored);
      await until(() => turnsFor(task.id)[0]?.status === "done");

      const lines = readFileSync(turnsFor(task.id)[0]!.log_file, "utf8").split("\n");
      expect(lines[0]).toBe("· attached: red.png (11 B), shot.jpg (5 B)"); // the note leads the log
      expect(lines[1]).toBe("argc=1"); // the strategy's argv only ($0 excluded) — NO positional prompt
      const envelope = JSON.parse(lines[2]!);
      expect(envelope.type).toBe("user");
      expect(envelope.message.role).toBe("user");
      const content = envelope.message.content as { type: string; source?: { data: string; media_type: string }; text?: string }[];
      expect(content.map((c) => c.type)).toEqual(["image", "image", "text"]); // base64 blocks before the text block
      expect(content[0]!.source).toEqual({ type: "base64", media_type: "image/png", data: PNG.toString("base64") });
      expect(content[1]!.source).toEqual({ type: "base64", media_type: "image/jpeg", data: JPG.toString("base64") });
      expect(content[2]!.text).toContain("what colors?"); // turn 1: preamble + message
      // the turn settled at all: cat exited, which only happens on stdin EOF — stdin was closed
      expect(lines[3]).toBe(""); // exactly one NDJSON line, nothing after
    },
    15_000,
  );

  test("argv-template turn: the paths land before the prompt, after the note line", async () => {
    const def: AdapterDef = {
      bin: "bash",
      exec: ["-c", 'printf "%s\\n" "$0" "$@"'], // one argv element per line
      image: ["-i", "{path}", "--"],
      parse: { format: "text" },
      attach: null,
    };
    const task = makeTask();
    const stored = writeTurnAttachments(task.id, 1, [{ name: "red.png", mediaType: "image/png", data: PNG }]);
    startTurn(task, "see it?", def, cfg, stored);
    await until(() => turnsFor(task.id)[0]?.status === "done");

    const out = readFileSync(turnsFor(task.id)[0]!.log_file, "utf8");
    expect(out.split("\n")[0]).toBe("· attached: red.png (11 B)");
    // bash -c script a b c → $0=a: the expanded template runs -i <path> -- <prompt>
    expect(out).toContain(`-i\n${stored[0]!.path}\n--\n`);
    expect(out).toContain("see it?");
  });
});

describe("non-destructive active messages", () => {
  test("a stale task snapshot cannot persist work after archive", async () => {
    const task = makeTask();
    setTaskFields(task.id, { archived: 1 });
    await expect(submitTaskMessage(task, "too late", bashAdapter("true"), cfg)).rejects.toThrow(
      "task is archived — archived tasks are read-only",
    );
    expect(messagesFor(task.id)).toEqual([]);
    expect(turnsFor(task.id)).toEqual([]);
  });

  test("a stable-ID retry replaces bytes orphaned before the message row was inserted", async () => {
    const task = makeTask();
    transition(task.id, "done", "ready");
    const id = "orphaned-message-id";
    const image = {
      name: "red.png",
      mediaType: "image/png" as const,
      data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    };
    writeMessageAttachments(task.id, id, [image]);

    const result = await submitTaskMessage(task, "retry", bashAdapter("echo ok"), cfg, [image], id);
    expect(result.disposition).toBe("started");
    await until(() => turnsFor(task.id)[0]?.status === "done");
    expect(JSON.parse(turnsFor(task.id)[0]!.attachments_json!)).toEqual([
      { name: "red.png", size: image.data.length, mediaType: "image/png" },
    ]);
  });

  test("an unsupported active harness queues FIFO and drains into later turns without interruption", async () => {
    const def = bashAdapter('sleep 0.25; printf "done\\n"');
    const task = makeTask();
    startTurn(task, "first", def, cfg);
    await until(() => hasRunningTurn(task.id) !== null);

    const firstQueued = await submitTaskMessage(getTask(task.id)!, "second", def, cfg);
    const secondQueued = await submitTaskMessage(getTask(task.id)!, "third", def, cfg);
    expect(firstQueued.disposition).toBe("queued-next");
    expect(secondQueued.disposition).toBe("queued-next");
    expect(turnsFor(task.id)).toHaveLength(1);
    expect(turnsFor(task.id)[0]!.status).toBe("running");

    await until(() => turnsFor(task.id).length === 3 && turnsFor(task.id)[2]?.status === "done");
    expect(turnsFor(task.id).map((turn) => [turn.n, turn.prompt, turn.status])).toEqual([
      [1, "first", "done"],
      [2, "second", "done"],
      [3, "third", "done"],
    ]);
    expect(messagesFor(task.id).map((message) => [message.text, message.delivery, message.turn_n])).toEqual([
      ["second", "started", 2],
      ["third", "started", 3],
    ]);
  });

  test("Claude stream-json accepts a safe-boundary message inside the active turn", async () => {
    const script = [
      "IFS= read -r first",
      "IFS= read -r second",
      `printf '{"type":"input","value":%s}\\n' "$second"`,
      `printf '%s\\n' '{"type":"result","result":"steered","session_id":"session-live"}'`,
    ].join("; ");
    const def: AdapterDef = {
      bin: "bash",
      exec: ["-c", script],
      liveInput: "claude-stream-json",
      parse: { format: "json", resultType: "result", result: "result", session: "session_id" },
      attach: null,
    };
    const task = makeTask();
    startTurn(task, "original", def, cfg);
    await until(() => hasRunningTurn(task.id) !== null);

    const result = await submitTaskMessage(getTask(task.id)!, "correction", def, cfg);
    expect(result.disposition).toBe("steered");
    expect(result.message).toMatchObject({ status: "delivered", delivery: "steered", turn_n: 1 });
    await until(() => turnsFor(task.id)[0]?.status === "done");

    expect(turnsFor(task.id)).toHaveLength(1);
    const lines = readFileSync(turnsFor(task.id)[0]!.log_file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const admitted = lines.find((line) => line.type === "input");
    expect(admitted.value.message.content.at(-1).text).toBe("correction");
    expect(getTask(task.id)!.session_id).toBe("session-live");
  });

  test("a rejected live-driver boot kills the child and fails the turn truthfully", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wisp-live-boot-failure-"));
    const harnessPath = join(dir, "fake-droid");
    writeFileSync(
      harnessPath,
      `#!/usr/bin/env bun
import { createInterface } from "node:readline";
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  const request = JSON.parse(line);
  process.stdout.write(JSON.stringify({
    jsonrpc: "2.0",
    id: request.id,
    error: { message: "boot refused" },
  }) + "\\n");
  break;
}
setInterval(() => {}, 1000);
`,
    );
    chmodSync(harnessPath, 0o755);
    const def: AdapterDef = {
      bin: harnessPath,
      exec: [],
      liveInput: "droid-jsonrpc",
      parse: {
        format: "json",
        resultType: "completion",
        result: "finalText",
        session: "session_id",
      },
      attach: null,
    };
    const task = makeTask();
    startTurn(task, "original", def, cfg);

    await until(() => getTask(task.id)?.state === "failed");
    expect(turnsFor(task.id)[0]).toMatchObject({ status: "failed" });
    expect(getTask(task.id)?.state_detail).toContain(
      "live input setup failed: Droid JSON-RPC rejected the request: boot refused",
    );
  });

  test("Droid JSON-RPC admits a stable-id correction into the active agent loop", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wisp-droid-live-"));
    const callsPath = join(dir, "calls.jsonl");
    const harnessPath = join(dir, "fake-droid");
    writeFileSync(
      harnessPath,
      `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const calls = ${JSON.stringify(callsPath)};
const frame = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const notify = (notification) => frame({
  jsonrpc: "2.0",
  type: "notification",
  method: "droid.session_notification",
  params: { notification },
});
let messages = 0;
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  const request = JSON.parse(line);
  appendFileSync(calls, JSON.stringify(request) + "\\n");
  if (request.method === "droid.initialize_session") {
    frame({ jsonrpc: "2.0", id: request.id, result: {
      sessionId: "droid-live-session",
      settings: { modelId: "fake-droid-model", reasoningEffort: "off" },
    } });
  } else if (request.method === "droid.add_user_message") {
    messages++;
    frame({ jsonrpc: "2.0", id: request.id, result: {} });
    if (messages === 2) {
      notify({ type: "create_message", message: {
        id: "assistant-1",
        role: "assistant",
        content: [{ type: "text", text: "STEERED_DROID" }],
        modelId: "fake-droid-model",
        createdAt: 123,
      } });
      notify({ type: "agent_turn_completed", reason: "completed", turnId: request.params.messageId,
        tokenUsage: { inputTokens: 5, outputTokens: 2, cacheReadTokens: 1, factoryCredits: 3 } });
      notify({ type: "droid_working_state_changed", newState: "idle" });
    }
  }
}
`,
    );
    chmodSync(harnessPath, 0o755);
    const def: AdapterDef = {
      bin: harnessPath,
      exec: [],
      liveInput: "droid-jsonrpc",
      parse: {
        format: "json",
        resultType: "completion",
        result: "finalText",
        session: "session_id",
        model: "model",
        usage: "usage",
      },
      attach: null,
    };
    const task = makeTask();
    startTurn(task, "original", def, cfg);
    await until(() => hasRunningTurn(task.id) !== null);

    const result = await submitTaskMessage(getTask(task.id)!, "correction", def, cfg, [], "stable-correction-id");
    expect(result.disposition).toBe("steered");
    expect(result.message).toMatchObject({
      id: "stable-correction-id",
      status: "delivered",
      delivery: "steered",
      turn_n: 1,
    });
    await until(() => turnsFor(task.id)[0]?.status === "done");

    const calls = readFileSync(callsPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(calls.map((call) => call.method)).toEqual([
      "droid.initialize_session",
      "droid.add_user_message",
      "droid.add_user_message",
    ]);
    expect(FACTORY_PROTOCOL_VERSION).toBe("1.204.0");
    expect(calls[0]).toMatchObject({
      factoryApiVersion: "1.0.0",
      factoryProtocolVersion: FACTORY_PROTOCOL_VERSION,
    });
    expect(calls[0].params).toMatchObject({
      cwd: task.worktree_path,
      skipPermissionsUnsafe: false,
    });
    expect(calls[1].params).toMatchObject({
      text: expect.stringContaining("original"),
      queuePlacement: "end_of_turn",
    });
    expect(calls[2].params).toEqual({
      messageId: "stable-correction-id",
      text: "correction",
      queuePlacement: "end_of_turn",
    });
    const [turn] = turnsFor(task.id);
    expect(turn?.result).toBe("STEERED_DROID");
    expect(turn?.model).toBe("fake-droid-model");
    expect(JSON.parse(turn!.usage_json!)).toEqual({
      input_tokens: 5,
      output_tokens: 2,
      cache_read_input_tokens: 1,
      factory_credits: 3,
    });
    expect(getTask(task.id)?.session_id).toBe("droid-live-session");
  });

  test("Codex app-server steers the active turn with its expected turn id", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wisp-codex-live-"));
    const callsPath = join(dir, "calls.jsonl");
    const harnessPath = join(dir, "fake-codex");
    writeFileSync(
      harnessPath,
      `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const calls = ${JSON.stringify(callsPath)};
const frame = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const notify = (method, params) => frame({ jsonrpc: "2.0", method, params });
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  const request = JSON.parse(line);
  appendFileSync(calls, JSON.stringify(request) + "\\n");
  if (request.method === "initialize") {
    frame({ jsonrpc: "2.0", id: request.id, result: { userAgent: "fake", codexHome: "/tmp", platformFamily: "unix", platformOs: "test" } });
  } else if (request.method === "thread/start") {
    frame({ jsonrpc: "2.0", id: request.id, result: {
      thread: { id: "codex-live-thread" },
      model: "fake-codex-model",
    } });
  } else if (request.method === "turn/start") {
    frame({ jsonrpc: "2.0", id: request.id, result: { turn: { id: "codex-live-turn" } } });
  } else if (request.method === "turn/steer") {
    frame({ jsonrpc: "2.0", id: request.id, result: { turnId: "codex-live-turn" } });
    notify("item/completed", {
      threadId: "codex-live-thread",
      turnId: "codex-live-turn",
      completedAtMs: 123,
      item: { type: "agentMessage", id: "agent-1", text: "STEERED_CODEX", phase: "final_answer" },
    });
    notify("thread/tokenUsage/updated", {
      threadId: "codex-live-thread",
      turnId: "codex-live-turn",
      tokenUsage: { last: { totalTokens: 9, inputTokens: 7, cachedInputTokens: 2,
        cacheWriteInputTokens: 0, outputTokens: 2, reasoningOutputTokens: 0 } },
    });
    notify("turn/completed", {
      threadId: "codex-live-thread",
      turn: { id: "codex-live-turn", status: "completed", error: null },
    });
  }
}
`,
    );
    chmodSync(harnessPath, 0o755);
    const def: AdapterDef = {
      bin: harnessPath,
      exec: ["exec", "--dangerously-bypass-approvals-and-sandbox"],
      liveInput: "codex-app-server",
      parse: { format: "json", strategy: "codex-jsonl" },
      attach: null,
    };
    const task = makeTask();
    startTurn(task, "original", def, cfg);
    await until(() => hasRunningTurn(task.id) !== null);

    const result = await submitTaskMessage(getTask(task.id)!, "correction", def, cfg, [], "stable-codex-id");
    expect(result.disposition).toBe("steered");
    await until(() => turnsFor(task.id)[0]?.status === "done");

    const calls = readFileSync(callsPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((call) => call.id !== undefined);
    expect(calls.map((call) => call.method)).toEqual([
      "initialize",
      "thread/start",
      "turn/start",
      "turn/steer",
    ]);
    expect(calls[1].params).toMatchObject({
      cwd: task.worktree_path,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
    expect(calls[2].params).toMatchObject({
      threadId: "codex-live-thread",
      clientUserMessageId: expect.any(String),
      input: [expect.objectContaining({ type: "text", text: expect.stringContaining("original") })],
    });
    expect(calls[3].params).toEqual({
      threadId: "codex-live-thread",
      expectedTurnId: "codex-live-turn",
      clientUserMessageId: "stable-codex-id",
      input: [{ type: "text", text: "correction", text_elements: [] }],
    });
    const [turn] = turnsFor(task.id);
    expect(turn?.result).toBe("STEERED_CODEX");
    expect(turn?.model).toBe("fake-codex-model");
    expect(JSON.parse(turn!.usage_json!)).toEqual({
      total_tokens: 9,
      input_tokens: 7,
      cached_input_tokens: 2,
      cache_write_input_tokens: 0,
      output_tokens: 2,
      reasoning_output_tokens: 0,
    });
    expect(getTask(task.id)?.session_id).toBe("codex-live-thread");
  });
});

describe("pid identity (a prior audit)", () => {
  // json adapter + result line so re-adoption finalizes have something to parse
  const jsonAdapter: AdapterDef = {
    bin: "true",
    exec: [],
    parse: { format: "json", resultType: "result", result: "result", session: "session_id" },
    attach: null,
  };
  const RESULT_LINE = '{"type":"result","result":"salvaged from logs","session_id":"sess-h1"}';

  /** A running-task row with a pre-written result log, plus a turn we control the pid columns of. */
  function readoptedTurn(pid: number, startTime: string | null) {
    const task = makeTask();
    transition(task.id, "running", "turn 1");
    const outPath = join(mkdtempSync(join(tmpdir(), "wisp-h1-")), "turn.out.log");
    writeFileSync(outPath, `${RESULT_LINE}\n`);
    createTurn(task.id, 1, "prompt", pid, outPath, startTime);
    return task;
  }

  test("identity match: a live process with its recorded start time is alive", async () => {
    const child = Bun.spawn({ cmd: ["sleep", "5"] });
    try {
      const started = processStartTime(child.pid);
      expect(started).not.toBeNull();
      expect(await pidIdentity(child.pid, started)).toBe("alive");
    } finally {
      child.kill();
      await child.exited;
    }
  });

  test("identity mismatch: a live pid with a different recorded start time is gone, never alive", async () => {
    // process.pid (this test runner) is definitely alive — but it is not the
    // process whose start time we "recorded", so it must read as gone
    expect(await pidIdentity(process.pid, "Thu Jan  1 00:00:00 1970")).toBe("gone");
  });

  test("an exited pid is dead even with a matching recorded start time", async () => {
    const child = Bun.spawn({ cmd: ["sleep", "0"] });
    const started = processStartTime(child.pid);
    await child.exited;
    expect(await pidIdentity(child.pid, started)).toBe("dead");
    expect(processStartTime(child.pid)).toBeNull();
  });

  test("EPERM means the pid EXISTS: pid 1 is alive on identity match, gone on mismatch — never dead", async () => {
    // kill(1, 0) throws EPERM for a non-root user; the old pidAlive caught
    // everything and reported dead → early finalize while the real process ran.
    const actual = processStartTime(1);
    expect(actual).not.toBeNull();
    expect(await pidIdentity(1, actual)).toBe("alive");
    expect(await pidIdentity(1, "Thu Jan  1 00:00:00 1970")).toBe("gone");
  });

  test("unvalidatable rows (null start time) fall back to bare liveness", async () => {
    expect(await pidIdentity(process.pid, null)).toBe("alive");
    const child = Bun.spawn({ cmd: ["sleep", "0"] });
    await child.exited;
    expect(await pidIdentity(child.pid, null)).toBe("dead");
  });

  test("re-adoption finalizes a turn whose pid was reused, from logs, without signaling it", async () => {
    // the "reused" pid is this very test runner: if recoverOrphanedTurns signaled it,
    // the suite would die — surviving IS the assertion that no signal was sent
    const task = readoptedTurn(process.pid, "Thu Jan  1 00:00:00 1970");
    await recoverOrphanedTurns({ fake: jsonAdapter }, cfg);
    const turn = turnsFor(task.id)[0]!;
    expect(turn.status).toBe("done"); // exit unknown, but the log holds a parsed result
    expect(turn.result).toBe("salvaged from logs");
    expect(getTask(task.id)!.state).toBe("done");
  });

  test(
    "re-adoption with a validated identity waits for the process, then finalizes",
    async () => {
      const child = Bun.spawn({ cmd: ["sleep", "1"] });
      const task = readoptedTurn(child.pid, processStartTime(child.pid));
      await recoverOrphanedTurns({ fake: jsonAdapter }, cfg);
      // still running: a matching identity must be waited on, not finalized early
      expect(turnsFor(task.id)[0]!.status).toBe("running");
      await child.exited;
      await until(() => turnsFor(task.id)[0]!.status !== "running"); // 3s poll tick
      expect(turnsFor(task.id)[0]!.status).toBe("done");
      expect(getTask(task.id)!.state).toBe("done");
    },
    15_000,
  );

  test("interrupt refuses to signal a re-adopted turn whose pid was reused", async () => {
    const task = readoptedTurn(process.pid, "Thu Jan  1 00:00:00 1970");
    // again: wrongly signaling would SIGTERM the test runner itself
    await expect(interruptTurn(task.id)).rejects.toThrow("already gone");
    // the turn was NOT marked interrupted — finalize judges the real outcome
    await finalizeTurn(task.id, turnsFor(task.id)[0]!.id, jsonAdapter, null, turnsFor(task.id)[0]!.log_file, "/nonexistent");
    expect(turnsFor(task.id)[0]!.status).toBe("done");
  });
});

describe("persisted interrupt intent (a prior audit)", () => {
  const jsonAdapter: AdapterDef = {
    bin: "true",
    exec: [],
    parse: { format: "json", resultType: "result", result: "result", session: "session_id" },
    attach: null,
  };

  test("intent survives a daemon restart: re-adoption finalizes as interrupted, not failed", async () => {
    const task = makeTask();
    transition(task.id, "running", "turn 1");
    const outPath = join(mkdtempSync(join(tmpdir(), "wisp-m2-")), "turn.out.log");
    writeFileSync(outPath, ""); // interrupted mid-stream: no result line to salvage
    const child = Bun.spawn({ cmd: ["sleep", "0"] });
    const turnId = createTurn(task.id, 1, "prompt", child.pid, outPath, processStartTime(child.pid));
    // the old daemon killed the child and persisted the intent…
    markInterrupted(turnId, "turn interrupted — session kept, send a correction");
    await child.exited;
    // …then crashed before finalize. The restarted daemon has no in-memory state,
    // so this only passes if finalize reads the intent from the turn row.
    await recoverOrphanedTurns({ fake: jsonAdapter }, cfg);
    expect(turnsFor(task.id)[0]!.status).toBe("interrupted");
    const after = getTask(task.id)!;
    expect(after.state).toBe("needs-input");
    expect(after.state_detail).toBe("turn interrupted — session kept, send a correction");
    // the user hears "needs-input", never the spurious "failed" webhook M2 complained about
    const rows = undeliveredOutbox().filter((r) => r.task_id === task.id);
    expect(rows.map((r) => r.event)).toEqual(["needs-input"]);
  });
});

describe("killTurnForArchive (force-archive, a prior audit)", () => {
  test("no running turn is a no-op", async () => {
    const task = makeTask();
    await killTurnForArchive(task.id);
    expect(hasRunningTurn(task.id)).toBeNull();
  });

  test(
    "kills the live turn, marks it interrupted, and only returns once the row is finalized",
    async () => {
      const task = makeTask();
      startTurn(task, "long turn", bashAdapter("sleep 30"), cfg);
      await until(() => hasRunningTurn(task.id) !== null);

      await killTurnForArchive(task.id);

      // the contract: by the time this resolves, nothing is 'running' anymore,
      // so the caller can safely remove the worktree
      expect(hasRunningTurn(task.id)).toBeNull();
      const turn = turnsFor(task.id)[0]!;
      expect(turn.status).toBe("interrupted");
      const after = getTask(task.id)!;
      expect(after.state).toBe("needs-input");
      expect(after.state_detail).toBe("turn interrupted by force-archive");
    },
    15_000,
  );

  test(
    "escalates to SIGKILL when the harness traps SIGTERM",
    async () => {
      const task = makeTask();
      startTurn(task, "stubborn turn", bashAdapter("trap '' TERM; sleep 30"), cfg);
      await until(() => hasRunningTurn(task.id) !== null);
      // give bash a beat to install the trap before we signal
      await Bun.sleep(300);

      await killTurnForArchive(task.id, 500);

      expect(hasRunningTurn(task.id)).toBeNull();
      expect(turnsFor(task.id)[0]!.status).toBe("interrupted");
    },
    15_000,
  );
});

describe("interruptTurn", () => {
  test(
    "marks the turn interrupted and the task needs-input with the steer hint",
    async () => {
      const task = makeTask();
      startTurn(task, "interrupt me", bashAdapter("sleep 30"), cfg);
      await until(() => hasRunningTurn(task.id) !== null);

      await interruptTurn(task.id);

      // The composer can issue /send as soon as /interrupt resolves.
      expect(hasRunningTurn(task.id)).toBeNull();
      expect(turnsFor(task.id)[0]!.status).toBe("interrupted");
      const after = getTask(task.id)!;
      expect(after.state).toBe("needs-input");
      expect(after.state_detail).toBe("turn interrupted — session kept, send a correction");
    },
    15_000,
  );

  test(
    "escalates to SIGKILL when the harness traps SIGTERM, and says so in state_detail (a prior audit)",
    async () => {
      const task = makeTask();
      startTurn(task, "stubborn turn", bashAdapter("trap '' TERM; sleep 30"), cfg);
      await until(() => hasRunningTurn(task.id) !== null);
      // give bash a beat to install the trap before we signal
      await Bun.sleep(300);

      await interruptTurn(task.id, 500);

      expect(hasRunningTurn(task.id)).toBeNull();
      expect(turnsFor(task.id)[0]!.status).toBe("interrupted");
      const after = getTask(task.id)!;
      expect(after.state).toBe("needs-input");
      expect(after.state_detail).toContain("escalated to SIGKILL");
      expect(after.state_detail).toContain("send a correction");
    },
    15_000,
  );

  test("throws loudly when there is no running turn", async () => {
    const task = makeTask();
    await expect(interruptTurn(task.id)).rejects.toThrow("no running turn");
  });
});

describe("startup sweep for stale 'creating' tasks (a prior audit)", () => {
  test("fails a wedged task loudly, with a reason and an outbox row", () => {
    const wedged = makeTask(); // createTask leaves it in 'creating'
    expect(getTask(wedged.id)!.state).toBe("creating");

    failStaleCreatingTasks();

    const after = getTask(wedged.id)!;
    expect(after.state).toBe("failed");
    expect(after.state_detail).toContain("being created");
    // 'failed' is notify-worthy: the user must hear about the wedge, not discover it
    const rows = undeliveredOutbox().filter((r) => r.task_id === wedged.id);
    expect(rows.length).toBe(1);
    expect(rows[0]!.event).toBe("failed");
  });

  test("leaves tasks in every other state alone", () => {
    const running = makeTask();
    transition(running.id, "running", "turn 1");
    const done = makeTask();
    transition(done.id, "done", "finished");

    failStaleCreatingTasks();

    expect(getTask(running.id)!.state).toBe("running");
    expect(getTask(done.id)!.state).toBe("done");
  });
});
