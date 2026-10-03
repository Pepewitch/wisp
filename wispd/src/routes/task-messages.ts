import {
  attachmentKind,
  messageAttachmentPath,
  parseAttachmentManifest,
  removeMessageAttachments,
  sniffAttachmentHeader,
  SNIFF_WINDOW_BYTES,
  turnAttachmentPath,
} from "../attachments";
import {
  cancelQueuedTaskMessage,
  getTask,
  getTaskMessage,
  turnForTask,
  updateQueuedTaskMessage,
} from "../store";
import { isCompactPrompt, type AdapterDef } from "../adapters";
import type { WispConfig } from "../config";
import type { TaskCompactor } from "../compacts";
import { hasRunningTurn, sendQueuedMessageNow } from "../runner";
import { InterruptConflict } from "../turn-interrupt";
import { changeWorkflowState } from "../workflows/store";
import { skipCancelledRound } from "../autopilot/store";
import type { SendResponse } from "../../../shared/api/task";
import { recordAudit, requestActor } from "../task-audit";
import { apiTask, apiTaskMessage, err, json, jsonObjectBody } from "./http";

/**
 * Serve turn or message attachment bytes. The requested name is first matched
 * against a persisted, daemon-sanitized manifest; request characters never
 * become a filesystem path. Content type is sniffed from the bytes.
 */
export function attachmentRoute(path: string, method: string): Response | Promise<Response> | null {
  const turnMatch = path.match(/^\/api\/tasks\/([a-z0-9]+)\/attachments\/(\d+)\/(.+)$/);
  if (turnMatch) return turnAttachment(turnMatch, method);
  const messageMatch = path.match(
    /^\/api\/tasks\/([a-z0-9]+)\/messages\/([A-Za-z0-9_-]+)\/attachments\/(.+)$/,
  );
  return messageMatch ? messageAttachment(messageMatch, method) : null;
}

function messageAttachment(match: RegExpMatchArray, method: string): Response | Promise<Response> {
  const [, id, messageId, nameRaw] = match;
  if (method !== "GET") return err("method not allowed", 405);
  const task = getTask(id!);
  if (!task) return err(`no such task: ${id}`, 404);
  const message = getTaskMessage(messageId!);
  if (!message || message.task_id !== task.id) return err(`no such message: ${messageId}`, 404);
  const name = decodedName(nameRaw!);
  if (name instanceof Response) return name;
  const record = parseAttachmentManifest(message.attachments_json).find((candidate) => candidate.name === name);
  if (!record) return err(`message ${message.id} has no attachment named ${name}`, 404);
  if (task.purge_pending) return err("Permanent deletion is in progress. Retry Delete permanently to finish.", 410);
  if (task.archived && !task.archive_assets_retained) return err(`${record.name} was removed when this task was archived`, 410);
  if (message.status === "cancelled") {
    return err(`${record.name} was removed when this message was cancelled`, 410);
  }
  const filePath =
    message.delivery === "started" && message.turn_n !== null
      ? turnAttachmentPath(task.id, message.turn_n, record.name)
      : messageAttachmentPath(task.id, message.id, record.name);
  const missing = `${record.name} is recorded on message ${message.id} but its file is missing`;
  return serveAttachment(filePath, record.name, missing);
}

function turnAttachment(match: RegExpMatchArray, method: string): Response | Promise<Response> {
  const [, id, turnRaw, nameRaw] = match;
  if (method !== "GET") return err("method not allowed", 405);
  const task = getTask(id!);
  if (!task) return err(`no such task: ${id}`, 404);
  const turn = turnForTask(task.id, Number(turnRaw));
  if (!turn) return err(`no turn ${turnRaw}`, 404);
  const name = decodedName(nameRaw!);
  if (name instanceof Response) return name;
  const record = parseAttachmentManifest(turn.attachments_json).find((candidate) => candidate.name === name);
  if (!record) return err(`turn ${turn.n} has no attachment named ${name}`, 404);
  if (task.purge_pending) return err("Permanent deletion is in progress. Retry Delete permanently to finish.", 410);
  if (task.archived && !task.archive_assets_retained) return err(`${record.name} was removed when this task was archived`, 410);
  const missing = `${record.name} is recorded on turn ${turn.n} but its file is missing`;
  return serveAttachment(turnAttachmentPath(task.id, turn.n, record.name), record.name, missing);
}

function decodedName(raw: string): string | Response {
  try {
    return decodeURIComponent(raw);
  } catch {
    return err("attachment name is not valid percent-encoding", 400);
  }
}

/**
 * Not cached, deliberately. These are screenshots a person pasted into a task,
 * and archive/cancel DELETE the bytes — but the previous year-long `immutable`
 * entry meant a browser kept serving them from its own disk long after the
 * daemon began answering 410, so "removed when this task was archived" was
 * true of the server and false of the profile that had viewed it (SEC-08).
 * The browser refetches instead: attachments are count- and size-capped, the
 * fetch is same-origin, and the daemon is normally on this machine.
 */
export const ATTACHMENT_CACHE_CONTROL = "private, no-store";

/**
 * Serve one stored attachment's bytes.
 *
 * The type comes from the BYTES, never the name or the manifest — a `.png`
 * holding jpeg serves image/jpeg — and the sniff reads a leading window rather
 * than the whole file, so a 50 MB video is not copied into the daemon's heap to
 * decide what it is. The body is streamed from the file for the same reason.
 *
 * Only images are served `inline`. Everything else gets an `attachment`
 * disposition: a text attachment is arbitrary content a person pasted, and
 * rendering it on the daemon's own origin is the one way these bytes could
 * become a script rather than a file. The web app never navigates to these
 * URLs anyway — it fetches them with its bearer credential and renders a blob.
 */
export async function serveAttachment(filePath: string, name: string, missingMessage: string): Promise<Response> {
  const file = Bun.file(filePath);
  if (!(await file.exists())) return err(missingMessage, 410);
  const head = new Uint8Array(await file.slice(0, SNIFF_WINDOW_BYTES).arrayBuffer());
  const sniffed = sniffAttachmentHeader(head);
  if (!sniffed) return err(`${name} is no longer a recognizable file on disk`, 415);
  const kind = attachmentKind(sniffed);
  return new Response(file.stream(), {
    headers: {
      "content-type": kind === "text" ? "text/plain; charset=utf-8" : sniffed,
      "content-length": String(file.size),
      "cache-control": ATTACHMENT_CACHE_CONTROL,
      "x-content-type-options": "nosniff",
      "content-disposition":
        kind === "image" ? "inline" : `attachment; filename="${name.replace(/["\\]/g, "_")}"`,
    },
  });
}

/** Edit or cancel a message only while it is still waiting in the durable FIFO. */
export function taskMessageRoute(req: Request, path: string, method: string): Response | Promise<Response> | null {
  const match = path.match(/^\/api\/tasks\/([a-z0-9]+)\/messages\/([A-Za-z0-9_-]+)$/);
  if (!match) return null;
  const [, taskId, messageId] = match;
  const task = getTask(taskId!);
  if (!task) return err(`no such task: ${taskId}`, 404);
  const message = getTaskMessage(messageId!);
  if (!message || message.task_id !== task.id) return err(`no such message: ${messageId}`, 404);
  if ((method === "PATCH" || method === "DELETE") && task.archived) {
    return err("task is archived — archived tasks are read-only", 409);
  }
  if (method === "PATCH") {
    if (message.workflow_id) return err("Configure the workflow instead of editing its generated instruction", 409);
    return (async () => {
      const parsed = await jsonObjectBody(req);
      if (parsed instanceof Response) return parsed;
      const body = parsed as { message?: unknown };
      if (typeof body.message !== "string" || body.message.trim() === "") {
        return err("message must be a non-empty string", 400);
      }
      if (getTask(task.id)?.archived) {
        return err("task is archived — archived tasks are read-only", 409);
      }
      const updated = updateQueuedTaskMessage(message.id, task.id, body.message);
      if (!updated) return err("only queued messages can be edited", 409);
      recordAudit(task.id, "edit", requestActor(req), `message ${message.id}`);
      return json(apiTaskMessage(updated));
    })();
  }
  if (method === "DELETE") {
    const cancelled = cancelQueuedTaskMessage(message.id, task.id);
    if (!cancelled) return err("only queued messages can be cancelled", 409);
    const actor = requestActor(req);
    recordAudit(task.id, "cancel", actor, `message ${message.id}`);
    // Cancelling a queued auto-fix round means "don't send this one" (Skip);
    // any other workflow's generated instruction pauses its workflow.
    if (message.workflow_id && skipCancelledRound(message.workflow_id, message.id)) {
      recordAudit(task.id, "autopilot-skip", actor, `message ${message.id} cancelled`);
    } else if (message.workflow_id) {
      const paused = changeWorkflowState(message.workflow_id, "paused", "Generated instruction cancelled by user");
      recordAudit(task.id, "workflow-pause", actor, `${paused.id} (${paused.type}) · its message ${message.id} was cancelled`);
    }
    removeMessageAttachments(task.id, message.id);
    return json(apiTaskMessage(cancelled));
  }
  return err("method not allowed", 405);
}

/**
 * POST /api/tasks/:id/messages/:messageId/send-now — a queued message the
 * person no longer wants to wait: its hold is lifted and it is delivered the
 * way a `now` send is, steered in or started by stopping the running turn.
 */
export function taskMessageSendNowRoute(
  req: Request,
  path: string,
  method: string,
  cfg: WispConfig,
  adapters: Record<string, AdapterDef>,
  compacts: TaskCompactor,
): Response | Promise<Response> | null {
  const match = path.match(/^\/api\/tasks\/([a-z0-9]+)\/messages\/([A-Za-z0-9_-]+)\/send-now$/);
  if (!match) return null;
  if (method !== "POST") return err("method not allowed", 405);
  const [, taskId, messageId] = match;
  const task = getTask(taskId!);
  if (!task) return err(`no such task: ${taskId}`, 404);
  const message = getTaskMessage(messageId!);
  if (!message || message.task_id !== task.id) return err(`no such message: ${messageId}`, 404);
  // the same refusals /send makes, so the runner's own archived guard never fires from here
  if (task.archived) return err("task is archived — archived tasks are read-only", 409);
  if (task.state === "creating") return err("task is still being created", 409);
  if (!task.worktree_path) return err("task has no worktree (failed before setup?)", 409);
  if (message.workflow_id) return err("a workflow's generated instruction is sent by its workflow", 409);
  const running = hasRunningTurn(task.id);
  if (compacts.isCompacting(task.id) || (running && isCompactPrompt(adapters[running.harness], running.prompt))) {
    return err("compaction is still running — wait for it to finish", 409);
  }
  return (async () => {
    try {
      const result = await sendQueuedMessageNow(task.id, message.id, adapters, cfg);
      if (!result) return err("only queued messages can be sent now", 409);
      recordAudit(task.id, "send-now", requestActor(req), `message ${message.id}${result.interrupted ? " · interrupted the running turn" : ""}`);
      return json<SendResponse>({
        ...apiTask(getTask(task.id)!),
        disposition: result.disposition,
        message: apiTaskMessage(result.message),
        ...(result.interrupted ? { interrupted: true } : {}),
      });
    } catch (error) {
      if (error instanceof InterruptConflict) return err(error.message, 409);
      throw error;
    }
  })();
}
