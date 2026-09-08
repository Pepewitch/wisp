import type { WispConfig } from "../config";
import { API_PROTOCOL_VERSION, BUILD_INFO } from "../version";
import { json } from "./http";

export const DAEMON_CAPABILITIES = Object.freeze({
  projects: true,
  projectRemoval: true,
  events: true,
  taskLogStreaming: true,
  terminal: true,
  attachments: true,
  managedUpdates: true,
} as const);

export interface DaemonCapabilities {
  apiProtocolVersion: number;
  instanceId: string;
  version: string;
  commit: string;
  dirty: boolean;
  capabilities: typeof DAEMON_CAPABILITIES;
}

/** Authenticated daemon identity and feature discovery for non-browser clients. */
export function capabilitiesRoute(cfg: WispConfig): Response {
  const body: DaemonCapabilities = {
    apiProtocolVersion: API_PROTOCOL_VERSION,
    instanceId: cfg.instanceId,
    ...BUILD_INFO,
    capabilities: DAEMON_CAPABILITIES,
  };
  return json(body, 200, { "cache-control": "private, no-store" });
}
