// The RouteContext a test hands to route() when it calls the dispatcher
// directly instead of through serve(). Production builds exactly one per
// daemon (serveOwned); a test builds one per call, so the caches are shared by
// every call with the same adapters map (or config object) the way a daemon
// shares them across requests: a test that reuses one adapters map sees one
// compactor and one probe cache across its requests. Pass a cache to use it
// instead.
import type { AdapterDef } from "../../src/adapters";
import { TaskCompactor } from "../../src/compacts";
import type { WispConfig } from "../../src/config";
import type { DaemonCaches, RouteContext } from "../../src/daemon-context";
import { HarnessLimitsCache } from "../../src/harness-limits";
import { ModelProbeCache } from "../../src/model-probes";
import { TaskProbeCache } from "../../src/probes";
import { PullRequestCache } from "../../src/pull-requests";
import { TaskSkillCache } from "../../src/skills";
import { pullRequestTitleSync } from "../../src/task-update";
import { UpdateManager, type UpdateManagerOptions } from "../../src/update";

type AdapterCaches = Pick<DaemonCaches, "models" | "probes" | "skills" | "compacts" | "limits">;
type ConfigCaches = Pick<DaemonCaches, "pullRequests" | "updates">;

const byAdapters = new WeakMap<Record<string, AdapterDef>, AdapterCaches>();
const byConfig = new WeakMap<WispConfig, ConfigCaches>();

/** A route test never reaches GitHub by accident: one that needs releases injects an UpdateManager. */
const offline: UpdateManagerOptions["fetch"] = () => Promise.reject(new Error("route tests have no network; inject an UpdateManager"));

export function testRouteContext(
  cfg: WispConfig,
  adapters: Record<string, AdapterDef>,
  caches: Partial<DaemonCaches> = {},
): RouteContext {
  let perAdapters = byAdapters.get(adapters);
  if (!perAdapters) {
    perAdapters = {
      models: new ModelProbeCache(adapters),
      probes: new TaskProbeCache(),
      skills: new TaskSkillCache(),
      compacts: new TaskCompactor(),
      limits: new HarnessLimitsCache(),
    };
    byAdapters.set(adapters, perAdapters);
  }
  let perConfig = byConfig.get(cfg);
  if (!perConfig) {
    perConfig = {
      pullRequests: new PullRequestCache({ onPullRequestFound: pullRequestTitleSync(cfg) }),
      updates: new UpdateManager({ fetch: offline }),
    };
    byConfig.set(cfg, perConfig);
  }
  return { cfg, adapters, caches: { ...perAdapters, ...perConfig, ...caches } };
}
