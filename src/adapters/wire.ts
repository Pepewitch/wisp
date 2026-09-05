import { isRecord } from "../validate";

export interface DecodedEventLine {
  text: string;
  /** null for plain text and malformed JSON. */
  event: Record<string, any> | null;
  /** Distinguishes malformed/unknown wire JSON from intentional plain text. */
  jsonLike: boolean;
}

export function decodeEventLine(line: string): DecodedEventLine | null {
  const text = line.trim();
  if (!text) return null;
  if (!text.startsWith("{")) return { text, event: null, jsonLike: false };
  try {
    const event = JSON.parse(text);
    return isRecord(event) ? { text, event, jsonLike: true } : { text, event: null, jsonLike: true };
  } catch {
    return { text, event: null, jsonLike: true };
  }
}

/**
 * Per-turn decoder with the one verified wire-level duplicate suppressed.
 * Raw logs stay untouched; both human and structured projections share this.
 */
export function createEventLineDecoder(
  dedupeDroidReasoning = false,
): (line: string) => DecodedEventLine | null {
  let previousDroidReasoning: string | null = null;
  return (line) => {
    const decoded = decodeEventLine(line);
    if (!decoded) return null;
    const droidReasoning =
      dedupeDroidReasoning && decoded.event?.type === "reasoning" && typeof decoded.event.id === "string"
        ? decoded.text
        : null;
    if (droidReasoning !== null) {
      if (droidReasoning === previousDroidReasoning) return null;
      previousDroidReasoning = droidReasoning;
    } else {
      previousDroidReasoning = null;
    }
    return decoded;
  };
}

export function cursorToolCall(event: Record<string, any>): {
  key: string | null;
  name: string;
  body: Record<string, any>;
  input: unknown;
} {
  const payload = isRecord(event.tool_call) ? event.tool_call : {};
  const keys = Object.keys(payload);
  const key = keys.find((candidate) => candidate.endsWith("ToolCall")) ?? keys[0] ?? null;
  const value = key ? payload[key] : payload;
  const body = isRecord(value) ? value : {};
  return {
    key,
    name: key ? key.replace(/ToolCall$/, "") : "tool",
    body,
    input: body.args ?? body.input ?? value,
  };
}
