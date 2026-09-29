import { runningTurns } from "../store";
import { UpdateInterruptsTasksError, UpdateManager } from "../update";
import { err, json, jsonObjectBody } from "./http";

/** Tasks with a running turn: what a restart would interrupt. */
function runningTaskCount(): number {
  return new Set(runningTurns().map((turn) => turn.task_id)).size;
}

export function updateRoute(
  req: Request,
  path: string,
  method: string,
  updates: UpdateManager,
): Response | Promise<Response> | null {
  if (path !== "/api/update") return null;
  if (method === "GET") {
    const refresh = new URL(req.url).searchParams.get("refresh") === "1";
    return (refresh ? updates.refreshStatus() : updates.getStatus()).then((status) => json(status));
  }
  if (method !== "POST") return err("not found", 404);
  return (async () => {
    const body = await jsonObjectBody(req);
    if (body instanceof Response) return body;
    if (body.force !== undefined && typeof body.force !== "boolean") return err("force must be a boolean", 400);
    try {
      return json(await updates.start(body.version, { force: body.force === true, runningTasks: runningTaskCount }), 202);
    } catch (error) {
      // 409 with the count: the client confirms with the person, then retries with force
      if (error instanceof UpdateInterruptsTasksError) return json({ error: error.message, running: error.running }, 409);
      const message = error instanceof Error ? error.message : String(error);
      return err(message, message === "an update is already in progress" ? 409 : 400);
    }
  })();
}
