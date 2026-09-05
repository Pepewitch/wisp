import type { AdapterDef, ParsedTurn, ParseStrategy } from "./types";

/**
 * Named parse strategies (ROADMAP guardrail 3, same shape as EVENT_FORMATTERS):
 * for a harness whose machine output the declarative field mapping cannot
 * describe. Keyed by `parse.strategy`; all harness wire knowledge stays here.
 */
export const PARSE_STRATEGIES: Record<string, ParseStrategy> = {
  /**
   * `codex exec --json` (verified live against codex-cli 0.149.0, fixtures in
   * tests/fixtures/codex-*.jsonl):
   *   {"type":"thread.started","thread_id":"01a0…"}                    ← session
   *   {"type":"item.completed","item":{"type":"agent_message","text":"papaya"}}
   *   {"type":"turn.completed","usage":{…}}                            ← no result
   * Three things break the field mapping: the session id and the result text
   * arrive on different events, the text is nested, and the terminal event
   * carries no result. The turn's result is the LAST agent_message (the same
   * text `codex exec -o <file>` writes) — a field mapping would happily take a
   * reasoning or command_execution item's text instead.
   */
  "codex-jsonl": (raw) => {
    let result: string | null = null;
    let session: string | null = null;
    let model: string | null = null;
    let failed = false;
    let usage: unknown | null = null;
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t.startsWith("{")) continue;
      let e: Record<string, any>;
      try {
        e = JSON.parse(t);
      } catch {
        continue; // partial line (crash mid-write) or noise
      }
      switch (e.type) {
        case "thread.started":
          if (typeof e.thread_id === "string") session ??= e.thread_id;
          // thread.started carries no model field (verified on codex-cli
          // 0.149.0 fixtures AND upstream exec_events.rs on main) — read one
          // anyway so a future codex that adds it lights up without a wisp
          // change; until then codex turns report no model and the surfaces
          // fall back to the requested one, marked "(requested)".
          if (typeof e.model === "string") model ??= e.model;
          break;
        case "turn.started":
          failed = false;
          break;
        case "turn.failed":
          failed = true;
          if (e.usage !== undefined && e.usage !== null) usage = e.usage;
          break;
        case "item.completed":
          if (e.item?.type === "agent_message" && typeof e.item.text === "string") result = e.item.text;
          break;
        // turn.completed carries the turn's usage blob (Theme B); a failed
        // turn that still emitted one keeps its usage — the tokens were spent
        case "turn.completed":
          if (e.usage !== undefined && e.usage !== null) usage = e.usage;
          break;
      }
    }
    // The agent often speaks before a turn dies (observed: a chatty message,
    // then turn.failed on a bad model). That message is not a positive result
    // signal, so drop it and let the runner fail the turn loudly (H3); the
    // error text stays readable in `wisp log` via the codex event formatter.
    // codex's exec stream announces no skill list — skills come from the
    // app-server's skills/list (A4), not from the turn parse.
    return { result: failed ? null : result, session, needsInput: false, isError: failed, model, usage, skills: null };
  },
  /**
   * cursor-agent's stream-json is claude's protocol in shape but NOT in
   * `result` semantics: where claude's result event carries the final
   * assistant message, cursor's carries EVERY assistant text of the turn
   * concatenated with no separator. Byte-verified on 2026.08.31 against
   * cursor-agent 2026.08.31 (a 6-message turn: result.length 1668 ===
   * 147+173+145+163+92+948, the exact sum of the assistant texts) and pinned
   * by tests/fixtures/cursor-accumulated-result.jsonl, whose result is
   * "I'll run that echo command now.done" — the two assistant texts fused.
   *
   * So the conclusion is DERIVED from the assistant events — the last one's
   * text (its parts joined the way the event formatter joins them) — and the
   * result event is only the settlement signal plus the session/usage
   * carrier. A turn whose model said nothing falls back to the raw result
   * field; a turn with no result event at all (interrupt, crash) yields null
   * so the runner's missing-result honesty check still fires. The fallback
   * ordering mirrors the generic json path: the result line first, early
   * stream events for what it does not carry (cursor's result has session_id
   * and usage but no model — that lives on the init event).
   */
  "cursor-stream-json": (raw) => {
    const lines = raw.split("\n");
    let resultEvent: Record<string, unknown> | null = null;
    let lastAssistantText: string | null = null;
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith("{")) continue;
      let e: Record<string, any>;
      try {
        e = JSON.parse(t);
      } catch {
        continue; // partial line (crash mid-write) or noise
      }
      if (e.type === "result") resultEvent = e;
      if (e.type === "assistant") {
        const texts = (e.message?.content ?? [])
          .filter((c: any) => c?.type === "text" && typeof c.text === "string" && c.text.trim())
          .map((c: any) => c.text.trim());
        if (texts.length) lastAssistantText = texts.join("\n");
      }
    }
    if (!resultEvent) {
      // no result line: interrupted / crashed mid-turn. Salvage the session
      // and model from early events so the session can be resumed — the same
      // contract the generic json path has.
      return {
        result: null,
        session: earlyField(lines, "session_id"),
        needsInput: false,
        isError: true,
        model: earlyField(lines, "model"),
        usage: null,
        skills: null,
      };
    }
    const rawResult = resultEvent.result;
    const fallback = typeof rawResult === "string" && rawResult ? rawResult : null;
    const rawUsage = resultEvent.usage;
    return {
      result: lastAssistantText ?? fallback,
      session: typeof resultEvent.session_id === "string" ? resultEvent.session_id : earlyField(lines, "session_id"),
      needsInput: false,
      isError: resultEvent.is_error === true,
      model: earlyField(lines, "model"),
      usage: typeof rawUsage === "object" && rawUsage !== null ? rawUsage : null,
      skills: null,
    };
  },
};

/**
 * First string value of `field` on an early stream event. Init/start lines
 * lead the stream and are where harnesses announce the session id and the
 * model in use; bounded to the head of the log, which can be megabytes.
 */
function earlyField(lines: string[], field: string): string | null {
  for (const line of lines.slice(0, 10)) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      const v = (JSON.parse(t) as Record<string, unknown>)[field];
      if (typeof v === "string") return v;
    } catch {
      /* not json */
    }
  }
  return null;
}

/**
 * First array-of-strings value of `field` on an early stream event — A4:
 * claude's init event carries the session's skill list (`skills:[…]`, names
 * only; SP2). null when no early event carries it, so "no field" and "no
 * skills" never collapse into one claim.
 */
function earlyStringArray(lines: string[], field: string): string[] | null {
  for (const line of lines.slice(0, 10)) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      const v = (JSON.parse(t) as Record<string, unknown>)[field];
      if (Array.isArray(v) && v.every((s) => typeof s === "string")) return v as string[];
    } catch {
      /* not json */
    }
  }
  return null;
}

/** Parse a turn's captured stdout per the adapter's declared format. */
export function parseOutput(def: AdapterDef, raw: string): ParsedTurn {
  if (def.parse.strategy) {
    const strategy = PARSE_STRATEGIES[def.parse.strategy];
    // unreachable via config (validateParse rejects unknown names at load), so
    // this only fires on a def built in code — loud beats an empty parse that
    // would masquerade as "the harness emitted no result"
    if (!strategy) {
      const known = Object.keys(PARSE_STRATEGIES).join(", ");
      throw new Error(`adapter parse.strategy '${def.parse.strategy}' is not a known strategy (known: ${known})`);
    }
    return strategy(raw);
  }
  if (def.parse.format === "text") {
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
  // json: the result object is the last parseable JSON line (matching
  // parse.resultType when set — stream-json harnesses emit many event lines)
  const lines = raw.trim().split("\n");
  // the model is announced on an early init/start event (claude/droid), not
  // the result event — capture it even when the turn dies before any result
  const earlyModel = def.parse.model ? earlyField(lines, def.parse.model) : null;
  // so is the session's skill list (A4, claude's init; SP2)
  const skills = def.parse.skills ? earlyStringArray(lines, def.parse.skills) : null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line.startsWith("{")) continue;
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      if (def.parse.resultType && obj.type !== def.parse.resultType) continue;
      const rawResult = def.parse.result ? obj[def.parse.result] : null;
      const result =
        typeof rawResult === "string" ? rawResult : rawResult != null ? JSON.stringify(rawResult) : null;
      const rawSession = def.parse.session ? obj[def.parse.session] : null;
      const session = typeof rawSession === "string" ? rawSession : null;
      const ni = def.parse.needsInput
        ? Array.isArray(obj[def.parse.needsInput]) && (obj[def.parse.needsInput] as unknown[]).length > 0
        : false;
      // a harness that puts the model on its result event instead is covered too
      const rawModel = def.parse.model ? obj[def.parse.model] : null;
      const model = typeof rawModel === "string" ? rawModel : earlyModel;
      // usage rides the SAME result line (claude result, droid completion);
      // only an object is a blob — a scalar would be a shape nobody declared
      const rawUsage = def.parse.usage ? obj[def.parse.usage] : null;
      const usage = typeof rawUsage === "object" && rawUsage !== null ? rawUsage : null;
      return {
        result,
        session,
        needsInput: ni,
        isError: obj.isError === true || obj.is_error === true,
        model,
        usage,
        skills,
      };
    } catch {
      // not the result line; keep scanning upward
    }
  }
  // no result line (interrupted / crashed mid-turn): still salvage the session
  // id from early stream events so the session can be resumed.
  const session = def.parse.session ? earlyField(lines, def.parse.session) : null;
  return { result: null, session, needsInput: false, isError: false, model: earlyModel, usage: null, skills };
}
