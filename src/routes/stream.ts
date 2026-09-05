import { createActivityFormatter, createEventFormatter, type ActivityEvent, type AdapterDef } from "../adapters";
import { subscribe } from "../events";
import { readSlice } from "../fsutil";
import { latestTurnForTask, turnForTask } from "../store";
import type { Task, Turn } from "../types";
import { err, integerQueryParam } from "./http";

/**
 * Bytes of a turn's log the follow stream seeds from its START.
 *
 * A reload mid-turn used to open at the last 16 KB, so landing on a running
 * task showed a transcript beginning mid-thought — the same task looked
 * different depending on when you opened it. Reading from offset 0 makes a
 * refresh, or a second browser, see what someone watching since turn 1 sees.
 *
 * This is a FIRST-READ budget, not a cap on what is delivered: `offset` lands
 * wherever the read stopped and the ordinary append loop carries the rest, so
 * a log larger than this still arrives in full, just progressively. It exists
 * only so the first frame is not blocked on a multi-megabyte read.
 */
const LOG_BACKLOG_BYTES = 1_048_576;

const SSE_HEADERS = { "content-type": "text/event-stream", "cache-control": "no-cache" };

/**
 * Bun.serve's idleTimeout is 30s — an SSE stream with no traffic for that
 * long gets disconnected, so both streams send a comment heartbeat under it.
 */
const SSE_HEARTBEAT_MS = 15_000;

/** Concurrent /api/events subscribers are capped (each holds a stream + timers). */
const MAX_EVENT_STREAMS = 32;
let activeEventStreams = 0;

/** Same cap for log follow streams: each holds a stream, a poll timer, a heartbeat, and an events subscription. */
const MAX_LOG_STREAMS = 32;
let activeLogStreams = 0;

/** GET /api/events: every emitted WispEvent as one SSE `data:` frame. */
export function eventStream(): Response {
  if (activeEventStreams >= MAX_EVENT_STREAMS) return err("too many event stream subscribers", 503);
  activeEventStreams++;
  const enc = new TextEncoder();
  let closed = false;
  let unsubscribe: (() => void) | null = null;
  let hb: ReturnType<typeof setInterval> | null = null;
  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    unsubscribe?.();
    if (hb !== null) clearInterval(hb);
    activeEventStreams--;
  };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      unsubscribe = subscribe((evt) => {
        if (closed) return;
        try {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(evt)}\n\n`));
        } catch {
          cleanup(); // the client vanished between cancel() and an in-flight emit
        }
      });
      hb = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(enc.encode(": hb\n\n"));
        } catch {
          cleanup();
        }
      }, SSE_HEARTBEAT_MS);
    },
    cancel() {
      cleanup();
    },
  });
  return new Response(stream, { headers: SSE_HEADERS });
}

/** How often a log stream checks its turn's log file for new bytes. */
const LOG_STREAM_POLL_MS = 500;
/** Per-poll read cap — same tail -f semantics as the polling log endpoint. */
const LOG_STREAM_SLICE = 262_144;

/**
 * GET /api/tasks/:id/log/stream?turn=n&format=activity|human|raw — the streaming
 * replacement for tail polling: a progressive backlog from byte zero, append
 * events as bytes land, turn-end when the turn settles, and task state events.
 * The stream stays open across turns; the client closes it when switching.
 *
 * All follow transitions are driven by ONE serialized poll tick reading the
 * turn rows — the db is the source of truth and is written before any event
 * fires, so the events subscription only forwards task state instantly and
 * fast-paths the next tick at turn boundaries. That is what keeps the frame
 * order (append… → turn-end → backlog) race-free.
 */
export function logStream(task: Task, url: URL, adapters: Record<string, AdapterDef>): Response {
  const format = url.searchParams.get("format") ?? "human";
  if (format !== "activity" && format !== "human" && format !== "raw") {
    return err(`format must be activity, human or raw, got '${format}'`, 400);
  }
  // same validation the polling route has: turn=abc used to be coerced to
  // "follow latest" — a client bug answered as if it were a choice
  const turn = integerQueryParam(url, "turn", 1);
  if (turn instanceof Response) return turn;
  // a refused request must not consume a slot — the count moves only once
  // the stream is certain to exist (and cleanup() hands it back)
  if (activeLogStreams >= MAX_LOG_STREAMS) return err("too many log stream subscribers", 503);
  activeLogStreams++;
  const requested = turn;
  const def = adapters[task.harness]; // unknown harness → formatEvent passes lines through, like the CLI

  const enc = new TextEncoder();
  let closed = false;
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let unsubscribe: (() => void) | null = null;
  let poll: ReturnType<typeof setInterval> | null = null;
  let hb: ReturnType<typeof setInterval> | null = null;

  // follow state: which turn's log is open and how far we've read
  let currentN: number | null = null;
  let logFile = "";
  let offset = 0;
  let leftover = ""; // the CLI `log -f` idiom: a trailing partial line rides into the next chunk
  let lastOpened = 0;
  let ticking = false;
  let resumeDrain: (() => void) | null = null;
  let formatLine = createEventFormatter(def);
  let activityLine = createActivityFormatter(def);

  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    unsubscribe?.();
    if (poll !== null) clearInterval(poll);
    if (hb !== null) clearInterval(hb);
    resumeDrain?.();
    resumeDrain = null;
    activeLogStreams--;
  };

  const waitForCapacity = async (): Promise<void> => {
    if (closed || (controller.desiredSize ?? 1) > 0) return;
    await new Promise<void>((resolve) => {
      resumeDrain = resolve;
    });
  };

  const send = (event: string, data: unknown): void => {
    if (closed) return;
    try {
      controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
    } catch {
      cleanup(); // the client vanished mid-tick
    }
  };

  type RenderedChunk =
    | { kind: "text"; text: string }
    | { kind: "activity"; activity: ActivityEvent[] };

  /**
   * Human/activity formats consume complete JSONL records; raw keeps byte
   * exact chunks. Structured activity is the web contract, while human stays
   * stable for `wisp log` and existing API clients.
   */
  const renderChunk = (chunk: string): RenderedChunk => {
    if (format === "raw") return { kind: "text", text: chunk };
    const lines = (leftover + chunk).split("\n");
    leftover = lines.pop() ?? "";
    if (format === "activity") {
      const out: ActivityEvent[] = [];
      for (const line of lines) out.push(...activityLine(line));
      return { kind: "activity", activity: out };
    }
    const out: string[] = [];
    for (const line of lines) {
      const rendered = formatLine(line);
      if (rendered !== null) out.push(rendered);
    }
    return { kind: "text", text: out.join("\n") };
  };

  const sendRendered = (
    event: "backlog" | "append",
    turn: number,
    rendered: RenderedChunk,
    prompt?: string,
  ): void => {
    if (event === "append") {
      const empty = rendered.kind === "activity" ? rendered.activity.length === 0 : rendered.text.length === 0;
      if (empty) return;
    }
    const head = event === "backlog" ? { turn, prompt: prompt ?? "" } : { turn };
    send(event, rendered.kind === "activity" ? { ...head, activity: rendered.activity } : { ...head, text: rendered.text });
  };

  const openTurn = async (turn: Turn): Promise<void> => {
    currentN = turn.n;
    lastOpened = turn.n;
    logFile = turn.log_file;
    leftover = "";
    formatLine = createEventFormatter(def); // dedupe state belongs to exactly one turn
    activityLine = createActivityFormatter(def); // ids and lifecycle correlation belong to exactly one turn
    // From the START of the turn, offset-tracked so the append stream continues
    // exactly where the backlog stopped (no gap, no overlap). Anything past the
    // first-read budget is picked up by the ordinary append loop.
    const backlog = await readSlice(turn.log_file, 0, LOG_BACKLOG_BYTES);
    offset = backlog.size;
    // the turn row stores the user's actual message (the wisp preamble lives
    // only in the spawned argv), so the stream pane can show each turn's prompt
    const rendered = renderChunk(backlog.text);
    await waitForCapacity();
    if (closed) return;
    sendRendered("backlog", turn.n, rendered, turn.prompt);
  };

  /** The turn settled: drain every remaining byte (turn-end never precedes output), flush, report. */
  const endTurn = async (status: string): Promise<void> => {
    const n = currentN!;
    for (;;) {
      const slice = await readSlice(logFile, offset, LOG_STREAM_SLICE);
      if (slice.size === offset) break; // no new bytes
      offset = slice.size;
      await waitForCapacity();
      if (closed) return;
      sendRendered("append", n, renderChunk(slice.text));
    }
    if (format !== "raw" && leftover) {
      await waitForCapacity();
      if (closed) return;
      if (format === "activity") {
        sendRendered("append", n, { kind: "activity", activity: activityLine(leftover) });
      } else {
        const rendered = formatLine(leftover);
        if (rendered !== null) sendRendered("append", n, { kind: "text", text: rendered });
      }
    }
    leftover = "";
    await waitForCapacity();
    if (closed) return;
    send("turn-end", { turn: n, status });
    currentN = null;
  };

  const tick = async (): Promise<void> => {
    if (ticking || closed) return;
    ticking = true;
    try {
      for (;;) {
        if (closed) return;
        if (currentN === null) {
          // idle: open the requested turn once, else follow the newest one
          const next =
            lastOpened === 0 && requested !== null
              ? (turnForTask(task.id, requested) ?? latestTurnForTask(task.id))
              : latestTurnForTask(task.id);
          if (next && next.n > lastOpened) {
            await openTurn(next);
            continue;
          }
          return;
        }
        const slice = await readSlice(logFile, offset, LOG_STREAM_SLICE);
        if (slice.size !== offset) {
          offset = slice.size;
          await waitForCapacity();
          if (closed) return;
          sendRendered("append", currentN, renderChunk(slice.text));
        }
        const row = turnForTask(task.id, currentN);
        if (row && row.status !== "running") {
          await endTurn(row.status);
          continue; // a newer turn may already exist — switch to it in the same tick
        }
        return;
      }
    } finally {
      ticking = false;
    }
  };

  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
      unsubscribe = subscribe((evt) => {
        if (evt.type === "task" && evt.taskId === task.id) {
          send("state", { state: evt.state, state_detail: evt.stateDetail });
        } else if ((evt.type === "turn" || evt.type === "message") && evt.taskId === task.id) {
          void tick(); // turn boundary: fast-path the poll instead of waiting out the interval
        }
      });
      poll = setInterval(() => void tick(), LOG_STREAM_POLL_MS);
      hb = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(enc.encode(": hb\n\n"));
        } catch {
          cleanup();
        }
      }, SSE_HEARTBEAT_MS);
      void tick(); // the initial backlog
    },
    cancel() {
      cleanup();
    },
    pull() {
      const resume = resumeDrain;
      resumeDrain = null;
      resume?.();
    },
  });
  return new Response(stream, { headers: SSE_HEADERS });
}
