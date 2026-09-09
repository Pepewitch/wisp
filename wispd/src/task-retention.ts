import { constants } from "node:fs";
import { parseAttachmentManifest, turnAttachmentPath, messageAttachmentPath } from "./attachments";
import { readdir, lstat, rm, open } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { DIAGNOSTIC_DIR, LOG_DIR, TASKS_DIR } from "./config";
import { db, getTask, messagesFor, setTaskFields, turnsFor } from "./store";
import { archiveCleanup } from "./archive-jobs";
import { assertTaskProcessesEnded } from "./task-processes";
import { taskDeliveryActive } from "./outbox";
import { emit } from "./events";
import type { Task } from "./types";
import type { TaskExport } from "../../shared/task-export";

const busy = new Set<string>();
let exporting = false;
async function processBarrier(id: string): Promise<void> {
  try { await assertTaskProcessesEnded(id); } catch { throw new RetentionError("Tracked background work is still running or unverified. Inspect the task process group on the daemon host, stop it, then retry."); }
}
const MAX_EXPORT_FILES = 5000;
const MAX_EXPORT_BYTES = 32 * 1024 * 1024;
export class RetentionError extends Error {
  constructor(message: string, readonly status = 409) { super(message); }
}
function settled(task: Task, exporting: boolean): void {
  if (!task.archived) throw new RetentionError("Archive this task and wait for cleanup to finish first. Its conversation and attachments will be preserved.");
  if (archiveCleanup(task.id)) throw new RetentionError("Archive cleanup is incomplete. Resolve it in the Cleanup panel before exporting or permanently deleting this task.");
  if (exporting && task.purge_pending) throw new RetentionError("Permanent deletion was started. Some files may already be removed; retry deletion to finish.");
}
async function filesFor(task: Task, limit = Infinity): Promise<{ files: string[]; missing: string[] }> {
  const files = new Set<string>(), missing: string[] = [];
  async function walk(path: string): Promise<void> {
    let stat;
    try { stat = await lstat(path); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return; throw e; }
    if (stat.isSymbolicLink()) throw new RetentionError("Task storage contains a symbolic link. Inspect it on the daemon host before continuing.");
    if (stat.isDirectory()) for (const entry of await readdir(path)) await walk(join(path, entry));
    else if (stat.isFile()) files.add(path);
    if (files.size > limit) throw new RetentionError("Task storage exceeds 5,000 files. Use the offline backup procedure for this task.", 413);
  }
  await walk(join(TASKS_DIR, task.id));
  const turns = turnsFor(task.id), ids = new Set(turns.map(t => t.id));
  for (const name of await readdir(LOG_DIR)) if (name.startsWith(`${task.id}-`)) await walk(join(LOG_DIR, name));
  for (const turn of turns) {
    const path = resolve(turn.log_file);
    if (relative(LOG_DIR, path).startsWith("..") || path === resolve(LOG_DIR)) { missing.push(`turn ${turn.n}: log outside managed storage`); continue; }
    await walk(path);
    if (!files.has(path)) missing.push(`turn ${turn.n}: transcript unavailable`);
  }
  for (const name of await readdir(DIAGNOSTIC_DIR).catch((e: NodeJS.ErrnoException) => { if (e.code === "ENOENT") return []; throw e; })) {
    const match = /^turn-(\d+)-\d{6}\.jsonl$/.exec(name);
    if (match && ids.has(Number(match[1]))) await walk(join(DIAGNOSTIC_DIR, name));
  }
  return { files: [...files], missing };
}
function exportPath(path: string): string {
  for (const [prefix, root] of [["tasks", TASKS_DIR], ["logs", LOG_DIR], ["diagnostics", DIAGNOSTIC_DIR]] as const) {
    const rel = relative(root, path);
    if (rel && !rel.startsWith("..")) return `${prefix}/${rel}`;
  }
  throw new RetentionError("Task file is outside managed storage");
}
export async function taskStorage(task: Task): Promise<{ bytes: number; files: number }> {
  const list = await filesFor(task);
  let bytes = 0;
  for (const path of list.files) bytes += (await lstat(path)).size;
  return { bytes, files: list.files.length };
}
export async function exportTask(task: Task): Promise<TaskExport> {
  task = getTask(task.id) ?? (() => { throw new RetentionError("This task was already deleted. Refresh the task list.", 404); })();
  settled(task, true);
  if (exporting) throw new RetentionError("Another portable export is running. Wait for it to finish, then retry.", 429);
  if (busy.has(task.id)) throw new RetentionError("Another export or deletion is running for this task. Wait and retry.");
  busy.add(task.id);
  exporting = true;
  try {
    await processBarrier(task.id);
    const turns = turnsFor(task.id), messages = messagesFor(task.id);
    const result: TaskExport = { format: "wisp-task-export-v1", exportedAt: new Date().toISOString(), task, turns, messages, files: [], missing: [] };
    if (Buffer.byteLength(JSON.stringify(result)) > 8 * 1024 * 1024) throw new RetentionError("Conversation metadata exceeds the export limit. Use the offline backup procedure.", 413);
    const list = await filesFor(task, MAX_EXPORT_FILES); result.missing = list.missing;
    let total = 0;
    for (const path of list.files) {
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const size = (await file.stat()).size;
        if (total + size > MAX_EXPORT_BYTES) throw new RetentionError("Task files exceed the 32 MiB portable-export limit. Use the offline backup procedure to preserve the full task.", 413);
        total += size;
        // Bounded reads even if an external writer grows a file after the size check.
        const bytes = Buffer.alloc(size);
        let offset = 0;
        while (offset < size) { const n = (await file.read(bytes, offset, size - offset, offset)).bytesRead; if (!n) break; offset += n; }
        if (offset !== size) throw new RetentionError("Task files changed during export. Stop external writers and retry.");
        result.files.push({ path: exportPath(path), dataBase64: bytes.toString("base64") });
      } finally { await file.close(); }
    }
    const paths = new Set(list.files);
    for (const turn of turns) for (const record of parseAttachmentManifest(turn.attachments_json)) {
      const path = turnAttachmentPath(task.id, turn.n, record.name);
      if (!paths.has(path)) result.missing.push(exportPath(path));
    }
    for (const message of messages) for (const record of parseAttachmentManifest(message.attachments_json)) {
      const path = message.delivery === "started" && message.turn_n !== null
        ? turnAttachmentPath(task.id, message.turn_n, record.name)
        : messageAttachmentPath(task.id, message.id, record.name);
      if (!paths.has(path)) result.missing.push(exportPath(path));
    }
    return result;
  } finally { exporting = false; busy.delete(task.id); }
}
export async function purgeTask(task: Task): Promise<void> {
  task = getTask(task.id) ?? (() => { throw new RetentionError("This task was already deleted. Refresh the task list.", 404); })();
  settled(task, false);
  if (busy.has(task.id)) throw new RetentionError("Another export or deletion is running for this task. Wait and retry.");
  busy.add(task.id);
  try {
    await processBarrier(task.id);
    if (taskDeliveryActive(task.id)) throw new RetentionError("A webhook delivery is still in progress. Wait for it to finish, then retry deletion.");
    setTaskFields(task.id, { purge_pending: 1, state_detail: "Permanent deletion is in progress. If interrupted, retry Delete permanently." });
    emit({ type: "task", taskId: task.id, state: task.state, stateDetail: getTask(task.id)!.state_detail, seq: task.seq });
    const list = await filesFor(task);
    for (const path of list.files) await rm(path, { force: true });
    await rm(join(TASKS_DIR, task.id), { force: true, recursive: true });
    db.transaction(() => {
      db.query("DELETE FROM outbox WHERE task_id = ?").run(task.id);
      db.query("DELETE FROM turn_process_groups WHERE task_id = ?").run(task.id);
      db.query("DELETE FROM task_messages WHERE task_id = ?").run(task.id);
      // Derived search index (turn-texts.ts). The foreign key would cascade,
      // but permanent deletion states what it deletes rather than relying on
      // a pragma being on.
      db.query("DELETE FROM turn_texts WHERE task_id = ?").run(task.id);
      db.query("DELETE FROM turns WHERE task_id = ?").run(task.id);
      db.query("DELETE FROM tasks WHERE id = ?").run(task.id);
    })();
    emit({ type: "task", taskId: task.id, state: task.state, stateDetail: "Task permanently deleted", seq: task.seq });
  } finally { busy.delete(task.id); }
}
