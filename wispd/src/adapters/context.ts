/**
 * Named context trackers (same shape as PARSE_STRATEGIES, USAGE_FORMATTERS and
 * COMPACT_STRATEGIES): how one harness's turn events reveal how much
 * conversation its model is currently carrying.
 *
 * The rule every tracker here implements is the same one, and it is the whole
 * idea: **the prompt of the harness's most recent model call IS the context**.
 * A turn's usage blob is the wrong number — it is billing, summed over every
 * call the turn made, so a long turn reports millions of cache reads against a
 * window of one. Measured on a real claude turn: the result blob summed
 * 5,768,726 cache reads while the session was carrying 467,964 tokens, which
 * that session's own compaction then confirmed as `pre_tokens: 468951`.
 *
 * A tracker is therefore a PURE FUNCTION OF ONE EVENT returning the point that
 * event reveals, or null for the events that reveal nothing. The reducer keeps
 * the last non-null answer, so trackers never accumulate, never see ordering,
 * and never need a reset. Plugging a new harness in is one function and one
 * `contextFormat` line on its adapter.
 *
 * What is deliberately NOT here: the context WINDOW. No harness states it in
 * the stream (checked on claude 2.1.273's init event, codex 0.154.0's
 * `codex exec --json`, opencode 1.18.31), and wisp does not keep a per-model
 * table of numbers that rot. A used-token count with no denominator is an
 * honest partial answer; an invented denominator is not. droid's
 * `get_context_breakdown` and codex's app-server `token_count` notification do
 * state one — when either is wired in, it is a field on ContextPoint, not a
 * change to this contract.
 */
import { isRecord } from "../validate";
import type { AdapterDef } from "./types";

/** What one event says about the conversation the model is carrying. */
export interface ContextPoint {
  /** Tokens in the prompt of the harness's most recent model call. */
  usedTokens: number;
}

/** null = this event says nothing about context; the previous answer stands. */
export type ContextTracker = (event: Record<string, unknown>) => ContextPoint | null;

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nested(value: unknown, key: string): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const inner = value[key];
  return isRecord(inner) ? inner : null;
}

/** A point is only a point if the harness reported something above zero. */
function point(usedTokens: number): ContextPoint | null {
  return usedTokens > 0 ? { usedTokens } : null;
}

export const CONTEXT_TRACKERS: Record<string, ContextTracker> = {
  /**
   * claude (verified against real turn logs, claude-code 2.1.269/2.1.273).
   * Every `assistant` event carries the API's own `message.usage` for the call
   * that produced it, and the three prompt fields are DISJOINT there, so the
   * prompt is their sum. The last one in a turn was 467,964 against the same
   * session's `compact_boundary.pre_tokens` of 468,951 — the ~1k gap is the
   * `/compact` command entry itself, appended after that call.
   *
   * Two guards, both load-bearing:
   *
   * - A subagent's messages ride the same stream under a non-null
   *   `parent_tool_use_id` and DO carry usage (118 such events across the
   *   logs checked, one with `input_tokens: 2`). A subagent carries its own
   *   context, not this session's, so the last event in a turn is regularly
   *   the wrong one to believe. Main-session messages set the field to null.
   * - `compact_boundary` is read for `post_tokens`, because a turn whose whole
   *   job was `/compact` makes no model call at all: its assistant events
   *   report zeros, and without this the header would keep showing the
   *   pre-compaction number until some later turn happened to correct it.
   *   The boundary precedes any post-compaction call, so last-wins still holds.
   */
  "claude-stream-json": (event) => {
    if (event.type === "system" && event.subtype === "compact_boundary") {
      const post = num(nested(event, "compact_metadata")?.post_tokens);
      return post === null ? null : point(post);
    }
    if (event.type !== "assistant" || event.parent_tool_use_id != null) return null;
    const usage = nested(nested(event, "message"), "usage");
    if (!usage) return null;
    return point(
      (num(usage.input_tokens) ?? 0) +
        (num(usage.cache_read_input_tokens) ?? 0) +
        (num(usage.cache_creation_input_tokens) ?? 0),
    );
  },

  /**
   * codex (verified against real turn logs, codex-cli 0.154.0). `turn.completed`
   * reports the FINAL call, not a sum: one task's consecutive turns read
   * 24,875 → 63,864 → 66,290 → 66,909 → 68,838 → 166,151, the last of those
   * across 157 tool calls. A summed blob could not be monotonic like that.
   *
   * `input_tokens` is used alone and `cached_input_tokens` is deliberately NOT
   * added: codex nests the cached count INSIDE input (166,151 total of which
   * 165,248 cached), the opposite of claude's disjoint fields. Adding them
   * would double-count the whole conversation.
   */
  "codex-jsonl": (event) => {
    if (event.type !== "turn.completed") return null;
    const used = num(nested(event, "usage")?.input_tokens);
    return used === null ? null : point(used);
  },

  /**
   * opencode (fixture-verified, 1.18.29+). The one harness that reports per
   * STEP rather than per turn — which for this purpose is the easy case, since
   * a step IS a model call. Its input/cache fields are disjoint like claude's,
   * and the steps grow across a turn (8,556 → 9,128 → 9,518 in the captured
   * tool turn), so last-wins lands on the final call with no special casing.
   */
  "opencode-json": (event) => {
    if (event.type !== "step_finish") return null;
    const tokens = nested(nested(event, "part"), "tokens");
    if (!tokens) return null;
    const cache = nested(tokens, "cache");
    return point((num(tokens.input) ?? 0) + (num(cache?.read) ?? 0) + (num(cache?.write) ?? 0));
  },
};

/**
 * Read one event through the adapter's declared tracker. No `contextFormat`
 * means the harness reveals no context wisp can read (droid reports usage only
 * on its terminal `completion` event and reports it SUMMED — 20,095,847 cache
 * reads over 261 tool calls; cursor does the same on its result event), and
 * the answer stays absent rather than becoming a wrong number.
 *
 * An unknown strategy name throws: validate.ts rejects them at load, so this
 * only fires for a def built in code, where loud beats a silently blank header.
 */
export function readContextPoint(def: AdapterDef, event: Record<string, unknown>): ContextPoint | null {
  if (!def.contextFormat) return null;
  const tracker = CONTEXT_TRACKERS[def.contextFormat];
  if (!tracker) {
    const known = Object.keys(CONTEXT_TRACKERS).join(", ");
    throw new Error(`adapter contextFormat '${def.contextFormat}' is not a known tracker (known: ${known})`);
  }
  return tracker(event);
}
