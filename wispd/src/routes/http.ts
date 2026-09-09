import { cleanupSummary } from "../archive-progress";
import { formatUsage, type AdapterDef, type UsageSummary } from "../adapters";
import { parseAttachmentManifest, type AttachmentRecord } from "../attachments";
import { turnCaptureState, turnDiagnosticState, type ApiTask, type Task, type TaskMessage, type Turn } from "../types";
import { typeName } from "../validate";
import { backgroundWork } from "../task-processes";

/** SQLite stores archived as 0/1; the public API exposes a boolean (a prior audit). */
export function apiTask(t: Task): ApiTask {
  return { ...t, archived: t.archived !== 0, background: backgroundWork(t.id), ...(t.archived ? { cleanup: cleanupSummary(t.id) } : {}) };
}

export type ApiTaskMessage = Omit<
  TaskMessage,
  "attachments_json" | "claim" | "claim_turn_n" | "attachment_hash" | "delivery_uncertain"
> & {
  attachments: AttachmentRecord[];
  delivery_uncertain: boolean;
};

export function apiTaskMessage(message: TaskMessage): ApiTaskMessage {
  const {
    attachments_json,
    claim: _claim,
    claim_turn_n: _claimTurn,
    attachment_hash: _attachmentHash,
    delivery_uncertain,
    ...rest
  } = message;
  return {
    ...rest,
    delivery_uncertain: delivery_uncertain !== 0,
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
export type ApiTurn = Omit<Turn, "attachments_json" | "usage_json" | "outcome_json" | "capture_categories_json"> & {
  attachments: AttachmentRecord[];
  usage: UsageSummary | null;
  capture_categories: Record<string, { records: number; bytes: number }> | null;
};

export function apiTurn(t: Turn, def?: AdapterDef): ApiTurn {
  const { attachments_json, usage_json, outcome_json: _outcome, capture_categories_json, ...rest } = t;
  let rawUsage: unknown = null;
  if (usage_json !== null) {
    try {
      rawUsage = JSON.parse(usage_json);
    } catch {
      rawUsage = null; // a corrupt blob is no usage report, not a 500
    }
  }
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
    capture_state: turnCaptureState(t),
    diagnostic_state: turnDiagnosticState(t),
    attachments: parseAttachmentManifest(attachments_json),
    usage: def ? formatUsage(def, rawUsage) : null,
    capture_categories: captureCategories,
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
