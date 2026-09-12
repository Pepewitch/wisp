import {
  persistWispSettings,
  wispSettings,
  type WispConfig,
} from "../config";
import { emit } from "../events";
import { typeName } from "../validate";
import { err, json, jsonObjectBody } from "./http";

/**
 * GET/PATCH /api/settings
 *
 * This is deliberately a narrow public view rather than config.json over
 * HTTP: credentials and operational settings never leave the daemon.
 */
export function settingsRoute(
  req: Request,
  path: string,
  method: string,
  cfg: WispConfig,
): Response | Promise<Response> | null {
  if (path !== "/api/settings") return null;
  if (method === "GET") return json(wispSettings(cfg));
  if (method !== "PATCH") return null;

  return (async () => {
    const parsed = await jsonObjectBody(req);
    if (parsed instanceof Response) return parsed;
    const value = parsed.autoRenameTasksFromPullRequests;
    if (value === undefined) {
      return err("autoRenameTasksFromPullRequests is required", 400);
    }
    if (typeof value !== "boolean") {
      return err(
        `autoRenameTasksFromPullRequests must be a boolean, got ${typeName(value)}`,
        400,
      );
    }
    const current = wispSettings(cfg);
    if (value === current.autoRenameTasksFromPullRequests) {
      // no-op: rewriting config.json and waking every client would be noise
      return json(current);
    }
    const settings = { autoRenameTasksFromPullRequests: value };
    persistWispSettings(cfg, settings);
    emit({ type: "settings" });
    return json(settings);
  })();
}
