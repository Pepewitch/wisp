import { readFileSync } from "node:fs";
import type { AdapterDef, ImageInputStrategy } from "./adapters";
import { CodexLiveDriver, type CodexLiveInput } from "./adapters/live/codex";
import { liveCommand } from "./adapters/live/command";
import { DroidLiveDriver, type DroidLiveImage } from "./adapters/live/droid";
import { JsonLineBuffer } from "./adapters/live/json-lines";
import {
  formatAttachNote,
  parseAttachmentManifest,
  readMessageAttachments,
  type StoredAttachment,
} from "./attachments";
import { deliveredMessage, nativeImageAttachments } from "./turn-input";
import { formatSteerNote } from "./turn-notes";
import type { Task, TaskMessage } from "./types";

export interface LiveOutputSink {
  recordEvent(event: Record<string, unknown>): void;
  recordStdoutLine(line: string): void;
  recordNote(note: string): void;
  recordFrameDrop(source: "stdout" | "stderr", chars: number): void;
}

export interface ActiveLiveInput {
  turnId: number;
  turn: number;
  send: (message: TaskMessage) => Promise<void>;
  close: () => Promise<void>;
}

interface ConfigureLiveTurnOptions {
  child: ReturnType<typeof Bun.spawn>;
  task: Task;
  def: AdapterDef;
  turnId: number;
  turn: number;
  recorder: LiveOutputSink;
  prompt: string;
  attachments: StoredAttachment[];
  initialMessageId: string;
  claudeStrategy?: ImageInputStrategy;
}

/** Verified active-turn inputs by task. Absence means durable next-turn fallback. */
const liveInputs = new Map<string, ActiveLiveInput>();
/** In-flight native admission acknowledgements, serialized per task. */
const pendingDeliveries = new Map<string, Promise<void>>();

export function activeLiveInput(taskId: string): ActiveLiveInput | undefined {
  return liveInputs.get(taskId);
}

export function pendingDelivery(taskId: string): Promise<void> | undefined {
  return pendingDeliveries.get(taskId);
}

export function setPendingDelivery(taskId: string, delivery: Promise<void>): void {
  pendingDeliveries.set(taskId, delivery);
}

export function clearPendingDelivery(taskId: string, delivery: Promise<void>): void {
  if (pendingDeliveries.get(taskId) === delivery) pendingDeliveries.delete(taskId);
}

export async function closeLiveInput(taskId: string, turnId: number): Promise<void> {
  const live = liveInputs.get(taskId);
  if (live?.turnId !== turnId) return;
  liveInputs.delete(taskId);
  await live.close().catch(() => {});
}

export { liveCommand };

export type LiveStage = "live input setup" | "live output pump";

/**
 * Which half of a live transport broke. Setup runs once while the turn is
 * starting; the pump runs for the whole turn, so a pump failure reported as
 * "setup" sends whoever reads it to the wrong end of the pipe.
 */
export class LiveTransportError extends Error {
  constructor(readonly stage: LiveStage, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
  }
}

function staged<T>(stage: LiveStage, work: Promise<T>): Promise<T> {
  return work.catch((error) => {
    throw error instanceof LiveTransportError ? error : new LiveTransportError(stage, error);
  });
}

export function configureLiveTurn(options: ConfigureLiveTurnOptions): Promise<void> {
  switch (options.def.liveInput) {
    case "claude-stream-json":
      if (!options.claudeStrategy) throw new Error("Claude live input strategy is unavailable");
      return Promise.all([
        staged("live input setup", configureClaude(options, options.claudeStrategy)),
        staged("live output pump", pumpClaude(options.child, options.task.id, options.turnId, options.recorder)),
      ]).then(() => {});
    case "droid-jsonrpc":
      return configureDroid(options);
    case "codex-app-server":
      return configureCodex(options);
    default:
      throw new Error(`unsupported live input strategy: ${String(options.def.liveInput)}`);
  }
}

/** Write one image envelope and close stdin for a non-live attaching turn. */
export function writeImageEnvelope(
  child: ReturnType<typeof Bun.spawn>,
  strategy: ImageInputStrategy,
  def: AdapterDef,
  prompt: string,
  attachments: StoredAttachment[],
): void {
  try {
    const files = envelopeFiles(def, attachments);
    const sink = child.stdin;
    if (!sink || typeof sink === "number") return;
    void Promise.resolve(sink.write(`${strategy.envelope(prompt, files)}\n`)).catch(() => {});
    void Promise.resolve(sink.end()).catch(() => {});
  } catch {
    // The child is already gone; its watcher owns finalization.
  }
}

/**
 * The base64 blocks an image envelope carries. Images only: a pdf or a video
 * has no block type here, and its path is already named in the prompt (A1d).
 */
function envelopeFiles(
  def: AdapterDef,
  attachments: StoredAttachment[],
): { mediaType: string; dataBase64: string }[] {
  return nativeImageAttachments(def, attachments).map((attachment) => ({
    mediaType: attachment.mediaType as string,
    dataBase64: readFileSync(attachment.path).toString("base64"),
  }));
}

function envelopeFor(
  strategy: ImageInputStrategy,
  def: AdapterDef,
  prompt: string,
  attachments: StoredAttachment[],
): string {
  return strategy.envelope(prompt, envelopeFiles(def, attachments));
}

function configureClaude(options: ConfigureLiveTurnOptions, strategy: ImageInputStrategy): Promise<void> {
  const sink = options.child.stdin;
  if (!sink || typeof sink === "number") throw new Error("live input process did not expose stdin");
  let closed = false;
  let chain = Promise.resolve();
  const write = (line: string): Promise<void> => {
    chain = chain.then(async () => {
      if (closed) throw new Error("live input already closed");
      await Promise.resolve(sink.write(`${line}\n`));
      await Promise.resolve(sink.flush());
    });
    return chain;
  };
  const close = (): Promise<void> => {
    chain = chain.then(async () => {
      if (closed) return;
      closed = true;
      await Promise.resolve(sink.end());
    });
    return chain;
  };
  liveInputs.set(options.task.id, {
    turnId: options.turnId,
    turn: options.turn,
    async send(message) {
      const files = messageAttachments(options.task.id, message);
      await write(envelopeFor(strategy, options.def, steerText(options.def, message, files), files));
      noteDelivery(options.recorder, message, files);
    },
    close,
  });
  return write(envelopeFor(strategy, options.def, options.prompt, options.attachments));
}

async function pumpClaude(
  child: ReturnType<typeof Bun.spawn>,
  taskId: string,
  turnId: number,
  recorder: LiveOutputSink,
): Promise<void> {
  const stdout = child.stdout;
  if (!stdout || typeof stdout === "number") return;
  const reader = (stdout as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  const frames = new JsonLineBuffer({ onDrop: frameDropNote(recorder) });
  const consume = (line: string): void => {
    recorder.recordStdoutLine(line);
    try {
      if ((JSON.parse(line) as { type?: unknown }).type === "result") {
        void closeLiveInput(taskId, turnId);
      }
    } catch {
      // Plain notes and partial/unknown future events are still logged.
    }
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      for (const line of frames.push(decoder.decode(value, { stream: true }))) consume(line);
    }
    for (const line of frames.finish(decoder.decode())) consume(line);
  } finally {
    reader.releaseLock();
  }
}

/**
 * An unreadable frame is visible in the turn log rather than fatal to the turn:
 * the harness keeps running and only that one notification is lost.
 */
function frameDropNote(recorder: LiveOutputSink): (chars: number) => void {
  return (chars) => recorder.recordFrameDrop("stdout", chars);
}

/**
 * A steer's text as the harness receives it. A queued message's attachments get
 * the same treatment a turn's prompt does: images that have a native channel
 * ride it, and everything delivered by path is named in the text — otherwise a
 * csv attached mid-turn would reach a live harness as bytes nobody mentioned.
 */
function steerText(def: AdapterDef, message: TaskMessage, files: StoredAttachment[]): string {
  return deliveredMessage(def, files, message.text);
}

function messageAttachments(taskId: string, message: TaskMessage): StoredAttachment[] {
  return readMessageAttachments(taskId, message.id, parseAttachmentManifest(message.attachments_json));
}

/**
 * The steer's own place in the turn's transcript, written to the harness's log
 * fd once the delivery has been admitted. Ordering on that fd is the ordering
 * the conversation replays, so the message lands between what the harness had
 * already said and whatever it does next — never beside the turn's prompt.
 */
function noteDelivery(recorder: LiveOutputSink, message: TaskMessage, files: StoredAttachment[]): void {
  recorder.recordNote(formatSteerNote(message.id, message.text));
  if (files.length > 0) recorder.recordNote(formatAttachNote(files));
}

function droidImages(def: AdapterDef, attachments: StoredAttachment[]): DroidLiveImage[] {
  return nativeImageAttachments(def, attachments).map((attachment) => ({
    type: "base64",
    data: readFileSync(attachment.path).toString("base64"),
    mediaType: attachment.mediaType,
  }));
}

function configureDroid(options: ConfigureLiveTurnOptions): Promise<void> {
  const sink = options.child.stdin;
  if (!sink || typeof sink === "number") throw new Error("Droid live process did not expose stdin");
  const emit = (event: Record<string, unknown>): void => {
    options.recorder.recordEvent(event);
  };
  const driver = new DroidLiveDriver({
    sink,
    def: options.def,
    cwd: options.task.worktree_path!,
    sessionId: options.task.session_id,
    model: options.task.model,
    effort: options.task.effort,
    initialMessageId: options.initialMessageId,
    initialText: options.prompt,
    initialImages: droidImages(options.def, options.attachments),
    emit,
    onTerminal: () => void closeLiveInput(options.task.id, options.turnId),
  });
  liveInputs.set(options.task.id, {
    turnId: options.turnId,
    turn: options.turn,
    async send(message) {
      const files = messageAttachments(options.task.id, message);
      await driver.send(message.id, steerText(options.def, message, files), droidImages(options.def, files));
      noteDelivery(options.recorder, message, files);
    },
    close: () => driver.close(),
  });
  return Promise.all([
    staged("live input setup", driver.ready),
    staged("live output pump", pumpJsonLines(options.child, options.recorder, driver, "Droid closed the JSON-RPC channel")),
  ]).then(() => {});
}

function codexInput(def: AdapterDef, text: string, attachments: StoredAttachment[]): CodexLiveInput[] {
  return [
    ...nativeImageAttachments(def, attachments).map((attachment) => ({
      type: "localImage" as const,
      path: attachment.path,
    })),
    { type: "text", text, text_elements: [] },
  ];
}

function configureCodex(options: ConfigureLiveTurnOptions): Promise<void> {
  const sink = options.child.stdin;
  if (!sink || typeof sink === "number") throw new Error("Codex live process did not expose stdin");
  const emit = (event: Record<string, unknown>): void => {
    options.recorder.recordEvent(event);
  };
  const driver = new CodexLiveDriver({
    sink,
    def: options.def,
    cwd: options.task.worktree_path!,
    sessionId: options.task.session_id,
    model: options.task.model,
    effort: options.task.effort,
    initialMessageId: options.initialMessageId,
    initialInput: codexInput(options.def, options.prompt, options.attachments),
    emit,
    onTerminal: () => void closeLiveInput(options.task.id, options.turnId),
  });
  liveInputs.set(options.task.id, {
    turnId: options.turnId,
    turn: options.turn,
    async send(message) {
      const files = messageAttachments(options.task.id, message);
      await driver.send(message.id, codexInput(options.def, steerText(options.def, message, files), files));
      noteDelivery(options.recorder, message, files);
    },
    close: () => driver.close(),
  });
  return Promise.all([
    staged("live input setup", driver.ready),
    staged("live output pump", pumpJsonLines(options.child, options.recorder, driver, "Codex closed the app-server channel")),
  ]).then(() => {});
}

interface JsonLineDriver {
  handle(frame: {
    id?: unknown;
    method?: unknown;
    params?: unknown;
    result?: unknown;
    error?: unknown;
  }): void;
  failPending(message: string): void;
}

async function pumpJsonLines(
  child: ReturnType<typeof Bun.spawn>,
  recorder: LiveOutputSink,
  driver: JsonLineDriver,
  closedMessage: string,
): Promise<void> {
  const stdout = child.stdout;
  if (!stdout || typeof stdout === "number") return;
  const reader = (stdout as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  const frames = new JsonLineBuffer({ onDrop: frameDropNote(recorder) });
  const consume = (line: string): void => {
    if (!line.trim()) return;
    try {
      driver.handle(JSON.parse(line));
    } catch {
      // Malformed stdout is evidence of protocol drift and stays in the log.
      recorder.recordStdoutLine(line);
    }
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      for (const line of frames.push(decoder.decode(value, { stream: true }))) consume(line);
    }
    for (const line of frames.finish(decoder.decode())) consume(line);
  } finally {
    driver.failPending(`${closedMessage} before acknowledging the request`);
    reader.releaseLock();
  }
}
