import { cleanupSummary } from "../archive-progress";
import { formatUsage, isCompactPrompt, type AdapterDef, type UsageSummary } from "../adapters";
import { parseAttachmentManifest, type AttachmentRecord } from "../attachments";
import { turnCaptureState, turnDiagnosticState, type ApiTask, type Task, type TaskMessage, type Turn } from "../types";
import { errorDetail } from "../text";
import { typeName } from "../validate";
import { backgroundWork, BACKGROUND_SETTLE_MS } from "../task-processes";

/**
 * SQLite stores archived as 0/1; the public API exposes a boolean (a prior audit).
 *
 * This is the one caller that passes a settle window: the badge is the only
 * consumer a straggler misleads. Everything that deletes, archives or signals
 * calls `backgroundWork` bare and still sees every row.
 */
export function apiTask(t: Task): ApiTask {
  const { brief_enabled, brief_generation: _generation, input_seq: _seq, input_rev: _rev, ...row } = t;
  return { ...row, archived: t.archived !== 0, fast: t.fast !== 0, briefEnabled: brief_enabled === 1, attachmentsRetained: !t.archived || Boolean(t.archive_assets_retained), deletionPending: Boolean(t.purge_pending), background: backgroundWork(t.id, BACKGROUND_SETTLE_MS), ...(t.archived ? { cleanup: cleanupSummary(t.id) } : {}) };
}

export type ApiTaskMessage = Omit<
  TaskMessage,
  "attachments_json" | "claim" | "claim_turn_n" | "attachment_hash" | "delivery_uncertain" | "fast" | "origin" | "source_seq"
> & {
  attachments: AttachmentRecord[];
  delivery_uncertain: boolean;
  fast: boolean;
};

export function apiTaskMessage(message: TaskMessage): ApiTaskMessage {
  const {
    attachments_json,
    claim: _claim,
    claim_turn_n: _claimTurn,
    attachment_hash: _attachmentHash,
    delivery_uncertain,
    fast,
    origin: _origin,
    source_seq: _sourceSeq,
    ...rest
  } = message;
  return {
    ...rest,
    delivery_uncertain: delivery_uncertain !== 0,
    fast: fast !== 0,
    attachments: parseAttachmentManifest(attachments_json),
  };
}

/**
 * A turn as the API serves it: the internal columns parsed, never relayed raw —
 * `attachments_json` becomes `attachments` (A1a) and `usage_json` becomes
 * `usage`, normalized through the harness's own `usageFormat` strategy (Theme
 * B). A client never sees either column: they are internal encodings, and a
 * client that parsed them would be coupled to them. `def` is the task's
 * adapter; undefined (a harness the daemon no longer knows) serves usage null
 * rather than guessing at a shape.
 */
export type ApiTurn = Omit<
  Turn,
  "attachments_json" | "usage_json" | "outcome_json" | "capture_categories_json" | "requested_fast"
> & {
  /** Adapter-declared lifecycle the client can present without parsing private harness logs. */
  operation?: "compact";
  attachments: AttachmentRecord[];
  usage: UsageSummary | null;
  capture_categories: Record<string, { records: number; bytes: number }> | null;
  /** Fast mode as requested for this turn, a boolean like the task's. */
  requested_fast: boolean;
};

/** Parse and normalize one stored usage blob without exposing its storage shape. */
export function apiTurnUsage(usageJson: string | null, def?: AdapterDef): UsageSummary | null {
  let rawUsage: unknown = null;
  if (usageJson !== null) {
    try {
      rawUsage = JSON.parse(usageJson);
    } catch {
      rawUsage = null; // a corrupt blob is no usage report, not a 500
    }
  }
  return def ? formatUsage(def, rawUsage) : null;
}

export function apiTurn(t: Turn, def?: AdapterDef): ApiTurn {
  const {
    attachments_json,
    usage_json,
    outcome_json: _outcome,
    capture_categories_json,
    requested_fast,
    ...rest
  } = t;
  let captureCategories: Record<string, { records: number; bytes: number }> | null = null;
  if (capture_categories_json !== null) {
    try {
      const parsed: unknown = JSON.parse(capture_categories_json);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        captureCategories = parsed as Record<string, { records: number; bytes: number }>;
      }
    } catch {
      captureCategories = null;
    }
  }
  return {
    ...rest,
    ...(isCompactPrompt(def, t.prompt) ? { operation: "compact" as const } : {}),
    capture_state: turnCaptureState(t),
    diagnostic_state: turnDiagnosticState(t),
    attachments: parseAttachmentManifest(attachments_json),
    usage: apiTurnUsage(usage_json, def),
    capture_categories: captureCategories,
    requested_fast: requested_fast !== 0,
  };
}

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export function err(message: string, status: number): Response {
  return json({ error: message }, status);
}

/**
 * The 500 for a route that threw. The client gets the message, as before; the
 * daemon log gets the method, the path and the stack, which are what tie a
 * 500 to its cause. It used to get nothing. Only the path is logged: a query
 * string can carry what the caller searched for, and the body and headers
 * (the bearer token among them) are never touched here.
 */
export function routeFailure(method: string, path: string, error: unknown): Response {
  console.error(`[wisp] ${method} ${path} failed: ${errorDetail(error)}`);
  return err(error instanceof Error ? error.message : String(error), 500);
}

/**
 * A request body, as the object every mutating route expects.
 *
 * The old pattern was `(await req.json().catch(() => ({}))) as { … }`, which
 * has a hole a review found: `null`, `[]`, `7`, and `"text"` are all valid
 * JSON, so the `catch` never fires and the very next line dereferences a
 * non-object. `POST /api/tasks/:id/send` was worse — a bare `await req.json()`
 * with no catch at all, so a malformed body became a 500 carrying a parser
 * message.
 *
 * Three answers, deliberately distinct:
 *
 *   * an EMPTY body is `{}`. Callers legitimately send none — `POST …/archive`
 *     with no options is a request, not a mistake — and turning that into a
 *     400 would break the CLI.
 *   * unparseable bytes are a 400 that says so, rather than being silently
 *     treated as "no fields provided" and answered with a confusing complaint
 *     about a missing field.
 *   * valid JSON that is not an object is a 400 that names what arrived.
 *
 * A route uses it as `const body = await jsonObjectBody(req); if (body
 * instanceof Response) return body;` — the same shape as the other validators
 * here.
 */
export async function jsonObjectBody(req: Request): Promise<Record<string, unknown> | Response> {
  let text: string;
  try {
    text = await req.text();
  } catch (error) {
    return err(`could not read the request body: ${error instanceof Error ? error.message : String(error)}`, 400);
  }
  return jsonObjectText(text);
}

/** The three answers above, for a body already read as text. */
function jsonObjectText(text: string): Record<string, unknown> | Response {
  if (text.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return err(`request body is not valid JSON: ${error instanceof Error ? error.message : String(error)}`, 400);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return err(`request body must be a JSON object, got ${typeName(parsed)}`, 400);
  }
  return parsed as Record<string, unknown>;
}

/**
 * `jsonObjectBody` for a route with a small, fixed ceiling: a declared
 * `content-length` over it is refused before a byte is read, and an
 * undeclared or understated body is counted as it streams and cut off at the
 * limit, so an oversized request never becomes one big string in memory.
 */
export async function boundedJsonObjectBody(req: Request, maxBytes: number): Promise<Record<string, unknown> | Response> {
  const tooLarge = () => err(`request body is over the ${maxBytes}-byte limit`, 413);
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return tooLarge();
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (req.body) {
    const reader = req.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => {});
          return tooLarge();
        }
        chunks.push(value);
      }
    } catch (error) {
      return err(`could not read the request body: ${error instanceof Error ? error.message : String(error)}`, 400);
    }
  }
  return jsonObjectText(Buffer.concat(chunks).toString("utf8"));
}

export function integerQueryParam(url: URL, name: string, minimum: number): number | Response | null {
  const raw = url.searchParams.get(name);
  if (raw === null) return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum) {
    const range = minimum === 0 ? "a non-negative" : "a positive";
    return err(`${name} must be ${range} integer, got ${JSON.stringify(raw)}`, 400);
  }
  return value;
}
