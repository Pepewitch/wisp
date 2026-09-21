/**
 * The agent a steer asks for: validated at the request boundary, resolved
 * against the task's current one, and reduced to "did anything change".
 *
 * It lives apart from the send route because it is a decision, not plumbing —
 * every field here (harness, model, effort, fast) has to survive a queue and a
 * restart, so the refusals and the inheritance rules are worth reading on their
 * own rather than inside the middle of a 100-line handler.
 */
import type { AdapterDef } from "../adapters";
import { resolveHarnessDefaults, type WispConfig } from "../config";
import type { TaskAgentSelection } from "../store-messages";
import type { Task } from "../types";
import { typeName } from "../validate";
import { err } from "./http";

export interface SendTaskBody {
  message?: unknown;
  suffixPromptId?: unknown;
  attachments?: unknown;
  clientMessageId?: unknown;
  harness?: unknown;
  model?: unknown;
  effort?: unknown;
  fast?: unknown;
  startFreshContext?: unknown;
}

export function sendTaskBodyError(body: SendTaskBody): Response | null {
  if (typeof body.message !== "string" || body.message.length === 0) return err("message is required", 400);
  if (body.suffixPromptId !== undefined && typeof body.suffixPromptId !== "string") {
    return err(`suffixPromptId must be a string, got ${typeName(body.suffixPromptId)}`, 400);
  }
  if (body.harness !== undefined && (typeof body.harness !== "string" || body.harness === "")) {
    return err("harness must be a non-empty string", 400);
  }
  if (body.model !== undefined && (typeof body.model !== "string" || body.model === "")) {
    return err("model must be a non-empty string", 400);
  }
  if (body.effort !== undefined && body.effort !== null && (typeof body.effort !== "string" || body.effort === "")) {
    return err("effort must be a non-empty string or null", 400);
  }
  if (body.fast !== undefined && typeof body.fast !== "boolean") {
    return err("fast must be a boolean", 400);
  }
  if (body.startFreshContext !== undefined && typeof body.startFreshContext !== "boolean") {
    return err("startFreshContext must be a boolean", 400);
  }
  if (
    body.clientMessageId !== undefined &&
    (typeof body.clientMessageId !== "string" || !/^[A-Za-z0-9_-]{8,80}$/.test(body.clientMessageId))
  ) {
    return err("clientMessageId must be 8-80 letters, numbers, '_' or '-'", 400);
  }
  return null;
}

export interface ResolvedSendAgent {
  harness: string;
  model: string | null;
  effort: string | null;
  fast: boolean;
  harnessChanged: boolean;
  def: AdapterDef;
}

export function resolveSendAgent(
  task: Task,
  body: SendTaskBody,
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
  // A harness switch cannot carry the old harness's fast mode: the new one may
  // not sell the lane at all, and inheriting a tier across that boundary would
  // be a choice the user never made for this harness.
  const fast = body.fast !== undefined ? body.fast === true : harnessChanged ? false : task.fast === 1;
  if (fast && !def.fastMode) return err(`harness '${harness}' has no fast mode`, 400);
  return { harness, model, effort, fast, harnessChanged, def };
}

/**
 * The switch to persist, or undefined when the send asks for the agent the task
 * already has. Every field the turn snapshots is compared, so a tier or effort
 * change starts a new turn instead of being steered into a running one.
 */
export function agentSwitch(task: Task, resolved: ResolvedSendAgent): TaskAgentSelection | undefined {
  const { harness, model, effort, fast, harnessChanged } = resolved;
  const changed =
    harness !== task.harness || model !== task.model || effort !== task.effort || fast !== (task.fast === 1);
  return changed ? { harness, model, effort, fast, freshContext: harnessChanged } : undefined;
}
