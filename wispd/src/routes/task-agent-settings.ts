import type { AdapterDef } from "../adapters";
import { resolveHarnessDefaults, type WispConfig } from "../config";
import type { Task } from "../types";
import { typeName } from "../validate";
import { err } from "./http";

export function createServiceTierError(value: unknown): Response | null {
  if (value !== undefined && typeof value !== "string") {
    return err(`serviceTier must be a string, got ${typeName(value)}`, 400);
  }
  return value === "" ? err("serviceTier must not be empty", 400) : null;
}

export function sendServiceTierError(value: unknown): Response | null {
  return value !== undefined && value !== null && (typeof value !== "string" || value === "")
    ? err("serviceTier must be a non-empty string or null", 400)
    : null;
}

export function resolveCreateAgentSettings(
  cfg: WispConfig,
  harness: string,
  def: AdapterDef,
  requestedModel: string | undefined,
  requestedEffort: string | undefined,
  requestedServiceTier: string | undefined,
): { model: string | null; effort: string | null; serviceTier: string | null } | Response {
  const { model, effort } = resolveHarnessDefaults(cfg, harness, requestedModel, requestedEffort);
  const serviceTier = requestedServiceTier ?? def.defaultServiceTier ?? null;
  if (effort !== null && !def.effort) return err(`harness '${harness}' has no effort support`, 400);
  if (serviceTier !== null && !def.serviceTier) {
    return err(`harness '${harness}' has no service tier support`, 400);
  }
  return { model, effort, serviceTier };
}

export interface SendAgentBody {
  harness?: unknown;
  model?: unknown;
  effort?: unknown;
  serviceTier?: unknown;
  startFreshContext?: unknown;
}

export interface ResolvedSendAgent {
  harness: string;
  model: string | null;
  effort: string | null;
  serviceTier: string | null;
  harnessChanged: boolean;
  def: AdapterDef;
}

export function resolveSendAgent(
  task: Task,
  body: SendAgentBody,
  cfg: WispConfig,
  adapters: Record<string, AdapterDef>,
): ResolvedSendAgent | Response {
  const harness = (body.harness as string | undefined) ?? task.harness;
  const model = body.model === undefined ? task.model : (body.model as string);
  const harnessChanged = harness !== task.harness;
  if (harnessChanged && body.model === undefined) return err("model is required when changing harness", 400);
  if (harnessChanged && body.startFreshContext !== true) {
    return err("changing harness requires startFreshContext: true", 409);
  }
  const def = adapters[harness];
  if (!def) return err(`unknown harness: ${harness}`, body.harness === undefined ? 500 : 400);
  const effort =
    body.effort !== undefined
      ? (body.effort as string | null)
      : harnessChanged
        ? resolveHarnessDefaults(cfg, harness, model ?? undefined, undefined).effort
        : task.effort;
  const serviceTier =
    body.serviceTier !== undefined
      ? (body.serviceTier as string | null) ?? def.defaultServiceTier ?? null
      : harnessChanged
        ? def.defaultServiceTier ?? null
        : task.service_tier ?? def.defaultServiceTier ?? null;
  if (serviceTier !== null && !def.serviceTier) {
    return err(`harness '${harness}' has no service tier support`, 400);
  }
  return { harness, model, effort, serviceTier, harnessChanged, def };
}
