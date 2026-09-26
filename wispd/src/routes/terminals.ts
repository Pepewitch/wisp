import type { WispConfig } from "../config";
import { getTask } from "../store";
import {
  closeShell,
  createShell,
  listShells,
  MAX_SHELL_NAME_LENGTH,
  renameShell,
  restartShell,
  ShellConflictError,
  type ShellKillOutcome,
} from "../terminal";
import { err, json, jsonObjectBody } from "./http";

/** Every path this module answers; the socket itself stays `/terminal` in daemon.ts. */
export const TERMINALS_PATH = /^\/api\/tasks\/([a-z0-9]+)\/terminals(?:\/(\d+)(\/restart)?)?$/;

/**
 * A kill that would interrupt a running program is a 409 that NAMES it, so a
 * client can ask "`bun` is still running — close anyway?" and retry with
 * `?force=1`, instead of guessing from its own copy of the screen.
 */
function killAnswer(outcome: ShellKillOutcome): Response {
  if (outcome.kind === "missing") return err("no such shell", 404);
  if (outcome.kind === "busy") {
    return json({ error: `${outcome.program} is still running in this shell`, program: outcome.program }, 409);
  }
  return json(outcome.shell ?? { ok: true });
}

/**
 * GET    /api/tasks/:id/terminals                  the task's shell tabs
 * POST   /api/tasks/:id/terminals                  open a tab
 * PATCH  /api/tasks/:id/terminals/:shell           { name } — null or "" resets it
 * DELETE /api/tasks/:id/terminals/:shell[?force=1] close the tab, hanging up its shell
 * POST   /api/tasks/:id/terminals/:shell/restart[?force=1]
 */
export async function terminalsRoute(req: Request, url: URL, path: string, cfg: WispConfig): Promise<Response> {
  const match = path.match(TERMINALS_PATH)!;
  const task = getTask(match[1]!);
  if (!task) return err("Task not found", 404);
  const method = req.method;
  const force = url.searchParams.get("force") === "1";
  try {
    if (match[2] === undefined) {
      if (method === "GET") return json(listShells(task.id));
      if (method !== "POST") return err("Method not allowed", 405);
      if (task.archived) return err(`task ${task.id} is archived — worktree removed`, 409);
      if (!task.worktree_path) return err(`task ${task.id} has no worktree_path`, 409);
      return json(createShell(task.id, cfg.terminalShell), 201);
    }
    const id = Number(match[2]);
    if (match[3] !== undefined) {
      if (method !== "POST") return err("Method not allowed", 405);
      return killAnswer(await restartShell(task.id, id, force));
    }
    if (method === "DELETE") return killAnswer(await closeShell(task.id, id, force));
    if (method !== "PATCH") return err("Method not allowed", 405);
    const body = await jsonObjectBody(req);
    if (body instanceof Response) return body;
    if (body.name !== null && typeof body.name !== "string") return err("name must be a string or null", 400);
    if (typeof body.name === "string" && body.name.trim().length > MAX_SHELL_NAME_LENGTH) {
      return err(`name must be at most ${MAX_SHELL_NAME_LENGTH} characters`, 400);
    }
    const renamed = renameShell(task.id, id, body.name);
    return renamed ? json(renamed) : err("no such shell", 404);
  } catch (error) {
    if (error instanceof ShellConflictError) return err(error.message, 409);
    throw error;
  }
}
