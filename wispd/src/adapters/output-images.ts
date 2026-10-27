import { basename } from "node:path";
import { outputImageNote, type OutputImage, type OutputStep } from "../../../shared/api/outputs";
import { readViewedImage } from "../output-files";
import { decodeOutputImage, outputStep, publishOutputImage } from "../outputs";
import { record, string } from "./activity-value";
import type { AdapterDef } from "./types";
import { cursorToolCall } from "./wire";

type RecordValue = Record<string, unknown>;
const isRecord = (value: unknown): value is RecordValue => Boolean(value && typeof value === "object" && !Array.isArray(value));
const IMAGE_FILE = /\.(png|jpe?g|gif|webp)$/i;
/** Tool calls remembered for their result's name and label; a turn's calls past this are forgotten oldest first. */
const MAX_REMEMBERED_CALLS = 512;

interface ToolCall { label: string; path: string | null }

export type OutputImageCapture = (event: RecordValue) => RecordValue;

/**
 * Captures the images a harness showed its agent, named after the file the
 * paired tool call read and anchored to that call's id, which is the id the
 * activity timeline gives the step. Only wire shapes taken from real harness
 * transcripts belong here; unknown payloads are left alone, and every harness
 * can publish files explicitly. Inline bytes are replaced with a text note
 * before transcript bounding, keeping adjacent text. A path is copied only
 * when the harness reports the agent just viewed it (see readViewedImage).
 */
export function createOutputImageCapture(def: AdapterDef, turnId: number, note: (text: string) => void): OutputImageCapture {
  const calls = new Map<string, ToolCall>();
  const remember = (id: string | null, name: string | null, input: unknown) => {
    if (!id) return;
    const fields = record(input);
    const path = string(fields.file_path) ?? string(fields.filePath) ?? string(fields.path);
    calls.set(id, { label: [name ?? "tool", path].filter(Boolean).join(" "), path });
    if (calls.size > MAX_REMEMBERED_CALLS) calls.delete(calls.keys().next().value!);
  };
  const stepOf = (id: string | null, label: string): OutputStep | null => outputStep(id, id ? calls.get(id)?.label ?? label : label);
  const saved = (publish: () => { name: string; size: number; id: string }): RecordValue => {
    try {
      const image = publish();
      const text = outputImageNote(image);
      note(`· ${text}`);
      return { type: "text", text };
    } catch (error) {
      const text = `Image output unavailable: ${error instanceof Error ? error.message : String(error)}`;
      note(`· ${text}`);
      return { type: "text", text };
    }
  };
  /** Inline base64 bytes, named after the call's file when it read one. */
  const inline = (data: unknown, declaredType: unknown, callId: string | null, fallbackLabel: string, path: string | null = null, source: OutputImage["source"] = "native"): RecordValue => {
    const extension = declaredType === "image/jpeg" ? "jpg" : declaredType === "image/gif" ? "gif" : declaredType === "image/webp" ? "webp" : "png";
    const file = path ?? (callId ? calls.get(callId)?.path : null) ?? null;
    return saved(() => publishOutputImage(turnId, decodeOutputImage(data), file ? basename(file) : `image.${extension}`, source, stepOf(callId, fallbackLabel)));
  };
  /** A file the harness reports the agent viewed; the event keeps its path and gains a note. */
  const viewed = (path: string, callId: string | null, label: string, readAtMs?: number | null): void => {
    saved(() => publishOutputImage(turnId, readViewedImage(turnId, path, readAtMs), basename(path), "native", stepOf(callId, label)));
  };

  return (event) => {
    if (def.events === "claude-stream-json") return claude(event, remember, inline);
    if (def.events === "droid-stream-json") return droid(event, remember, inline);
    if (def.events === "codex-jsonl") return codex(event, inline, viewed);
    if (def.events === "cursor-stream-json") return cursor(event, viewed);
    if (def.events === "opencode-json") return opencode(event, inline);
    return event;
  };
}

const MAY_CARRY_IMAGE = /image|\.(png|jpe?g|gif|webp)\b/i;

/**
 * Turns the recorder does not own (cursor and opencode run without live
 * input) write their stdout straight to the log, so the daemon sees their
 * events only once the turn ends: capture their images from the finished log
 * then. Bytes the log carries stay in it; publication is idempotent, and a
 * note the log already has is not written again, so a second settle of the
 * same log adds nothing.
 */
export function captureLoggedImages(def: AdapterDef, turnId: number, raw: string, note: (text: string) => void): void {
  if (!def.events) return;
  const logged = new Set(raw.split("\n"));
  const capture = createOutputImageCapture(def, turnId, (text) => {
    if (logged.has(text)) return;
    logged.add(text);
    note(text);
  });
  for (const line of raw.split("\n")) {
    if (!line.startsWith("{") || !MAY_CARRY_IMAGE.test(line)) continue;
    let event: unknown;
    try { event = JSON.parse(line); } catch { continue; }
    if (isRecord(event)) capture(event);
  }
}

type Remember = (id: string | null, name: string | null, input: unknown) => void;
type Inline = (data: unknown, declaredType: unknown, callId: string | null, fallbackLabel: string, path?: string | null, source?: OutputImage["source"]) => RecordValue;
type Viewed = (path: string, callId: string | null, label: string, readAtMs?: number | null) => void;

/** `tool_use` in an assistant message, then a `tool_result` with base64 image parts and the same `tool_use_id`. */
function claude(event: RecordValue, remember: Remember, inline: Inline): RecordValue {
  if (!isRecord(event.message) || !Array.isArray(event.message.content)) return event;
  if (event.type === "assistant") {
    for (const block of event.message.content) {
      if (isRecord(block) && block.type === "tool_use") remember(string(block.id), string(block.name), block.input);
    }
    return event;
  }
  if (event.type !== "user") return event;
  const content = event.message.content.map((block: unknown) => {
    if (!isRecord(block) || block.type !== "tool_result" || !Array.isArray(block.content)) return block;
    const callId = string(block.tool_use_id);
    return { ...block, content: block.content.map((part: unknown) => isRecord(part) && part.type === "image" && isRecord(part.source) && part.source.type === "base64"
      ? inline(part.source.data, part.source.media_type, callId, "tool") : part) };
  });
  return { ...event, message: { ...event.message, content } };
}

/** `tool_call {id, toolName, parameters}`, then `tool_result {id, value: [text, {type: image, source: {type: base64, mediaType}}]}`. */
function droid(event: RecordValue, remember: Remember, inline: Inline): RecordValue {
  if (event.type === "tool_call") {
    remember(string(event.id ?? event.toolCallId), string(event.toolName ?? event.toolId), event.parameters);
    return event;
  }
  if (event.type !== "tool_result" || !Array.isArray(event.value)) return event;
  const callId = string(event.id ?? event.toolCallId ?? event.toolId);
  if (!event.value.some((part: unknown) => isRecord(part) && part.type === "image")) return event;
  return { ...event, value: event.value.map((part: unknown) => isRecord(part) && part.type === "image" && isRecord(part.source) && part.source.type === "base64"
    ? inline(part.source.data, part.source.mediaType ?? part.source.media_type, callId, "tool") : part) };
}

/**
 * `item.completed` of an MCP image block, a local `image_view` (path only), or
 * an `image_generation` whose `result` is the whole base64 PNG (often over a
 * megabyte, so it must be captured before transcript bounding). A generated
 * image is one the agent made for the person, so it is recorded as shared. Its
 * `savedPath` lives in codex's own home, so only its name is used.
 */
function codex(event: RecordValue, inline: Inline, viewed: Viewed): RecordValue {
  if (event.type !== "item.completed" || !isRecord(event.item)) return event;
  const item = event.item;
  const callId = string(item.id);
  if (item.type === "mcp_tool_call" && isRecord(item.result) && Array.isArray(item.result.content)) {
    const label = ["mcp", [string(item.server), string(item.tool)].filter(Boolean).join("/")].filter(Boolean).join(" ");
    const content = item.result.content.map((block: unknown) => isRecord(block) && block.type === "image"
      ? inline(block.data, block.mimeType, callId, label) : block);
    return { ...event, item: { ...item, result: { ...item.result, content } } };
  }
  const path = string(item.path);
  if (item.type === "image_view" && path) {
    viewed(path, callId, `image_view ${path}`);
    return event;
  }
  if (item.type === "image_generation" && typeof item.result === "string" && item.result.length > 0) {
    const saved = string(item.savedPath ?? item.saved_path);
    const replaced = inline(item.result, "image/png", callId, "image generation", saved, "published");
    return { ...event, item: { ...item, result: replaced.text } };
  }
  return event;
}

/** A millisecond time cursor writes as a number or a decimal string. */
function milliseconds(value: unknown): number | null {
  const ms = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  return typeof ms === "number" && Number.isFinite(ms) ? ms : null;
}

/**
 * A completed `readToolCall` of an image file names the path it read; the
 * bytes are not on the wire, and cursor's log is read only once the turn
 * settles. The file is copied for that read only if it has not changed since
 * the read completed (`tool_call.completedAtMs`, else `startedAtMs`, else the
 * event's `timestamp_ms`), so a path read twice gives at most its last read
 * the image.
 */
function cursor(event: RecordValue, viewed: Viewed): RecordValue {
  if (event.type !== "tool_call" || event.subtype !== "completed") return event;
  const { key, body } = cursorToolCall(event);
  if (key !== "readToolCall" || !isRecord(body.result) || !isRecord(body.result.success)) return event;
  const path = string(body.result.success.path) ?? string(record(body.args).path);
  const timing = record(event.tool_call);
  const readAt = milliseconds(timing.completedAtMs) ?? milliseconds(timing.startedAtMs) ?? milliseconds(event.timestamp_ms);
  if (path && IMAGE_FILE.test(path)) viewed(path, string(event.call_id), `read ${path}`, readAt);
  return event;
}

/**
 * opencode's `read` returns an image as a tool attachment, `{type: "file",
 * mime, url: "data:<mime>;base64,…"}`, on the completed tool part's state.
 * Established from opencode's shipped bundle; no captured transcript yet.
 */
function opencode(event: RecordValue, inline: Inline): RecordValue {
  if (event.type !== "tool_use" || !isRecord(event.part) || !isRecord(event.part.state)) return event;
  const part = event.part;
  const state = event.part.state;
  if (!Array.isArray(state.attachments)) return event;
  const callId = string(part.callID);
  const path = string(record(state.input).filePath);
  const label = [string(part.tool) ?? "tool", path].filter(Boolean).join(" ");
  const attachments = state.attachments.map((attachment: unknown) => {
    if (!isRecord(attachment) || typeof attachment.url !== "string") return attachment;
    const match = /^data:(image\/[a-z]+);base64,/.exec(attachment.url);
    if (!match) return attachment;
    return inline(attachment.url.slice(match[0].length), match[1], callId, label, path ?? string(attachment.filename));
  });
  return { ...event, part: { ...part, state: { ...state, attachments } } };
}
