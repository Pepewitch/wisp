import { open } from "node:fs/promises";
import { join } from "node:path";
import { LOG_DIR } from "../config";
import { db } from "../store";
import { assertCleanupHookEnded } from "../archive-hooks";
import { cleanupProgress, cleanupSummary, isHook, notifyCleanup, updateProgress } from "../archive-progress";
import { kickCleanup } from "../archive-worker";
import { err, json, jsonObjectBody } from "./http";

async function logTail(id: string): Promise<string> {
  let file;
  try { file = await open(join(LOG_DIR, `${id}-archive.log`), "r"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return "No script output has been recorded."; throw error; }
  try {
    const size = (await file.stat()).size;
    const bytes = Buffer.alloc(Math.min(size, 16 * 1024));
    const read = await file.read(bytes, 0, bytes.length, Math.max(0, size - bytes.length));
    return bytes.subarray(0, read.bytesRead).toString();
  } finally { await file.close(); }
}

export async function cleanupRoute(req: Request, id: string): Promise<Response> {
  if (req.method === "GET") return json({ ...cleanupSummary(id), log: await logTail(id) });
  if (req.method !== "POST") return err("method not allowed", 405);
  const body = await jsonObjectBody(req);
  if (body instanceof Response) return body;
  if (!["retry", "confirm", "rerun"].includes(String(body.action)) || !Number.isSafeInteger(body.revision)) {
    return err("action must be retry, confirm, or rerun, with the cleanup revision shown by Wisp", 400);
  }
  const p = cleanupProgress(id);
  if (!p || p.revision !== body.revision || p.status === "running") return err("Cleanup has changed. Refresh this task before choosing an action.", 409);
  const uncertain = isHook(p.phase) && p.status === "needs-attention";
  if ((body.action === "retry") === uncertain) return err("Check the script outcome, then explicitly confirm completion or rerun it. Safe cleanup steps use Retry cleanup.", 409);
  if (p.phase === "legacy-hooks" && body.confirmStopped !== true) {
    return err("This cleanup started in an earlier Wisp version. First verify its cleanup scripts and their child processes have stopped, then confirm that check.", 409);
  }
  try { await assertCleanupHookEnded(p); }
  catch (error) { return err(error instanceof Error ? error.message : String(error), 409); }
  // Two clients may resolve the same job; the displayed revision owns this decision.
  const changed = db.transaction(() => {
    const fresh = cleanupProgress(id);
    if (!fresh || fresh.revision !== p.revision || fresh.status === "running") return false;
    let phase = p.phase;
    let prepared = p.prepared;
    if (p.phase === "legacy-hooks") { phase = "save-work"; prepared = body.action === "confirm" ? 2 : 0; }
    else if (body.action === "confirm") phase = p.phase === "repo-hook" ? "project-hook" : "remove-worktree";
    db.query("UPDATE archive_cleanups SET attempts = 0, last_error = NULL WHERE task_id = ?").run(id);
    updateProgress(id, { phase, prepared, status: "pending", next_retry_at: null, hook_pgid: null, hook_boot: null }, false);
    return true;
  })();
  if (!changed) return err("Cleanup changed while you were checking it. Refresh and review the current step.", 409);
  notifyCleanup(id);
  kickCleanup();
  return json(cleanupSummary(id), 202);
}
