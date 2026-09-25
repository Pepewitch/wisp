import type { AdapterDef } from "../adapters";
import type { WispConfig } from "../config";
import type { HarnessLimitsCache } from "../harness-limits";
import { json } from "./http";

/**
 * GET /api/harness-limits[?refresh=1]
 *
 * Every loaded harness that declares a plan-limits read, each with its own
 * status, so one harness that is not installed or not signed in never hides
 * the others. `refresh=1` skips the cache; the answer is otherwise at most
 * the cache's TTL old, and says so with `cached` and `fetchedAt`.
 */
export async function harnessLimitsRoute(
  url: URL,
  cfg: WispConfig,
  adapters: Record<string, AdapterDef>,
  cache: HarnessLimitsCache,
): Promise<Response> {
  const refresh = url.searchParams.get("refresh") === "1";
  return json({ harnesses: await cache.read(cfg, adapters, { refresh }) });
}
