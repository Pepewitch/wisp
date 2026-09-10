import { createActivityFormatter, createEventFormatter, type ActivityEvent, type AdapterDef } from "../adapters";
import { subscribe } from "../events";
import { readSlice } from "../fsutil";
import { subscribeTurnBroker, type BrokerGap, type TurnBrokerSubscription } from "../recording/broker";
import { latestTurnForTask, turnForTask } from "../store";
import { acquireTranscriptRead, TRANSCRIPT_EVICTED_NOTICE } from "../transcript-access";
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

type LogFormat = "activity" | "human" | "raw";
type RenderedChunk =
  | { kind: "text"; text: string }
  | { kind: "activity"; activity: ActivityEvent[] };

function evictedTranscript(format: LogFormat, turnId: number): RenderedChunk {
  return format === "activity"
    ? { kind: "activity", activity: [{ kind: "text", id: `transcript-evicted-${turnId}`, parentId: null, text: TRANSCRIPT_EVICTED_NOTICE }] }
    : { kind: "text", text: TRANSCRIPT_EVICTED_NOTICE };
}

/** Snapshot the primary prefix once; the broker owns any records after its offset. */
function turnBacklog(turn: Turn, snapshotEnd: number | undefined): Promise<{ text: string; size: number }> {
  const firstReadBytes = snapshotEnd === undefined
    ? LOG_BACKLOG_BYTES
    : Math.min(LOG_BACKLOG_BYTES, snapshotEnd);
  return readSlice(turn.log_file, 0, firstReadBytes);
}

function subscribeLogEvents(taskId: string, send: (event: string, data: unknown) => void, tick: () => Promise<void>): () => void {
  return subscribe(evt => {
    if (evt.type === "task" && evt.taskId === taskId) {
      send("state", { state: evt.state, state_detail: evt.stateDetail });
    } else if ((evt.type === "turn" || evt.type === "message") && evt.taskId === taskId) {
      void tick();
    }
  });
}

class TurnStreamRenderer {
  private leftover = "";
  private formatLine: ReturnType<typeof createEventFormatter>;
  private activityLine: ReturnType<typeof createActivityFormatter>;

  constructor(readonly format: LogFormat, private readonly def?: AdapterDef) {
    this.formatLine = createEventFormatter(def);
    this.activityLine = createActivityFormatter(def);
  }

  reset(): void {
    this.leftover = "";
    this.formatLine = createEventFormatter(this.def);
    this.activityLine = createActivityFormatter(this.def);
  }

  chunk(chunk: string): RenderedChunk {
    if (this.format === "raw") return { kind: "text", text: chunk };
    const lines = (this.leftover + chunk).split("\n");
    this.leftover = lines.pop() ?? "";
    if (this.format === "activity") {
      return { kind: "activity", activity: lines.flatMap((line) => this.activityLine(line)) };
    }
    return { kind: "text", text: lines.map((line) => this.formatLine(line)).filter((line) => line !== null).join("\n") };
  }

  record(line: string, sequence: number): RenderedChunk {
    if (this.format === "activity") {
      return { kind: "activity", activity: this.activityLine(line, sequence) };
    }
    return { kind: "text", text: this.formatLine(line) ?? "" };
  }

  gap(gap: BrokerGap): RenderedChunk {
    const text = `· live display skipped ${gap.records} activity records (${gap.bytes} bytes) while the viewer was behind`;
    return this.format === "activity"
      ? { kind: "activity", activity: [{ kind: "text", id: `capture-gap-${gap.firstSequence}-${gap.lastSequence}`, parentId: null, text }] }
      : { kind: "text", text };
  }

  flush(): RenderedChunk | null {
    const line = this.leftover;
    this.leftover = "";
    if (!line || this.format === "raw") return null;
    return this.record(line, 0);
  }
}

async function pumpTurnBroker(
  turn: number,
  subscription: TurnBrokerSubscription,
  renderer: TurnStreamRenderer,
  active: () => boolean,
  waitForCapacity: () => Promise<void>,
  sendRendered: (event: "append", turn: number, rendered: RenderedChunk) => void,
): Promise<void> {
  for (;;) {
    const delivery = await subscription.next();
    if (!delivery || !active()) return;
    await waitForCapacity();
    if (!active()) return;
    const rendered = delivery.kind === "gap"
      ? renderer.gap(delivery)
      : renderer.record(delivery.record.line, delivery.record.sequence);
    sendRendered("append", turn, rendered);
  }
}

function emitRendered(
  send: (event: string, data: unknown) => void,
  event: "backlog" | "append",
  turn: number,
  rendered: RenderedChunk,
  prompt?: string,
): void {
  if (event === "append") {
    const empty = rendered.kind === "activity" ? rendered.activity.length === 0 : rendered.text.length === 0;
    if (empty) return;
  }
  const head = event === "backlog" ? { turn, prompt: prompt ?? "" } : { turn };
  send(event, rendered.kind === "activity" ? { ...head, activity: rendered.activity } : { ...head, text: rendered.text });
}

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
  const turn = integerQueryParam(url, "turn", 1);
  if (turn instanceof Response) return turn;
  // A refused request must not consume a subscriber slot.
  if (activeLogStreams >= MAX_LOG_STREAMS) return err("too many log stream subscribers", 503);
  activeLogStreams++;
  const requested = turn;
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
  let lastOpened = 0;
  let ticking = false;
  let resumeDrain: (() => void) | null = null;
  let brokerSubscription: TurnBrokerSubscription | null = null;
  let brokerPump: Promise<void> | null = null;
  let renderer = new TurnStreamRenderer(format, adapters[task.harness]);
  let releaseTranscript: (() => void) | null = null;
  let evicted = false;

  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    unsubscribe?.();
    if (poll !== null) clearInterval(poll);
    if (hb !== null) clearInterval(hb);
    brokerSubscription?.close();
    brokerSubscription = null;
    resumeDrain?.();
    resumeDrain = null;
    activeLogStreams--;
    releaseTranscript?.();
    releaseTranscript = null;
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

  const sendRendered = (event: "backlog" | "append", n: number, rendered: RenderedChunk, prompt?: string): void =>
    emitRendered(send, event, n, rendered, prompt);

  const drainPrimaryTo = async (turn: number, target: number): Promise<void> => {
    while (offset < target) {
      const slice = await readSlice(logFile, offset, Math.min(LOG_STREAM_SLICE, target - offset));
      if (slice.size === offset) return;
      offset = slice.size;
      await waitForCapacity();
      if (closed) return;
      sendRendered("append", turn, renderer.chunk(slice.text));
    }
  };

  const openTurn = async (turn: Turn): Promise<void> => {
    releaseTranscript?.();
    releaseTranscript = acquireTranscriptRead(turn.id);
    evicted = turn.capture_state === "evicted";
    currentN = turn.n;
    lastOpened = turn.n;
    logFile = turn.log_file;
    brokerSubscription?.close();
    brokerSubscription = format === "raw" ? null : subscribeTurnBroker(turn.id);
    brokerPump = null;
    // Formatter state, lifecycle correlation, and adapter semantics belong to
    // exactly one turn. A task may cross a harness boundary between turns.
    renderer = new TurnStreamRenderer(format, adapters[turn.harness]);
    if (evicted) {
      offset = 0;
      sendRendered("backlog", turn.n, evictedTranscript(format, turn.id), turn.prompt);
      return;
    }
    // From the START of the turn, offset-tracked so the append stream continues
    // exactly where the backlog stopped (no gap, no overlap). Anything past the
    // first-read budget is picked up by the ordinary append loop.
    const snapshotEnd = brokerSubscription?.primaryOffset;
    const backlog = await turnBacklog(turn, snapshotEnd);
    offset = backlog.size;
    // the turn row stores the user's actual message (the wisp preamble lives
    // only in the spawned argv), so the stream pane can show each turn's prompt
    const rendered = renderer.chunk(backlog.text);
    await waitForCapacity();
    if (closed) return;
    sendRendered("backlog", turn.n, rendered, turn.prompt);
    if (snapshotEnd !== undefined) {
      await drainPrimaryTo(turn.n, snapshotEnd);
      if (closed) return;
      brokerPump = pumpTurnBroker(
        turn.n,
        brokerSubscription!,
        renderer,
        () => !closed && currentN === turn.n,
        waitForCapacity,
        sendRendered,
      );
    }
  };

  /** The turn settled: drain every remaining byte (turn-end never precedes output), flush, report. */
  const endTurn = async (status: string): Promise<void> => {
    const n = currentN!;
    if (brokerPump) {
      await brokerPump;
      brokerPump = null;
      brokerSubscription?.close();
      brokerSubscription = null;
    } else if (!evicted) {
      for (;;) {
        const slice = await readSlice(logFile, offset, LOG_STREAM_SLICE);
        if (slice.size === offset) break; // no new bytes
        offset = slice.size;
        await waitForCapacity();
        if (closed) return;
        sendRendered("append", n, renderer.chunk(slice.text));
      }
    }
    const final = renderer.flush();
    if (final) {
      await waitForCapacity();
      if (closed) return;
      sendRendered("append", n, final);
    }
    await waitForCapacity();
    if (closed) return;
    send("turn-end", { turn: n, status });
    currentN = null;
    releaseTranscript?.();
    releaseTranscript = null;
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
        if (!brokerPump && !evicted) {
          const slice = await readSlice(logFile, offset, LOG_STREAM_SLICE);
          if (slice.size !== offset) {
            offset = slice.size;
            await waitForCapacity();
            if (closed) return;
            sendRendered("append", currentN, renderer.chunk(slice.text));
          }
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
      unsubscribe = subscribeLogEvents(task.id, send, tick);
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
