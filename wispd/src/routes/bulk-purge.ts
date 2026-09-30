import { executeBulkPurge, planBulkPurge } from "../bulk-purge";
import { trackHomeWork } from "../home-lifetime";
import { archivedBefore } from "../storage-scan";
import type { TaskCache } from "../task-cache";
import { RetentionError } from "../task-retention";
import { err, json, jsonObjectBody } from "./http";
import { requestActor } from "../task-audit";

export function bulkPurgeRoute(
  req: Request,
  url: URL,
  taskCaches: readonly TaskCache[] = [],
): Promise<Response> {
  return trackHomeWork((async () => {
    try {
      if (req.method === "GET") {
        return json(await planBulkPurge(archivedBefore(url.searchParams.get("archivedBefore"))));
      }
      if (req.method !== "DELETE") return err("method not allowed", 405);
      const body = await jsonObjectBody(req);
      if (body instanceof Response) return body;
      // Confirm the exact absolute cutoff returned by GET, not a relative age
      // recalculated seconds later while more tasks cross the threshold.
      if (typeof body.cutoff !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(body.cutoff) ||
          !Number.isFinite(Date.parse(body.cutoff)) || new Date(body.cutoff).toISOString() !== body.cutoff) {
        return err("Provide the cutoff returned by the purge preview.", 400);
      }
      const result = await executeBulkPurge(await planBulkPurge(body.cutoff), body.confirmCount, body.fingerprint, taskCaches);
      // Each task's audit went with it, so the daemon log is what says who.
      if (result.purged.length > 0) {
        console.log(`[wisp] ${result.purged.length} archived task(s) permanently deleted by ${requestActor(req)}: ${result.purged.join(", ")}`);
      }
      return json(result);
    } catch (error) {
      if (error instanceof RetentionError) return err(error.message, error.status);
      if (error instanceof Error && error.message.startsWith("--archived-before")) return err(error.message, 400);
      console.error("[wisp] bulk purge failed:", error);
      return err("Bulk purge could not finish. Inspect file permissions and retry the dry run.", 500);
    }
  })()).then(response => {
    response.headers.set("cache-control", "private, no-store");
    return response;
  });
}
