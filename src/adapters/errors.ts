import { foldIncrementalOutcome } from "./outcome";
import type { AdapterDef, ErrorStrategy } from "./types";

const ERROR_DEFS: Record<string, AdapterDef> = {
  "claude-stream-json": {
    bin: "claude",
    exec: [],
    parse: { format: "json", resultType: "result", result: "result" },
    errors: "claude-stream-json",
  },
  "codex-jsonl": {
    bin: "codex",
    exec: [],
    parse: { format: "json", strategy: "codex-jsonl" },
    errors: "codex-jsonl",
  },
  "droid-stream-json": {
    bin: "droid",
    exec: [],
    parse: { format: "json", resultType: "completion", result: "finalText" },
    errors: "droid-stream-json",
  },
};

/** Named error strategies, implemented as folds over the outcome reducers. */
export const ERROR_STRATEGIES: Record<string, ErrorStrategy> = Object.fromEntries(
  Object.entries(ERROR_DEFS).map(([name, def]) => [
    name,
    (out: string, err: string): string | null => foldIncrementalOutcome(def, out, err)!.errorDetail,
  ]),
);

/**
 * The failure cause of a finished-but-failed turn, best-effort: the adapter's
 * error strategy reads harness events first; the stderr tail is the fallback.
 */
export function errorDetail(def: AdapterDef, out: string, err: string): string | null {
  const strategy = def.errors ? ERROR_STRATEGIES[def.errors] : undefined;
  if (def.errors && !strategy) {
    const known = Object.keys(ERROR_STRATEGIES).join(", ");
    throw new Error(`adapter errors strategy '${def.errors}' is not a known strategy (known: ${known})`);
  }
  const detail = (foldIncrementalOutcome(def, out, err)?.errorDetail ?? strategy?.(out, err))?.trim();
  if (detail) return detail;
  const tail = err.trim().split("\n").filter(Boolean).slice(-3).join(" | ");
  return tail || null;
}

/** True when the extracted failure detail matches the adapter's declared limit/quota error shapes. */
export function isLimitError(def: AdapterDef, detail: string): boolean {
  const normalized = detail.toLowerCase();
  return (def.limitMarkers ?? []).some((marker) => normalized.includes(marker.toLowerCase()));
}

/** True when the extracted failure detail matches declared transient provider/stream error shapes. */
export function isTransientError(def: AdapterDef, detail: string): boolean {
  const normalized = detail.toLowerCase();
  return (def.transientMarkers ?? []).some((marker) => normalized.includes(marker.toLowerCase()));
}
