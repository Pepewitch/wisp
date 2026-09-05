import { isRecord } from "../validate";
import type { AdapterDef, ErrorStrategy } from "./types";

/** Iterate the parsed JSON events of a captured stdout stream. */
function* jsonEvents(raw: string): Generator<Record<string, any>> {
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      yield JSON.parse(t) as Record<string, any>;
    } catch {
      /* partial line (crash mid-write) or noise */
    }
  }
}

/**
 * codex wraps API error bodies as a JSON *string* inside its event messages
 * (see tests/fixtures/codex-failed-turn.jsonl); unwrap to the inner message.
 */
function unwrapNestedErrorMessage(message: string): string {
  try {
    const inner: unknown = JSON.parse(message);
    if (isRecord(inner)) {
      const m = isRecord(inner.error) ? inner.error.message : inner.message;
      if (typeof m === "string" && m.trim()) return m.trim();
    }
  } catch {
    /* plain text after all */
  }
  return message.trim();
}

export const ERROR_STRATEGIES: Record<string, ErrorStrategy> = {
  /**
   * claude stream-json (fixture: tests/fixtures/claude-unknown-model.jsonl,
   * claude-code 2.1.240): a failed turn's cause rides on the last
   * error-bearing stdout event — a `result` event flagged is_error (beware:
   * its subtype can still say "success" — real capture — so key on is_error,
   * and on the error_* subtypes older builds used), or an `assistant` event
   * the API flagged with an `error` code (model_not_found, rate_limit, …)
   * whose message text sits in the content. stderr only gets a terse log
   * line (e.g. "[claude-code:unrecognized_model] …").
   */
  "claude-stream-json": (out) => {
    let detail: string | null = null;
    for (const e of jsonEvents(out)) {
      if (
        e.type === "result" &&
        (e.is_error === true || (typeof e.subtype === "string" && e.subtype.startsWith("error"))) &&
        typeof e.result === "string" &&
        e.result.trim()
      ) {
        detail = e.result.trim();
      } else if (e.type === "assistant" && typeof e.error === "string") {
        const content: unknown[] = Array.isArray(e.message?.content) ? e.message.content : [];
        const text = content.find(
          (c: any) => c?.type === "text" && typeof c?.text === "string" && c.text.trim(),
        ) as { text: string } | undefined;
        detail = text ? text.text.trim() : (detail ?? e.error);
      }
    }
    return detail;
  },
  /**
   * `codex exec --json` (fixtures: tests/fixtures/codex-*.jsonl, codex-cli
   * 0.149.0): failures are reported on STDOUT — a terminal `turn.failed`
   * event (usually preceded by a same-text top-level `error` event) — while
   * stderr holds only noise ("Reading additional input from stdin...").
   * Mid-turn `item.completed` error items are warning-grade (e.g. "Model
   * metadata … not found. Defaulting to fallback…"), so they only fill in
   * when no terminal error event follows (crash between events).
   */
  "codex-jsonl": (out) => {
    let detail: string | null = null;
    for (const e of jsonEvents(out)) {
      if (e.type === "turn.failed" && typeof e.error?.message === "string" && e.error.message.trim()) {
        detail = unwrapNestedErrorMessage(e.error.message);
      } else if (e.type === "error" && typeof e.message === "string" && e.message.trim()) {
        detail = unwrapNestedErrorMessage(e.message);
      } else if (e.type === "item.completed" && e.item?.type === "error" && typeof e.item.message === "string") {
        detail ??= e.item.message.trim();
      }
    }
    return detail;
  },
  /**
   * droid stream-json (droid 0.202.0): mid-turn API failures surface as
   * `{"type":"error","message":…}` stdout events (droid's own stream-json
   * consumer collects exactly that shape — binary strings), and a terminal
   * completion may flag isError with the cause in finalText. PRE-FLIGHT
   * failures (unknown model, bad auth) never reach the stream: stdout stays
   * empty and stderr holds the cause on its FIRST line, followed by pages of
   * help text that drown it in a tail read (fixture:
   * tests/fixtures/droid-unknown-model.stderr.txt). A 2026-08-23 capture
   * (tests/fixtures/droid-transient-provider-error.jsonl) also shows droid
   * emitting a trailing `source:"cli"` error echoing in-flight text after the
   * substantive `source:"agent_loop"` error, so agent_loop errors take
   * priority while retaining last-wins within each source class.
   */
  "droid-stream-json": (out, err) => {
    let agentLoopDetail: string | null = null;
    let otherErrorDetail: string | null = null;
    let completionDetail: string | null = null;
    for (const e of jsonEvents(out)) {
      if (e.type === "error" && typeof e.message === "string" && e.message.trim()) {
        if (e.source === "agent_loop") {
          agentLoopDetail = e.message.trim();
        } else {
          otherErrorDetail = e.message.trim();
        }
      } else if (e.type === "completion" && e.isError === true && typeof e.finalText === "string" && e.finalText.trim()) {
        completionDetail = e.finalText.trim();
      }
    }
    const detail = agentLoopDetail ?? otherErrorDetail ?? completionDetail;
    if (detail) return detail;
    return err
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? null;
  },
};

/**
 * The failure cause of a finished-but-failed turn, best-effort: the adapter's
 * error strategy reads the harness's own error events first; the stderr tail
 * is the fallback for harnesses without a strategy and for outright crashes.
 */
export function errorDetail(def: AdapterDef, out: string, err: string): string | null {
  const strategy = def.errors ? ERROR_STRATEGIES[def.errors] : undefined;
  // unreachable via config (validateAdapter rejects unknown names at load), so
  // this only fires on a def built in code — loud beats silently reporting
  // "turn exited 1" for a typo'd strategy name
  if (def.errors && !strategy) {
    const known = Object.keys(ERROR_STRATEGIES).join(", ");
    throw new Error(`adapter errors strategy '${def.errors}' is not a known strategy (known: ${known})`);
  }
  const detail = strategy?.(out, err)?.trim();
  if (detail) return detail;
  const tail = err.trim().split("\n").filter(Boolean).slice(-3).join(" | ");
  return tail || null;
}

/** True when the extracted failure detail matches the adapter's declared limit/quota error shapes. */
export function isLimitError(def: AdapterDef, detail: string): boolean {
  const d = detail.toLowerCase();
  return (def.limitMarkers ?? []).some((m) => d.includes(m.toLowerCase()));
}

/** True when the extracted failure detail matches the adapter's declared transient provider/stream error shapes. */
export function isTransientError(def: AdapterDef, detail: string): boolean {
  const d = detail.toLowerCase();
  return (def.transientMarkers ?? []).some((m) => d.includes(m.toLowerCase()));
}
