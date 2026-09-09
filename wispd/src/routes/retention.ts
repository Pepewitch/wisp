import { exportTask, purgeTask, taskStorage, RetentionError } from "../task-retention";
import { trackHomeWork } from "../home-lifetime";
import type { Task } from "../types";
import { err, json, jsonObjectBody } from "./http";

export function retentionRoute(req: Request, task: Task, action: string): Promise<Response> {
  return trackHomeWork((async () => {
    try {
      if (action === "export" && req.method === "GET") return json(await exportTask(task));
      if (action === "storage" && req.method === "GET") return json(await taskStorage(task));
      if (action === "purge" && req.method === "DELETE") {
        const body = await jsonObjectBody(req);
        if (body instanceof Response) return body;
        if (body.confirmTaskId !== task.id) return err("Confirm permanent deletion by providing confirmTaskId matching this task. Export anything you want to keep first.", 400);
        await purgeTask(task);
        return json({ ok: true });
      }
      return err("method not allowed", 405);
    } catch (e) {
      if (e instanceof RetentionError) return err(e.message, e.status);
      console.error(`[wisp] task ${action} failed for ${task.id}:`, e);
      return err(`Task ${action} could not finish. Check free disk space and file permissions on the daemon host, then retry. Permanent deletion can be retried safely.`, 500);
    }
  })()).then(response => {
    response.headers.set("cache-control", "private, no-store");
    return response;
  });
}
