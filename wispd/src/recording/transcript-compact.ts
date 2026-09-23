import type { AdapterDef } from "../adapters";

/**
 * What the primary transcript keeps of one parsed event: the event itself
 * (unchanged), a smaller copy, or `null` for nothing at all. The diagnostic
 * archive and the outcome reducer always see the event as it arrived; only
 * the budgeted primary transcript, and the live broker that mirrors it, see
 * the compacted form.
 *
 * A compactor may drop only what no reader of the primary transcript uses.
 */
type TranscriptCompactor = (event: Record<string, unknown>) => Record<string, unknown> | null;

/**
 * claude-code ships every thinking block with an EMPTY `thinking` string and
 * a ~9 KB encrypted `signature` (8,374 of 8,640 blocks in real logs,
 * 2026-09-23). Nothing in wisp reads the signature, and the block without it
 * still renders the thinking row that shows the agent is alive. A block that
 * does carry text keeps its signature untouched.
 *
 * `system`/`thinking_tokens` is a running token estimate emitted many times a
 * turn. No claude formatter, activity projection, or context tracker reads it.
 */
function compactClaude(event: Record<string, unknown>): Record<string, unknown> | null {
  if (event.type === "system" && event.subtype === "thinking_tokens") return null;
  if (event.type !== "assistant") return event;
  const message = event.message;
  if (!message || typeof message !== "object" || Array.isArray(message)) return event;
  const content = (message as Record<string, unknown>).content;
  if (!Array.isArray(content)) return event;
  let changed = false;
  const compacted = content.map((block: unknown) => {
    if (!block || typeof block !== "object" || Array.isArray(block)) return block;
    const { signature, ...rest } = block as Record<string, unknown>;
    if (rest.type !== "thinking" || signature === undefined) return block;
    if (typeof rest.thinking === "string" && rest.thinking.trim()) return block;
    changed = true;
    return rest;
  });
  return changed ? { ...event, message: { ...(message as Record<string, unknown>), content: compacted } } : event;
}

const COMPACTORS: Record<string, TranscriptCompactor> = {
  "claude-stream-json": compactClaude,
};

export function transcriptCompactor(def: AdapterDef): TranscriptCompactor | null {
  return def.events ? COMPACTORS[def.events] ?? null : null;
}
