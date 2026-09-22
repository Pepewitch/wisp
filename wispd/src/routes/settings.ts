import {
  persistWispSettings,
  validateHiddenModels,
  wispSettings,
  type WispConfig,
  type WispSettings,
} from "../config";
import { emit } from "../events";
import { typeName } from "../validate";
import { err, json, jsonObjectBody } from "./http";

/** Key-order-insensitive, because two equal curations must compare equal. */
function sameHiddenModels(a: Record<string, string[]>, b: Record<string, string[]>): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  // both sides come from validateHiddenModels, so each list is deduped + sorted
  return keys.every((key) => b[key] !== undefined && a[key]!.join("\u0000") === b[key]!.join("\u0000"));
}

/**
 * GET/PATCH /api/settings
 *
 * This is deliberately a narrow public view rather than config.json over
 * HTTP: credentials and operational settings never leave the daemon.
 *
 * PATCH is a real patch — each key is independent, and an older client that
 * only knows `autoRenameTasksFromPullRequests` must not blank a curation it
 * has never heard of.
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
    const current = wispSettings(cfg);
    const next: WispSettings = { ...current };

    const rename = parsed.autoRenameTasksFromPullRequests;
    const hidden = parsed.hiddenModels;
    if (rename === undefined && hidden === undefined) {
      return err("autoRenameTasksFromPullRequests or hiddenModels is required", 400);
    }
    if (rename !== undefined) {
      if (typeof rename !== "boolean") {
        return err(
          `autoRenameTasksFromPullRequests must be a boolean, got ${typeName(rename)}`,
          400,
        );
      }
      next.autoRenameTasksFromPullRequests = rename;
    }
    if (hidden !== undefined) {
      try {
        next.hiddenModels = validateHiddenModels(hidden, "hiddenModels");
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e), 400);
      }
    }

    if (
      next.autoRenameTasksFromPullRequests === current.autoRenameTasksFromPullRequests &&
      sameHiddenModels(next.hiddenModels, current.hiddenModels)
    ) {
      // no-op: rewriting config.json and waking every client would be noise
      return json(current);
    }
    persistWispSettings(cfg, next);
    emit({ type: "settings" });
    return json(next);
  })();
}
