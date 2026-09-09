import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdapterDef } from "../src/adapters";
import type { WispConfig } from "../src/config";
import { authorized, postSession, route } from "../src/daemon";
import { ALLOWED_ORIGINS_ENV, originVerdict } from "../src/routes/auth";
import { closeTurnBroker, openTurnBroker, TurnBroker } from "../src/recording/broker";
import { createTask, createTurn, finishTurn, freeSlot, newTaskId, transition } from "../src/store";
import { formatSteerNote } from "../src/turn-notes";

const cfg: WispConfig = {
  instanceId: "123e4567-e89b-42d3-a456-426614174000",
  port: 0,
  host: "127.0.0.1",
  token: "testtoken",
  webhooks: [],
  stuckMinutes: 10,
  logMaxBytes: 5_000_000,
  setupTimeoutMinutes: 10,
  envAllowlist: {},
  harnessDefaults: {},
};

/** Minimal adapter def with a real event formatter, so human-format rendering is exercised. */
const FAKE_DEF: AdapterDef = {
  bin: "fake",
  exec: [],
  parse: { format: "json" },
  events: "droid-stream-json",
  activity: "droid-stream-json",
};

/** Call the daemon's router the way serve() does after auth. */
function call(path: string, init?: RequestInit): Response | Promise<Response> {
  const url = new URL(`http://wisp.test${path}`);
  return route(new Request(url, init), url, url.pathname, cfg, { fake: FAKE_DEF });
}

function makeTask() {
  return createTask({
    id: newTaskId(),
    title: "stream test",
    repo_path: "/tmp/repo",
    harness: "fake",
    model: null,
    slot: freeSlot(),
  });
}

interface Frame {
  event: string | null;
  data: string;
}

/**
 * Incremental SSE frame reader. Heartbeats are comments and skipped; timeouts
 * fail loudly so a broken stream can never hang the suite. A timed-out read
 * KEEPS its pending reader.read() promise — abandoning it would silently eat
 * the next chunk (a read that resolves into the void).
 */
function sseReader(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const dec = new TextDecoder();
  let text = "";
  let pending: Promise<ReadableStreamReadResult<Uint8Array>> | null = null;
  return {
    async nextFrame(timeoutMs = 5_000): Promise<Frame> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const idx = text.indexOf("\n\n");
        if (idx >= 0) {
          const raw = text.slice(0, idx);
          text = text.slice(idx + 2);
          if (raw.startsWith(":")) continue; // ": hb" heartbeat
          let event: string | null = null;
          let data = "";
          for (const line of raw.split("\n")) {
            if (line.startsWith("event: ")) event = line.slice("event: ".length);
            else if (line.startsWith("data: ")) data += (data === "" ? "" : "\n") + line.slice("data: ".length);
          }
          return { event, data };
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error(`timed out waiting for an SSE frame (buffered: ${JSON.stringify(text)})`);
        pending ??= reader.read();
        const chunk = await Promise.race([pending, Bun.sleep(remaining).then(() => "timeout" as const)]);
        if (chunk === "timeout") continue; // `pending` survives — the deadline check above throws on the next pass
        pending = null;
        if (chunk.done) throw new Error("stream ended before the next SSE frame");
        text += dec.decode(chunk.value, { stream: true });
      }
    },
  };
}

describe("POST /api/session (token verification for the browser auth dialog)", () => {
  test("the right token is accepted; anything else is a 401", async () => {
    const ok = await postSession(
      new Request("http://wisp.test/api/session", { method: "POST", body: JSON.stringify({ token: "testtoken" }) }),
      cfg,
    );
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true });

    const wrong = await postSession(
      new Request("http://wisp.test/api/session", { method: "POST", body: JSON.stringify({ token: "nope" }) }),
      cfg,
    );
    expect(wrong.status).toBe(401);

    // a near-miss (differs only in the last char) is exactly as unauthorized
    const nearMiss = await postSession(
      new Request("http://wisp.test/api/session", { method: "POST", body: JSON.stringify({ token: "testtokeo" }) }),
      cfg,
    );
    expect(nearMiss.status).toBe(401);

    // A malformed body is a different mistake from a wrong token, and says so
    // (ENG-09's body contract now covers this route too).
    const garbage = await postSession(new Request("http://wisp.test/api/session", { method: "POST", body: "{" }), cfg);
    expect(garbage.status).toBe(400);
    expect(((await garbage.json()) as { error: string }).error).toContain("not valid JSON");
  });

  /** SEC-01: the route no longer mints an ambient credential — it retires the one older releases minted. */
  test("mints no token cookie and expires the pre-0.4 one", async () => {
    const ok = await postSession(
      new Request("http://wisp.test/api/session", { method: "POST", body: JSON.stringify({ token: "testtoken" }) }),
      cfg,
    );
    const cookie = ok.headers.get("set-cookie") ?? "";
    expect(cookie).not.toContain("wisp_token=testtoken");
    expect(cookie).toContain("wisp_token=;");
    expect(cookie).toContain("Max-Age=0");
  });

  /** A body that is valid JSON but not an object is a named 400, never a 500 (ENG-09). */
  test("a non-object JSON body is a named 400, not a crash and not 'unauthorized'", async () => {
    for (const body of ["null", "[]", '"testtoken"', "7"]) {
      const response = await postSession(
        new Request("http://wisp.test/api/session", { method: "POST", body }),
        cfg,
      );
      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: string }).error).toContain("must be a JSON object");
    }
  });

  /** An empty body still means "no token given", which is unauthorized. */
  test("an empty body is unauthorized, not malformed", async () => {
    const response = await postSession(new Request("http://wisp.test/api/session", { method: "POST" }), cfg);
    expect(response.status).toBe(401);
  });
});

describe("authorized() — the bearer header, and nothing ambient", () => {
  const at = (init?: RequestInit) => authorized(new Request("http://wisp.test/api/tasks", init), cfg);

  test("accepts the bearer header (the CLI path)", () => {
    expect(at({ headers: { authorization: "Bearer testtoken" } })).toBe(true);
  });

  /**
   * SEC-01. `wisp_token` used to be accepted here and its value WAS the root
   * token; cookies are scoped to host, never to port, so every other local
   * HTTP service received a full-control credential. No cookie authenticates
   * anything now, including one carrying the correct token.
   */
  test("rejects the retired wisp_token cookie even when it holds the real token", () => {
    expect(at({ headers: { cookie: "wisp_token=testtoken" } })).toBe(false);
    expect(at({ headers: { cookie: "other=1; wisp_token=testtoken; theme=dark" } })).toBe(false);
  });

  test("rejects a wrong bearer and no auth at all", () => {
    expect(at({ headers: { authorization: "Bearer wrong" } })).toBe(false);
    // a near-miss differs only in the last char — still not the token
    expect(at({ headers: { authorization: "Bearer testtokeo" } })).toBe(false);
    expect(at()).toBe(false);
    // the token is not a credential anywhere but the Authorization header
    expect(at({ headers: { "x-wisp-token": "testtoken" } })).toBe(false);
  });
});

describe("originVerdict() — whose page sent this", () => {
  const verdict = (headers?: Record<string, string>) => {
    const url = new URL("http://127.0.0.1:18710/api/tasks/t1/terminal");
    return originVerdict(new Request(url, { headers }), url);
  };

  test("this daemon's own origin is allowed", () => {
    expect(verdict({ origin: "http://127.0.0.1:18710" })).toBe("allowed");
  });

  /** SEC-02: a port is not a boundary for cookies, but it IS a distinct origin. */
  test("another port on the same host is foreign", () => {
    expect(verdict({ origin: "http://127.0.0.1:19999" })).toBe("foreign");
  });

  test("a sibling host, an unrelated site, a scheme change, and null are all foreign", () => {
    expect(verdict({ origin: "http://localhost:18710" })).toBe("foreign");
    expect(verdict({ origin: "https://attacker.example" })).toBe("foreign");
    expect(verdict({ origin: "https://127.0.0.1:18710" })).toBe("foreign");
    expect(verdict({ origin: "null" })).toBe("foreign");
  });

  test("no Origin at all is a non-browser client, reported as absent", () => {
    expect(verdict()).toBe("absent");
  });

  test("a reverse-proxy origin can be allowed deliberately, and only exactly", () => {
    const previous = process.env[ALLOWED_ORIGINS_ENV];
    process.env[ALLOWED_ORIGINS_ENV] = "https://wisp.example.ts.net , https://other.example";
    try {
      expect(verdict({ origin: "https://wisp.example.ts.net" })).toBe("allowed");
      expect(verdict({ origin: "https://other.example" })).toBe("allowed");
      expect(verdict({ origin: "https://wisp.example.ts.net.attacker.example" })).toBe("foreign");
      expect(verdict({ origin: "http://wisp.example.ts.net" })).toBe("foreign");
    } finally {
      if (previous === undefined) delete process.env[ALLOWED_ORIGINS_ENV];
      else process.env[ALLOWED_ORIGINS_ENV] = previous;
    }
  });
});

describe("GET /api/events (SSE stream of every WispEvent)", () => {
  test("streams task and turn events as data frames, from store choke points", async () => {
    const res = await call("/api/events");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    const reader = res.body!.getReader();
    const sse = sseReader(reader);
    try {
      const task = makeTask();
      transition(task.id, "running", "turn 1");
      const f1 = await sse.nextFrame();
      expect(f1.event).toBeNull(); // no named event — the JSON type field carries it
      expect(JSON.parse(f1.data)).toEqual({
        type: "task",
        taskId: task.id,
        state: "running",
        stateDetail: "turn 1",
        seq: 1,
      });

      const turnId = createTurn(task.id, 1, "prompt", null, "/tmp/nope.out.log");
      const f2 = await sse.nextFrame();
      expect(JSON.parse(f2.data)).toEqual({ type: "turn", taskId: task.id, n: 1, status: "running" });

      finishTurn(turnId, "failed", 1, null);
      const f3 = await sse.nextFrame();
      expect(JSON.parse(f3.data)).toEqual({ type: "turn", taskId: task.id, n: 1, status: "failed" });
    } finally {
      await reader.cancel();
    }
  });

  test("concurrent subscribers are capped at 32 (503 beyond)", async () => {
    const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
    try {
      for (let i = 0; i < 32; i++) {
        const res = await call("/api/events");
        expect(res.status).toBe(200);
        readers.push(res.body!.getReader());
      }
      const over = await call("/api/events");
      expect(over.status).toBe(503);
    } finally {
      for (const r of readers) await r.cancel(); // cancel() runs cleanup and hands the slots back
    }
    // slots were really returned: the next subscriber succeeds
    const res = await call("/api/events");
    expect(res.status).toBe(200);
    await res.body!.getReader().cancel();
  });
});

describe("GET /api/tasks/:id/log/stream (SSE follow of a task's turns)", () => {
  const dir = mkdtempSync(join(tmpdir(), "wisp-stream-"));

  /**
   * The reload bug: the backlog used to be the last 16 KB, so landing on a
   * running task showed a transcript that began mid-thought — the same task
   * looked different depending on when you opened it.
   */
  test("the backlog starts at the BEGINNING of the turn, not its tail", async () => {
    const log = join(dir, "backlog-from-start.out.log");
    // comfortably past the old 16 KB tail: an opening line, a lot of filler,
    // and a closing line. All three have to be in the first frame.
    const filler = Array.from(
      { length: 400 },
      (_, i) => `{"type":"message","role":"assistant","text":"filler ${i} ${"x".repeat(60)}"}`,
    );
    writeFileSync(
      log,
      [
        `{"type":"message","role":"assistant","text":"THE VERY FIRST LINE"}`,
        ...filler,
        `{"type":"message","role":"assistant","text":"THE LAST LINE"}`,
        ``,
      ].join("\n"),
    );
    expect(Bun.file(log).size).toBeGreaterThan(16_384); // the old tail would have cut this

    const task = makeTask();
    createTurn(task.id, 1, "go", null, log);
    const res = await call(`/api/tasks/${task.id}/log/stream?turn=1`);
    const reader = res.body!.getReader();
    const sse = sseReader(reader);
    try {
      const backlog = await sse.nextFrame();
      expect(backlog.event).toBe("backlog");
      const { text } = JSON.parse(backlog.data) as { text: string };
      expect(text).toContain("THE VERY FIRST LINE");
      expect(text).toContain("THE LAST LINE");
      // and no "…" elision marker: the whole turn is there, not a slice of it
      expect(text.startsWith("…")).toBe(false);

      // the offset still lands at the end, so following continues with no gap
      // and no repeat of what the backlog already carried
      appendFileSync(log, `{"type":"message","role":"assistant","text":"AFTER"}\n`);
      const append = await sse.nextFrame();
      expect(JSON.parse(append.data)).toEqual({ turn: 1, text: "AFTER" });
    } finally {
      await reader.cancel();
    }
  });

  test("concurrent log streams are capped at 32 (503 beyond), same as /api/events", async () => {
    const task = makeTask();
    const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
    try {
      for (let i = 0; i < 32; i++) {
        const res = await call(`/api/tasks/${task.id}/log/stream`);
        expect(res.status).toBe(200);
        readers.push(res.body!.getReader());
      }
      const over = await call(`/api/tasks/${task.id}/log/stream`);
      expect(over.status).toBe(503);
      expect(await over.json()).toEqual({ error: "too many log stream subscribers" });
      // a refused request consumed no slot: a bad-format request still answers 400
      expect((await call(`/api/tasks/${task.id}/log/stream?format=yaml`)).status).toBe(400);
    } finally {
      for (const r of readers) await r.cancel(); // cancel() runs cleanup and hands the slots back
    }
    const res = await call(`/api/tasks/${task.id}/log/stream`);
    expect(res.status).toBe(200);
    await res.body!.getReader().cancel();
  });

  test("a malformed turn is a 400 naming the parameter, not a silent follow-latest", async () => {
    const task = makeTask();
    // turn=abc used to be coerced to null (follow the latest) — a client bug
    // answered as if it were a choice; the polling route 400s the same way
    for (const bad of ["abc", "0", "-1", "1.5"]) {
      const res = await call(`/api/tasks/${task.id}/log/stream?turn=${bad}`);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: `turn must be a positive integer, got ${JSON.stringify(bad)}` });
    }
    const ok = await call(`/api/tasks/${task.id}/log/stream?turn=1`);
    expect(ok.status).toBe(200);
    await ok.body!.getReader().cancel();
  });

  test("404 on unknown task, 400 on a bad format", async () => {
    expect((await call("/api/tasks/tzzzz9/log/stream")).status).toBe(404);
    const task = makeTask();
    expect((await call(`/api/tasks/${task.id}/log/stream?format=yaml`)).status).toBe(400);
  });

  test("Droid reasoning is normalized and deduped for humans, while raw JSONL stays exact", async () => {
    const log = join(dir, "duplicated-reasoning.out.log");
    const reasoning = JSON.stringify({
      type: "reasoning",
      id: "reason-1",
      text: "\nFirst thought\n\n- supporting detail",
      timestamp: 123,
    });
    const raw = `${reasoning}\n${reasoning}\n`;
    writeFileSync(log, raw);
    const task = makeTask();
    const turnId = createTurn(task.id, 1, "inspect it", null, log);
    finishTurn(turnId, "done", 0, "done");

    const humanRes = await call(`/api/tasks/${task.id}/log/stream?format=human&turn=1`);
    const humanReader = humanRes.body!.getReader();
    const human = sseReader(humanReader);
    try {
      const backlog = await human.nextFrame();
      expect(JSON.parse(backlog.data)).toEqual({
        turn: 1,
        prompt: "inspect it",
        text: "~ First thought\n~\n~ - supporting detail",
      });
    } finally {
      await humanReader.cancel();
    }

    const rawRes = await call(`/api/tasks/${task.id}/log/stream?format=raw&turn=1`);
    const rawReader = rawRes.body!.getReader();
    const rawSse = sseReader(rawReader);
    try {
      const backlog = await rawSse.nextFrame();
      expect(JSON.parse(backlog.data)).toEqual({ turn: 1, prompt: "inspect it", text: raw });
    } finally {
      await rawReader.cancel();
    }
  });

  test("activity format anchors a steered message where the log recorded it", async () => {
    const log = join(dir, "steered-message.out.log");
    writeFileSync(
      log,
      [
        JSON.stringify({ type: "message", role: "assistant", text: "Reading the config" }),
        formatSteerNote("mfaketestid01", "Use the safer approach\nand keep the tests green"),
        JSON.stringify({ type: "message", role: "assistant", text: "Switching approach" }),
        "",
      ].join("\n"),
    );
    const task = makeTask();
    const turnId = createTurn(task.id, 1, "original request", null, log);
    finishTurn(turnId, "done", 0, "Switching approach");

    // Twice: a reload re-reads the same log from byte zero, and the anchor has
    // to come back identically rather than drifting or duplicating.
    for (const _attempt of [1, 2]) {
      const res = await call(`/api/tasks/${task.id}/log/stream?format=activity&turn=1`);
      const reader = res.body!.getReader();
      const sse = sseReader(reader);
      try {
        const backlog = await sse.nextFrame();
        expect(backlog.event).toBe("backlog");
        const { activity } = JSON.parse(backlog.data) as { activity: { kind: string; id: string }[] };
        expect(activity.map((event) => [event.kind, event.id])).toEqual([
          ["text", "text-1"],
          ["message", "mfaketestid01"],
          ["text", "text-2"],
        ]);
        expect(activity[1]).toEqual({
          kind: "message",
          id: "mfaketestid01",
          parentId: null,
          text: "Use the safer approach and keep the tests green",
        });
      } finally {
        await reader.cancel();
      }
    }
  });

  test("activity format streams stable subagent lifecycle and parent ids", async () => {
    const log = join(dir, "structured-subagent.out.log");
    writeFileSync(
      log,
      [
        JSON.stringify({
          type: "tool_call",
          id: "task-call",
          toolName: "Task",
          parameters: { description: "Run focused tests", subagent_type: "worker", prompt: "Test it", await: false },
        }),
        JSON.stringify({
          type: "tool_result",
          toolId: "task-call",
          value: "task_id: child-1\nsession_id: session-1",
        }),
        JSON.stringify({
          type: "tool_call",
          id: "output-call",
          toolName: "TaskOutput",
          parameters: { task_id: "child-1", block: false },
        }),
        "",
      ].join("\n"),
    );
    const task = makeTask();
    const turnId = createTurn(task.id, 1, "delegate it", null, log);

    const res = await call(`/api/tasks/${task.id}/log/stream?format=activity&turn=1`);
    const reader = res.body!.getReader();
    const sse = sseReader(reader);
    try {
      const backlog = await sse.nextFrame();
      expect(backlog.event).toBe("backlog");
      expect(JSON.parse(backlog.data)).toEqual({
        turn: 1,
        prompt: "delegate it",
        activity: [
          {
            kind: "subagent",
            id: "task-call",
            parentId: null,
            timestamp: null,
            phase: "started",
            status: "running",
            background: true,
            title: "Run focused tests",
            agentType: "worker",
            model: null,
            effort: null,
            prompt: "Test it",
          },
          {
            kind: "subagent",
            id: "task-call",
            agentId: "child-1",
            parentId: null,
            timestamp: null,
            phase: "updated",
            status: "running",
            result: null,
            error: null,
            background: true,
          },
          {
            kind: "tool",
            id: "output-call",
            parentId: "child-1",
            timestamp: null,
            phase: "started",
            name: "TaskOutput",
            input: { task_id: "child-1", block: false },
          },
        ],
      });
      appendFileSync(
        log,
        `${JSON.stringify({
          type: "message",
          role: "user",
          text: "Background task completed.\ntask_id: child-1\ntype: worker\nreason: failed\ndescription: Run focused tests\noutput: One assertion failed",
        })}\n`,
      );
      const append = await sse.nextFrame();
      expect(append.event).toBe("append");
      expect(JSON.parse(append.data)).toEqual({
        turn: 1,
        activity: [{
          kind: "subagent",
          id: "child-1",
          agentId: "child-1",
          parentId: null,
          timestamp: null,
          phase: "completed",
          status: "failed",
          title: "Run focused tests",
          result: null,
          error: "One assertion failed",
        }],
      });
      finishTurn(turnId, "failed", 1, null);
      expect((await sse.nextFrame()).event).toBe("turn-end");
    } finally {
      await reader.cancel();
    }
  });

  test("a recorder stream switches atomically from its file snapshot to direct live activity", async () => {
    const log = join(dir, "broker-snapshot.out.log");
    const initial = `${JSON.stringify({ type: "message", role: "assistant", text: "retained" })}\n`;
    writeFileSync(log, initial);
    const task = makeTask();
    const turnId = createTurn(task.id, 1, "watch it", null, log, null, null, "recorder-v1");
    const broker = openTurnBroker(turnId);
    broker.setPrimaryOffset(Buffer.byteLength(initial));

    const res = await call(`/api/tasks/${task.id}/log/stream?format=activity&turn=1`);
    const reader = res.body!.getReader();
    const sse = sseReader(reader);
    try {
      const backlog = await sse.nextFrame();
      expect(JSON.parse(backlog.data)).toMatchObject({
        turn: 1,
        prompt: "watch it",
        activity: [{ kind: "text", text: "retained" }],
      });

      const direct = JSON.stringify({ type: "message", role: "assistant", text: "not retained" });
      broker.publish({ sequence: 42, source: "stdout", line: direct });
      const append = await sse.nextFrame();
      expect(JSON.parse(append.data)).toEqual({
        turn: 1,
        activity: [{ kind: "text", id: "text-42-1", parentId: null, timestamp: null, text: "not retained" }],
      });
      expect(await Bun.file(log).text()).not.toContain("not retained");

      closeTurnBroker(turnId);
      finishTurn(turnId, "done", 0, "done");
      expect((await sse.nextFrame()).event).toBe("turn-end");
    } finally {
      closeTurnBroker(turnId);
      await reader.cancel();
    }
  });

  test(
    "human format: formatted backlog, appended bytes, partial-line buffering, turn-end, cross-turn switch, state events",
    // poll cadence is 500ms and the partial-line absence check costs 1.5s — this needs room over bun's 5s default
    { timeout: 20_000 },
    async () => {
    const log1 = join(dir, "t1.out.log");
    writeFileSync(
      log1,
      [
        `{"type":"system","subtype":"init","session_id":"s-1"}`,
        `{"type":"message","role":"assistant","text":"hello human"}`,
        `{"type":"usage","tokens":7}`, // the droid formatter drops this as noise
        ``,
      ].join("\n"),
    );
    const task = makeTask();
    const turnId = createTurn(task.id, 1, "do it", null, log1);

    const res = await call(`/api/tasks/${task.id}/log/stream?turn=1`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const reader = res.body!.getReader();
    const sse = sseReader(reader);
    try {
      const backlog = await sse.nextFrame();
      expect(backlog.event).toBe("backlog");
      expect(JSON.parse(backlog.data)).toEqual({ turn: 1, prompt: "do it", text: "· session s-1\nhello human" });

      // new bytes land → an append frame with the rendered line
      appendFileSync(log1, `{"type":"message","role":"assistant","text":"more"}\n`);
      const append = await sse.nextFrame();
      expect(append.event).toBe("append");
      expect(JSON.parse(append.data)).toEqual({ turn: 1, text: "more" });

      // Droid 0.205.0 can repeat a reasoning event exactly. The first frame is
      // normalized into one multiline Thinking block; the duplicate lands in
      // a later poll and is dropped without swallowing the real event after it.
      const reasoning = JSON.stringify({ type: "reasoning", id: "live-r1", text: "\nLive thought\nsecond line" });
      appendFileSync(log1, `${reasoning}\n`);
      const thought = await sse.nextFrame();
      expect(JSON.parse(thought.data)).toEqual({ turn: 1, text: "~ Live thought\n~ second line" });
      appendFileSync(log1, `${reasoning}\n{"type":"message","role":"assistant","text":"after duplicate"}\n`);
      const afterDuplicate = await sse.nextFrame();
      expect(JSON.parse(afterDuplicate.data)).toEqual({ turn: 1, text: "after duplicate" });

      // a partial line is buffered (the log -f leftover idiom) until its newline lands
      appendFileSync(log1, `{"type":"message","role":"assistant","text":"chain`);
      await expect(sse.nextFrame(1_500)).rejects.toThrow(/timed out/);
      appendFileSync(log1, `ed"}\n`);
      const joined = await sse.nextFrame();
      expect(JSON.parse(joined.data)).toEqual({ turn: 1, text: "chained" });

      // finishTurn emits synchronously, but the drain is async — the task's
      // state event is forwarded first, then turn-end. Both must arrive.
      finishTurn(turnId, "done", 0, "did it");
      transition(task.id, "done", "did it");
      const state = await sse.nextFrame();
      expect(state.event).toBe("state");
      expect(JSON.parse(state.data)).toEqual({ state: "done", state_detail: "did it" });
      const end = await sse.nextFrame();
      expect(end.event).toBe("turn-end");
      expect(JSON.parse(end.data)).toEqual({ turn: 1, status: "done" });

      // a new turn switches the stream: its backlog first, then appends continue
      const log2 = join(dir, "t2.out.log");
      writeFileSync(log2, `{"type":"message","role":"assistant","text":"second wind"}\n`);
      const turnId2 = createTurn(task.id, 2, "again", null, log2);
      const bl2 = await sse.nextFrame();
      expect(bl2.event).toBe("backlog");
      expect(JSON.parse(bl2.data)).toEqual({ turn: 2, prompt: "again", text: "second wind" });

      finishTurn(turnId2, "done", 0, "ok");
      const end2 = await sse.nextFrame();
      expect(end2.event).toBe("turn-end");
      expect(JSON.parse(end2.data)).toEqual({ turn: 2, status: "done" });
    } finally {
      await reader.cancel();
    }
    },
  );

  test("raw format sends bytes unmodified; a nonexistent requested turn opens the latest existing", async () => {
    const log = join(dir, "raw.out.log");
    writeFileSync(log, "line one\npartial two"); // no trailing newline — raw must not care
    const task = makeTask();
    const turnId = createTurn(task.id, 1, "raw", null, log);
    finishTurn(turnId, "done", 0, "x"); // settled before the stream opens: backlog, then turn-end

    const res = await call(`/api/tasks/${task.id}/log/stream?format=raw&turn=5`);
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const sse = sseReader(reader);
    try {
      const backlog = await sse.nextFrame();
      expect(backlog.event).toBe("backlog");
      expect(JSON.parse(backlog.data)).toEqual({ turn: 1, prompt: "raw", text: "line one\npartial two" });
      const end = await sse.nextFrame();
      expect(end.event).toBe("turn-end");
      expect(JSON.parse(end.data)).toEqual({ turn: 1, status: "done" });
    } finally {
      await reader.cancel();
    }
  });

  test(
    "a settled log larger than the first-read budget drains progressively without gaps",
    { timeout: 20_000 },
    async () => {
      const log = join(dir, "large-settled.out.log");
      const raw = `start:${"x".repeat(1_048_576 + 600_000)}:end`;
      writeFileSync(log, raw);
      const task = makeTask();
      const turnId = createTurn(task.id, 1, "large", null, log);
      finishTurn(turnId, "done", 0, "ok");

      const res = await call(`/api/tasks/${task.id}/log/stream?format=raw&turn=1`);
      const reader = res.body!.getReader();
      const sse = sseReader(reader);
      let rebuilt = "";
      let appends = 0;
      try {
        for (;;) {
          const frame = await sse.nextFrame();
          if (frame.event === "turn-end") break;
          const data = JSON.parse(frame.data) as { text: string };
          rebuilt += data.text;
          if (frame.event === "append") appends++;
        }
        expect(rebuilt).toBe(raw);
        expect(appends).toBeGreaterThan(1);
      } finally {
        await reader.cancel();
      }
    },
  );

  test("a task with no turns yet idles until turn 1 starts, then backlogs it", async () => {
    const task = makeTask(); // state 'creating', zero turns
    const res = await call(`/api/tasks/${task.id}/log/stream`);
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const sse = sseReader(reader);
    try {
      const log = join(dir, "first.out.log");
      writeFileSync(log, `{"type":"message","role":"assistant","text":"first breath"}\n`);
      createTurn(task.id, 1, "go", null, log);
      const backlog = await sse.nextFrame();
      expect(backlog.event).toBe("backlog");
      expect(JSON.parse(backlog.data)).toEqual({ turn: 1, prompt: "go", text: "first breath" });
    } finally {
      await reader.cancel();
    }
  });
});

describe("bounded live activity broker", () => {
  test("a slow subscriber gets an explicit gap followed by the retained tail", async () => {
    const broker = new TurnBroker();
    const subscriber = broker.subscribe(2, 1_000);
    broker.publish({ sequence: 1, source: "stdout", line: "one" });
    broker.publish({ sequence: 2, source: "stdout", line: "two" });
    broker.publish({ sequence: 3, source: "stdout", line: "three" });
    broker.close();

    expect(await subscriber.next()).toEqual({
      kind: "gap",
      firstSequence: 1,
      lastSequence: 1,
      records: 1,
      bytes: 4,
    });
    expect(await subscriber.next()).toEqual({
      kind: "record",
      record: { sequence: 2, source: "stdout", line: "two" },
    });
    expect(await subscriber.next()).toEqual({
      kind: "record",
      record: { sequence: 3, source: "stdout", line: "three" },
    });
    expect(await subscriber.next()).toBeNull();
  });
});
