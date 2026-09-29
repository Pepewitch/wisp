import { cleanupSummary } from "../archive-progress";
import { formatUsage, isCompactPrompt, type AdapterDef, type UsageSummary } from "../adapters";
import { parseAttachmentManifest, type AttachmentRecord } from "../attachments";
import { turnCaptureState, turnDiagnosticState, type ApiTask, type Task, type TaskMessage, type Turn } from "../types";
import { logFailure } from "../failure-log";
import { safeString } from "../text";
import { typeName } from "../validate";
import { backgroundWork, BACKGROUND_SETTLE_MS } from "../task-processes";
import { turnInput } from "../live-input";

/**
 * SQLite stores archived as 0/1; the public API exposes a boolean (a prior audit).
 *
 * This is the one caller that passes a settle window: the badge is the only
 * consumer a straggler misleads. Everything that deletes, archives or signals
 * calls `backgroundWork` bare and still sees every row.
 */
export function apiTask(t: Task): ApiTask {
  const { brief_enabled, brief_generation: _generation, input_seq: _seq, input_rev: _rev, ...row } = t;
  return { ...row, archived: t.archived !== 0, fast: t.fast !== 0, briefEnabled: brief_enabled === 1, attachmentsRetained: !t.archived || Boolean(t.archive_assets_retained), deletionPending: Boolean(t.purge_pending), background: backgroundWork(t.id, BACKGROUND_SETTLE_MS), turn_input: t.archived ? null : turnInput(t.id), ...(t.archived ? { cleanup: cleanupSummary(t.id) } : {}) };
}

export type ApiTaskMessage = Omit<
  TaskMessage,
  "attachments_json" | "claim" | "claim_turn_n" | "attachment_hash" | "delivery_uncertain" | "deferred" | "fast" | "origin" | "source_seq"
> & {
  attachments: AttachmentRecord[];
  delivery_uncertain: boolean;
  deferred: boolean;
  fast: boolean;
};

export function apiTaskMessage(message: TaskMessage): ApiTaskMessage {
  const {
    attachments_json,
    claim: _claim,
    claim_turn_n: _claimTurn,
    attachment_hash: _attachmentHash,
    delivery_uncertain,
    deferred,
    fast,
    origin: _origin,
    source_seq: _sourceSeq,
    ...rest
  } = message;
  return {
    ...rest,
    delivery_uncertain: delivery_uncertain !== 0,
    deferred: deferred === 1,
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

/**
 * The serialized body of each response `json()` built. `finishResponse` reads
 * it to compress without draining the response's stream back into memory.
 */
const jsonBodies = new WeakMap<Response, string>();

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  const text = JSON.stringify(data);
  const response = new Response(text, {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
  if (typeof text === "string") jsonBodies.set(response, text);
  return response;
}

/**
 * Headers every daemon response carries, whichever route built it: API JSON,
 * the event and log streams, the diagnostic download and errors included.
 * `nosniff` stops a browser reading a body as anything but its declared type,
 * and `same-origin` stops another site embedding one (`<script src>`, `<img>`).
 * Neither affects the app: it reads the API with `fetch`, which CORP does not
 * govern, and Desktop's proxy answers its webview with its own CORS headers.
 */
export const BASELINE_RESPONSE_HEADERS: Readonly<Record<string, string>> = {
  "x-content-type-options": "nosniff",
  "cross-origin-resource-policy": "same-origin",
};

/**
 * JSON at least this long is gzipped for a client that accepts it. Smaller
 * bodies are most responses, and would gain a few hundred bytes at best.
 */
export const JSON_GZIP_MIN_CHARS = 8 * 1024;

/** Prefer the supported gzip representation only when the client accepts it. */
export function acceptsGzip(header: string | null): boolean {
  if (!header) return false;
  const qualities = new Map<string, number>();
  for (const entry of header.split(",")) {
    const [coding, ...parameters] = entry.split(";");
    const name = coding?.trim().toLowerCase();
    if (!name) continue;
    let quality = 1;
    for (const parameter of parameters) {
      const match = parameter.trim().match(/^q\s*=\s*(.*)$/i);
      if (!match) continue;
      const parsed = Number(match[1]);
      quality = Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : 0;
    }
    qualities.set(name, quality);
  }
  return (qualities.get("gzip") ?? qualities.get("*") ?? 0) > 0;
}

/**
 * Every response on its way out of the daemon: the baseline headers, and gzip
 * for a large `json()` body when the request accepts it.
 *
 * Only `json()` bodies are compressed. Their bytes are one string in memory
 * already. An SSE or ndjson stream must reach the client as it is produced,
 * the page and its chunks are compressed once at startup, and attachments
 * are served as stored. A route's own header wins over a baseline one.
 */
export function finishResponse(req: Request, response: Response): Response {
  let finished = response;
  const text = jsonBodies.get(response);
  if (text !== undefined && text.length >= JSON_GZIP_MIN_CHARS && !response.headers.has("content-encoding")) {
    const headers = new Headers(response.headers);
    // Either representation may be served for this URL, so a cache must key on it.
    headers.append("vary", "Accept-Encoding");
    const gzip = req.method !== "HEAD" && acceptsGzip(req.headers.get("accept-encoding"));
    if (gzip) {
      headers.set("content-encoding", "gzip");
      headers.delete("content-length");
    }
    finished = new Response(gzip ? Bun.gzipSync(text, { level: 5 }) : text, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
  const missing = Object.entries(BASELINE_RESPONSE_HEADERS).filter(([name]) => !finished.headers.has(name));
  if (missing.length === 0) return finished;
  try {
    for (const [name, value] of missing) finished.headers.set(name, value);
    return finished;
  } catch {
    // A response with immutable headers (Response.redirect, a relayed fetch):
    // copy it rather than send it without them.
    const headers = new Headers(finished.headers);
    for (const [name, value] of missing) headers.set(name, value);
    return new Response(finished.body, { status: finished.status, statusText: finished.statusText, headers });
  }
}

export function err(message: string, status: number): Response {
  return json({ error: message }, status);
}

/**
 * The 500 for a route that threw. The client gets the message, as before; the
 * daemon log gets the method, the path and the stack, which are what tie a
 * 500 to its cause. It used to get nothing. Only the path is logged: a query
 * string can carry what the caller searched for, and the body and headers
 * (the bearer token among them) are never touched here. The path itself is
 * not always free of user text: attachment and suffix-prompt routes carry
 * their names in it, so those names can appear in the daemon log. A route
 * failing on every poll is summarized rather than logged each time.
 */
export function routeFailure(method: string, path: string, error: unknown): Response {
  logFailure(`${method} ${path} failed`, error);
  return err(error instanceof Error ? error.message : safeString(error), 500);
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
