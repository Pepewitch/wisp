/**
 * What one daemon owns, built once in serveOwned (daemon.ts) and passed to
 * whatever reads it. Nothing here is a module-level singleton, so two daemons
 * in one process (a test, an in-process hand-off) never read each other's
 * caches, and a loop started for one serve() call is stopped by that call.
 *
 * Per-daemon state that still lives in module scope, to move here one module
 * at a time: attachment uploads, terminal sessions and tabs, live inputs,
 * running children and process groups, turn interrupts, the event bus
 * listeners, and loop health.
 */
import type { AdapterDef } from "./adapters";
import type { TaskCompactor } from "./compacts";
import type { WispConfig } from "./config";
import type { HarnessLimitsCache } from "./harness-limits";
import type { HomeLifetime } from "./home-lifetime";
import type { ModelProbeCache } from "./model-probes";
import type { TaskProbeCache } from "./probes";
import type { PullRequestCache } from "./pull-requests";
import type { TaskSkillCache } from "./skills";
import type { UpdateManager } from "./update";

export interface DaemonCaches {
  models: ModelProbeCache;
  probes: TaskProbeCache;
  skills: TaskSkillCache;
  compacts: TaskCompactor;
  pullRequests: PullRequestCache;
  updates: UpdateManager;
  limits: HarnessLimitsCache;
}

/** A background loop or runtime the daemon started, and how to stop it. */
export interface DaemonService {
  name: string;
  stop(): void | Promise<void>;
}

export interface DaemonContext {
  cfg: WispConfig;
  adapters: Record<string, AdapterDef>;
  lifetime: HomeLifetime;
  caches: DaemonCaches;
  /** stopped in this order on the way out; register one as it starts */
  services: DaemonService[];
}

/** What the /api routes read: the config, the harnesses and the caches, never the lifecycle. */
export type RouteContext = Pick<DaemonContext, "cfg" | "adapters" | "caches">;

/**
 * Stop every service in registration order. A synchronous stop (clearing a
 * timer) runs synchronously, so every timer registered before the first
 * asynchronous stop is cleared before anything yields.
 */
export async function stopServices(services: readonly DaemonService[]): Promise<void> {
  for (const service of services) {
    const stopping = service.stop();
    if (stopping) await stopping;
  }
}

/** A timer loop as a service. */
export function intervalService(name: string, timer: ReturnType<typeof setInterval>): DaemonService {
  return { name, stop: () => clearInterval(timer) };
}

/** Start a runtime now, as a service. */
export function startedService(name: string, runtime: { start(): void; stop(): Promise<void> }): DaemonService {
  runtime.start();
  return { name, stop: () => runtime.stop() };
}
