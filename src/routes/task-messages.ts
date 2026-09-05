import {
  messageAttachmentPath,
  parseAttachmentManifest,
  removeMessageAttachments,
  sniffImageType,
  turnAttachmentPath,
} from "../attachments";
import {
  cancelQueuedTaskMessage,
  getTask,
  getTaskMessage,
  turnForTask,
  updateQueuedTaskMessage,
} from "../store";
import { apiTaskMessage, err, json } from "./http";

/**
 * Serve turn or message image bytes. The requested name is first matched
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
  if (task.archived) return err(`${record.name} was removed when this task was archived`, 410);
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
  if (task.archived) return err(`${record.name} was removed when this task was archived`, 410);
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

async function serveAttachment(filePath: string, name: string, missingMessage: string): Promise<Response> {
  const file = Bun.file(filePath);
  if (!(await file.exists())) return err(missingMessage, 410);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const sniffed = sniffImageType(bytes);
  if (!sniffed) return err(`${name} is no longer a recognizable image on disk`, 415);
  return new Response(bytes, {
    headers: {
      "content-type": sniffed,
      "content-length": String(bytes.byteLength),
      "cache-control": "private, immutable, max-age=31536000",
      "x-content-type-options": "nosniff",
      "content-disposition": "inline",
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
    return (async () => {
      const body = (await req.json().catch(() => ({}))) as { message?: unknown };
      if (typeof body.message !== "string" || body.message.trim() === "") {
        return err("message must be a non-empty string", 400);
      }
      if (getTask(task.id)?.archived) {
        return err("task is archived — archived tasks are read-only", 409);
      }
      const updated = updateQueuedTaskMessage(message.id, task.id, body.message);
      return updated ? json(apiTaskMessage(updated)) : err("only queued messages can be edited", 409);
    })();
  }
  if (method === "DELETE") {
    const cancelled = cancelQueuedTaskMessage(message.id, task.id);
    if (!cancelled) return err("only queued messages can be cancelled", 409);
    removeMessageAttachments(task.id, message.id);
    return json(apiTaskMessage(cancelled));
  }
  return err("method not allowed", 405);
}
