import { formatUsage, type AdapterDef, type UsageSummary } from "../adapters";
import { parseAttachmentManifest, type AttachmentRecord } from "../attachments";
import type { ApiTask, Task, TaskMessage, Turn } from "../types";

/** SQLite stores archived as 0/1; the public API exposes a boolean (a prior audit). */
export function apiTask(t: Task): ApiTask {
  return { ...t, archived: t.archived !== 0 };
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
export type ApiTurn = Omit<Turn, "attachments_json" | "usage_json"> & {
  attachments: AttachmentRecord[];
  usage: UsageSummary | null;
};

export function apiTurn(t: Turn, def?: AdapterDef): ApiTurn {
  const { attachments_json, usage_json, ...rest } = t;
  let rawUsage: unknown = null;
  if (usage_json !== null) {
    try {
      rawUsage = JSON.parse(usage_json);
    } catch {
      rawUsage = null; // a corrupt blob is no usage report, not a 500
    }
  }
  return {
    ...rest,
    attachments: parseAttachmentManifest(attachments_json),
    usage: def ? formatUsage(def, rawUsage) : null,
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
