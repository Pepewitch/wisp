import type { AdapterDef, UsageSummary } from "./types";

/**
 * Named usage formatters (ROADMAP guardrail 3, same shape as PARSE_STRATEGIES
 * and EVENT_FORMATTERS): how one harness's raw usage blob becomes a
 * UsageSummary. All harness usage-shape knowledge lives HERE — the API, the
 * CLI and the web app only ever see the normalized summary.
 *
 * The discipline a normalizer keeps: it COPIES numeric fields under normalized
 * names and nothing more. No summing (a "total" is a judgment the renderer
 * owns), no currency (emit-only — prices rot), no invented zeros. A field that
 * did not arrive as a finite number is simply absent, and a blob with no
 * readable numbers at all normalizes to null: absence said out loud, not an
 * empty object that reads as "zero tokens".
 */
function num(blob: Record<string, unknown>, key: string): number | undefined {
  const v = blob[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function summary(fields: UsageSummary): UsageSummary | null {
  return Object.values(fields).some((v) => v !== undefined) ? fields : null;
}

export const USAGE_FORMATTERS: Record<string, (blob: unknown) => UsageSummary | null> = {
  /**
   * claude's result event and droid's completion event carry the same
   * snake_case token shape (verified against real turn logs 2026-08-31:
   * claude `usage{input_tokens, cache_creation_input_tokens,
   * cache_read_input_tokens, output_tokens, …}`, droid `usage{input_tokens,
   * output_tokens, cache_read_input_tokens, cache_creation_input_tokens,
   * factory_credits, ttft_ms}`). Cursor speaks the same shape with one
   * shorter key (`cache_read_tokens`, bundle-verified 2026.08.11). Money
   * fields (`total_cost_usd`, `factory_credits`) are deliberately NOT
   * copied — see the module comment.
   */
  "snake-tokens": (blob) => {
    if (typeof blob !== "object" || blob === null) return null;
    const b = blob as Record<string, unknown>;
    return summary({
      // cursor drifted to camelCase in 2026.08.25 (08.11 was snake_case) —
      // both spellings are accepted, newest first is NOT assumed: each key
      // falls back to its other spelling, so either wire normalizes fully
      inputTokens: num(b, "input_tokens") ?? num(b, "inputTokens"),
      outputTokens: num(b, "output_tokens") ?? num(b, "outputTokens"),
      // cursor's snake wire name is cache_read_tokens (bundle-verified
      // 2026-08-11); 08.25's camelCase is cacheReadTokens (captured live —
      // NOT "cachedInputTokens", that's wisp's normalized name, not the wire's)
      cachedInputTokens:
        num(b, "cache_read_input_tokens") ?? num(b, "cache_read_tokens") ?? num(b, "cacheReadTokens"),
      cacheWriteTokens: num(b, "cache_creation_input_tokens") ?? num(b, "cacheWriteTokens"),
    });
  },
  /**
   * codex's `turn.completed` event: `usage{input_tokens, cached_input_tokens,
   * cache_write_input_tokens, output_tokens, reasoning_output_tokens}`
   * (captured fixture tests/fixtures/codex-first-turn.jsonl). The cache field
   * names differ from claude/droid's and reasoning is split from visible
   * output — both are copied, neither is renamed into a shape it is not.
   */
  "codex-usage": (blob) => {
    if (typeof blob !== "object" || blob === null) return null;
    const b = blob as Record<string, unknown>;
    return summary({
      inputTokens: num(b, "input_tokens"),
      outputTokens: num(b, "output_tokens"),
      cachedInputTokens: num(b, "cached_input_tokens"),
      cacheWriteTokens: num(b, "cache_write_input_tokens"),
      reasoningTokens: num(b, "reasoning_output_tokens"),
    });
  },
};

/**
 * Normalize one turn's raw usage blob per the adapter's declared `usageFormat`.
 * null in, null out; a def with no usageFormat serves null (the honest "this
 * harness reports nothing wisp can read"). An unknown strategy name throws —
 * validate.ts rejects them at load, so this only fires on a def built in code,
 * where loud beats an empty parse masquerading as "no usage reported".
 */
export function formatUsage(def: AdapterDef, blob: unknown): UsageSummary | null {
  if (blob === null || blob === undefined) return null;
  if (!def.usageFormat) return null;
  const formatter = USAGE_FORMATTERS[def.usageFormat];
  if (!formatter) {
    const known = Object.keys(USAGE_FORMATTERS).join(", ");
    throw new Error(`adapter usageFormat '${def.usageFormat}' is not a known formatter (known: ${known})`);
  }
  return formatter(blob);
}
