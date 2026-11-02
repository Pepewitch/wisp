import { lstatSync, statSync } from "node:fs";
import { basename } from "node:path";
import { outputImageNote, type OutputImage, type OutputStep } from "../../../shared/api/outputs";
import { readViewedImage } from "../output-files";
import { decodeOutputImage, OutputError, outputStep, publishOutputImage } from "../outputs";
import { record, string } from "./activity-value";
import type { AdapterDef } from "./types";

type RecordValue = Record<string, unknown>;
const isRecord = (value: unknown): value is RecordValue => Boolean(value && typeof value === "object" && !Array.isArray(value));
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
 * It runs on a live turn's events as they arrive; Cursor and OpenCode write
 * their output straight to the log, which logged-images.ts reads (Cursor's
 * while the turn runs, since it reports only a path).
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
  const viewed = (path: string, callId: string | null, label: string, readAt?: number): void => {
    saved(() => {
      // copied after the fact (a followed log): a file written, renamed over or relinked since the read is not what the step saw
      if (readAt !== undefined && Number.isFinite(readAt) && changedSince(path, readAt)) {
        throw new OutputError("the image file changed after the step read it");
      }
      return publishOutputImage(turnId, readViewedImage(turnId, path), basename(path), "native", stepOf(callId, label));
    });
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

type Remember = (id: string | null, name: string | null, input: unknown) => void;
type Inline = (data: unknown, declaredType: unknown, callId: string | null, fallbackLabel: string, path?: string | null, source?: OutputImage["source"]) => RecordValue;
type Viewed = (path: string, callId: string | null, label: string, readAt?: number) => void;

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

/** The file, or the link that names it, changed (content, inode metadata, rename) after `at`. */
function changedSince(path: string, at: number): boolean {
  const target = statSync(path);
  return Math.max(target.mtimeMs, target.ctimeMs, lstatSync(path).ctimeMs) > at;
}

const IMAGE_PATH = /\.(png|jpe?g|gif|webp)$/i;

/**
 * Cursor (2026.10): a `tool_call` `completed` whose `readToolCall` succeeded
 * names only the path it read, so that file is copied now (the log is
 * followed while the turn runs; logged-images.ts). Only image paths: a text
 * file's read is not an image anyone looked at.
 */
function cursor(event: RecordValue, viewed: Viewed): RecordValue {
  if (event.type !== "tool_call" || event.subtype !== "completed" || !isRecord(event.tool_call)) return event;
  const read = event.tool_call.readToolCall;
  if (!isRecord(read) || !isRecord(read.result) || !isRecord(read.result.success)) return event;
  const path = string(read.result.success.path) ?? (isRecord(read.args) ? string(read.args.path) : null);
  // when the read finished: the file must not have been written after it
  const readAt = Number(event.tool_call.completedAtMs ?? event.timestamp_ms);
  if (path && IMAGE_PATH.test(path)) viewed(path, string(event.call_id), `Read ${path}`, Number.isFinite(readAt) ? readAt : undefined);
  return event;
}

/**
 * OpenCode (live-probed): a completed tool part carries what the tool showed
 * the model as `attachments`, an image as a `data:<mime>;base64,` URL. These
 * are the bytes the step saw, so reading them after the turn is exact.
 */
function opencode(event: RecordValue, inline: Inline): RecordValue {
  if (event.type !== "tool_use" || !isRecord(event.part) || !isRecord(event.part.state)) return event;
  const part = event.part;
  const state = part.state as Record<string, unknown>;
  if (state.status !== "completed" || !Array.isArray(state.attachments)) return event;
  const input = isRecord(state.input) ? state.input : {};
  const path = string(input.filePath) ?? string(input.path);
  const label = [string(part.tool) ?? "tool", path].filter(Boolean).join(" ");
  for (const attachment of state.attachments) {
    if (!isRecord(attachment) || typeof attachment.url !== "string") continue;
    const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,(.+)$/.exec(attachment.url);
    if (match) inline(match[2], match[1], string(part.callID), label, path);
  }
  return event;
}
