import { readFileSync, writeSync } from "node:fs";
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
import { formatSteerNote } from "./turn-notes";
import type { Task, TaskMessage } from "./types";

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
  outFd: number;
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
        staged("live output pump", pumpClaude(options.child, options.task.id, options.turnId, options.outFd)),
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
  prompt: string,
  attachments: StoredAttachment[],
): void {
  try {
    const files = attachments.map((attachment) => ({
      mediaType: attachment.mediaType as string,
      dataBase64: readFileSync(attachment.path).toString("base64"),
    }));
    const sink = child.stdin;
    if (!sink || typeof sink === "number") return;
    void Promise.resolve(sink.write(`${strategy.envelope(prompt, files)}\n`)).catch(() => {});
    void Promise.resolve(sink.end()).catch(() => {});
  } catch {
    // The child is already gone; its watcher owns finalization.
  }
}

function envelopeFor(strategy: ImageInputStrategy, prompt: string, attachments: StoredAttachment[]): string {
  const files = attachments.map((attachment) => ({
    mediaType: attachment.mediaType as string,
    dataBase64: readFileSync(attachment.path).toString("base64"),
  }));
  return strategy.envelope(prompt, files);
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
      await write(envelopeFor(strategy, message.text, files));
      noteDelivery(options.outFd, message, files);
    },
    close,
  });
  return write(envelopeFor(strategy, options.prompt, options.attachments));
}

async function pumpClaude(
  child: ReturnType<typeof Bun.spawn>,
  taskId: string,
  turnId: number,
  outFd: number,
): Promise<void> {
  const stdout = child.stdout;
  if (!stdout || typeof stdout === "number") return;
  const reader = (stdout as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  const frames = new JsonLineBuffer({ onDrop: frameDropNote(outFd) });
  const consume = (line: string): void => {
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
      writeSync(outFd, value);
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
function frameDropNote(outFd: number): (chars: number) => void {
  return (chars) => {
    writeSync(outFd, `· dropped an oversized live protocol frame (${chars} characters); the turn continues\n`);
  };
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
function noteDelivery(outFd: number, message: TaskMessage, files: StoredAttachment[]): void {
  writeSync(outFd, `${formatSteerNote(message.id, message.text)}\n`);
  if (files.length > 0) writeSync(outFd, `${formatAttachNote(files)}\n`);
}

function droidImages(attachments: StoredAttachment[]): DroidLiveImage[] {
  return attachments.map((attachment) => ({
    type: "base64",
    data: readFileSync(attachment.path).toString("base64"),
    mediaType: attachment.mediaType,
  }));
}

function configureDroid(options: ConfigureLiveTurnOptions): Promise<void> {
  const sink = options.child.stdin;
  if (!sink || typeof sink === "number") throw new Error("Droid live process did not expose stdin");
  const emit = (event: Record<string, unknown>): void => {
    writeSync(options.outFd, `${JSON.stringify(event)}\n`);
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
    initialImages: droidImages(options.attachments),
    emit,
    onTerminal: () => void closeLiveInput(options.task.id, options.turnId),
  });
  liveInputs.set(options.task.id, {
    turnId: options.turnId,
    turn: options.turn,
    async send(message) {
      const files = messageAttachments(options.task.id, message);
      await driver.send(message.id, message.text, droidImages(files));
      noteDelivery(options.outFd, message, files);
    },
    close: () => driver.close(),
  });
  return Promise.all([
    staged("live input setup", driver.ready),
    staged("live output pump", pumpJsonLines(options.child, options.outFd, driver, "Droid closed the JSON-RPC channel")),
  ]).then(() => {});
}

function codexInput(text: string, attachments: StoredAttachment[]): CodexLiveInput[] {
  return [
    ...attachments.map((attachment) => ({ type: "localImage" as const, path: attachment.path })),
    { type: "text", text, text_elements: [] },
  ];
}

function configureCodex(options: ConfigureLiveTurnOptions): Promise<void> {
  const sink = options.child.stdin;
  if (!sink || typeof sink === "number") throw new Error("Codex live process did not expose stdin");
  const emit = (event: Record<string, unknown>): void => {
    writeSync(options.outFd, `${JSON.stringify(event)}\n`);
  };
  const driver = new CodexLiveDriver({
    sink,
    def: options.def,
    cwd: options.task.worktree_path!,
    sessionId: options.task.session_id,
    model: options.task.model,
    effort: options.task.effort,
    initialMessageId: options.initialMessageId,
    initialInput: codexInput(options.prompt, options.attachments),
    emit,
    onTerminal: () => void closeLiveInput(options.task.id, options.turnId),
  });
  liveInputs.set(options.task.id, {
    turnId: options.turnId,
    turn: options.turn,
    async send(message) {
      const files = messageAttachments(options.task.id, message);
      await driver.send(message.id, codexInput(message.text, files));
      noteDelivery(options.outFd, message, files);
    },
    close: () => driver.close(),
  });
  return Promise.all([
    staged("live input setup", driver.ready),
    staged("live output pump", pumpJsonLines(options.child, options.outFd, driver, "Codex closed the app-server channel")),
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
  outFd: number,
  driver: JsonLineDriver,
  closedMessage: string,
): Promise<void> {
  const stdout = child.stdout;
  if (!stdout || typeof stdout === "number") return;
  const reader = (stdout as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  const frames = new JsonLineBuffer({ onDrop: frameDropNote(outFd) });
  const consume = (line: string): void => {
    if (!line.trim()) return;
    try {
      driver.handle(JSON.parse(line));
    } catch {
      // Malformed stdout is evidence of protocol drift and stays in the log.
      writeSync(outFd, `${line}\n`);
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
