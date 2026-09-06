import { foldIncrementalOutcome } from "./outcome";
import type { AdapterDef, ParsedTurn, ParseStrategy } from "./types";

const STRATEGY_DEFS: Record<string, AdapterDef> = {
  "codex-jsonl": { bin: "codex", exec: [], parse: { format: "json", strategy: "codex-jsonl" } },
  "cursor-stream-json": {
    bin: "cursor-agent",
    exec: [],
    parse: { format: "json", strategy: "cursor-stream-json" },
  },
};

/**
 * Named parse strategies remain the adapter-validation registry. Their legacy
 * whole-log entry points are folds over the same incremental reducers used by
 * recorder-owned turns, so recovery cannot drift into a second parser.
 */
export const PARSE_STRATEGIES: Record<string, ParseStrategy> = Object.fromEntries(
  Object.entries(STRATEGY_DEFS).map(([name, def]) => [
    name,
    (raw: string): ParsedTurn => foldIncrementalOutcome(def, raw, "", "legacy")!.outcome,
  ]),
);

/** Parse a turn's captured stdout per the adapter's declared format. */
export function parseOutput(def: AdapterDef, raw: string): ParsedTurn {
  if (def.parse.strategy && !PARSE_STRATEGIES[def.parse.strategy]) {
    const known = Object.keys(PARSE_STRATEGIES).join(", ");
    throw new Error(`adapter parse.strategy '${def.parse.strategy}' is not a known strategy (known: ${known})`);
  }

  const incremental = foldIncrementalOutcome(def, raw);
  if (incremental) return incremental.outcome;

  // Text adapters deliberately stay on the legacy path until they have an
  // explicit incremental settlement contract. Their bounded tail behavior is
  // unchanged by the recorder foundation.
  const tail = raw.trim();
  return {
    result: tail ? tail.slice(-2000) : null,
    session: null,
    needsInput: false,
    isError: false,
    model: null,
    usage: null,
    skills: null,
  };
}
