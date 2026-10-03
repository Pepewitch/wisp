import { decodeOutputImage, publishOutputImage } from "../outputs";
import type { AdapterDef } from "./types";

type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue => Boolean(value && typeof value === "object" && !Array.isArray(value));

/**
 * Only wire shapes captured with the synthetic MCP probe belong here. Unknown
 * harness payloads are left alone; every harness can explicitly publish files.
 * Replace binary blocks before transcript bounding, retaining adjacent text.
 */
export function externalizeOutputImages(event: RecordValue, def: AdapterDef, turnId: number, note: (text: string) => void): RecordValue {
  const image = (data: unknown, declaredType: unknown): RecordValue => {
    try {
      const extension = declaredType === "image/jpeg" ? "jpg" : declaredType === "image/gif" ? "gif" : declaredType === "image/webp" ? "webp" : "png";
      const saved = publishOutputImage(turnId, decodeOutputImage(data), `image.${extension}`, "native");
      const text = `Image output: ${saved.name} (${saved.size} bytes; ${saved.id})`;
      note(`· ${text}`);
      return { type: "text", text };
    } catch (error) {
      const text = `Image output unavailable: ${error instanceof Error ? error.message : String(error)}`;
      note(`· ${text}`);
      return { type: "text", text };
    }
  };
  if (def.events === "codex-jsonl" && event.type === "item.completed" && record(event.item) &&
      event.item.type === "mcp_tool_call" && record(event.item.result) && Array.isArray(event.item.result.content)) {
    const content = event.item.result.content.map((block: unknown) => record(block) && block.type === "image"
      ? image(block.data, block.mimeType) : block);
    return { ...event, item: { ...event.item, result: { ...event.item.result, content } } };
  }
  if (def.events === "claude-stream-json" && event.type === "user" && record(event.message) && Array.isArray(event.message.content)) {
    const content = event.message.content.map((block: unknown) => {
      if (!record(block) || block.type !== "tool_result" || !Array.isArray(block.content)) return block;
      return { ...block, content: block.content.map((part: unknown) => record(part) && part.type === "image" && record(part.source) && part.source.type === "base64"
        ? image(part.source.data, part.source.media_type) : part) };
    });
    return { ...event, message: { ...event.message, content } };
  }
  return event;
}
