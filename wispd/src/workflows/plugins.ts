import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { WorkflowDecision, WorkflowDefinition, WorkflowParameter } from "../../../shared/workflows";
import { WISP_HOME } from "../config";
import { runBounded } from "../subprocess";
import { isRecord } from "../validate";
import { BUILTIN_WORKFLOWS, COMMON_PARAMETERS, validateWorkflowParams } from "./definitions";

export const WORKFLOW_PLUGINS_PATH = join(WISP_HOME, "workflows.json");
export interface InstalledWorkflow { definition: WorkflowDefinition; command?: string[] }
export function workflowById(id: unknown): InstalledWorkflow | undefined {
  // A malformed custom registry must not stop already armed built-ins.
  const builtin = BUILTIN_WORKFLOWS.find(definition => definition.id === id);
  return builtin ? { definition: builtin } : installedWorkflows().find(p => p.definition.id === id);
}
export function installedWorkflows(path = WORKFLOW_PLUGINS_PATH): InstalledWorkflow[] {
  const builtins = BUILTIN_WORKFLOWS.map(definition => ({ definition }));
  if (!existsSync(path)) return builtins;
  if (statSync(path).size > 256_000) throw new Error("workflows.json exceeds 256 KB");
  const input: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(input) || input.length > 30) throw new Error("workflows.json must contain an array of at most 30 trusted plugins");
  const ids = new Set(builtins.map(p => p.definition.id));
  const plugins = input.map(raw => {
    if (!isRecord(raw) || raw.protocol !== 1 || typeof raw.id !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(raw.id) ||
      ids.has(raw.id) || typeof raw.name !== "string" || raw.name.length > 80 || typeof raw.description !== "string" ||
      raw.description.length > 1000 || typeof raw.version !== "string" || raw.version.length > 40 ||
      !Array.isArray(raw.command) || raw.command.length < 1 || raw.command.length > 20 ||
      !raw.command.every(v => typeof v === "string" && v.length < 4096) || !isAbsolute(raw.command[0])) throw new Error("Invalid workflow plugin manifest (protocol, identity, or absolute command)");
    ids.add(raw.id);
    const parameters = pluginParameters(raw.parameters ?? []);
    const version = `${raw.version}:${createHash("sha256").update(JSON.stringify(raw)).digest("hex").slice(0, 16)}`;
    const definition: WorkflowDefinition = { id: raw.id, name: raw.name, description: raw.description, version, parameters: [...parameters, ...COMMON_PARAMETERS], custom: true };
    return { definition, command: raw.command as string[] };
  });
  return [...builtins, ...plugins];
}
function pluginParameters(input: unknown): WorkflowParameter[] {
  if (!Array.isArray(input) || input.length > 20) throw new Error("Plugin parameters must be an array of at most 20 fields");
  const keys = new Set(COMMON_PARAMETERS.map(p => p.key));
  return input.map(p => {
    if (!isRecord(p) || typeof p.key !== "string" || !/^[a-zA-Z][a-zA-Z0-9]{0,63}$/.test(p.key) || keys.has(p.key) ||
      typeof p.label !== "string" || p.label.length > 80 || typeof p.description !== "string" || p.description.length > 1000 ||
      !["string", "number", "boolean"].includes(String(p.type)) || typeof p.default !== p.type ||
      (p.required !== undefined && typeof p.required !== "boolean") || (p.multiline !== undefined && typeof p.multiline !== "boolean") ||
      (p.min !== undefined && !Number.isSafeInteger(p.min)) || (p.max !== undefined && !Number.isSafeInteger(p.max))) throw new Error("Invalid plugin parameter");
    keys.add(p.key);
    const parameter = p as unknown as WorkflowParameter;
    validateWorkflowParams({ id: "custom", version: "1", name: "", description: "", parameters: [{ ...parameter, required: false }] }, {});
    return parameter;
  });
}
export function validateDecision(input: unknown): WorkflowDecision {
  if (!isRecord(input) || !["wait", "wake", "complete", "pause"].includes(String(input.action)) ||
    typeof input.reason !== "string" || !input.reason.trim() || input.reason.length > 1000 ||
    !isRecord(input.checkpoint) || Buffer.byteLength(JSON.stringify(input.checkpoint)) > 64_000) throw new Error("Invalid workflow result");
  if (input.action === "wake" && (typeof input.key !== "string" || !input.key || input.key.length > 256 ||
    typeof input.message !== "string" || !input.message.trim() || Buffer.byteLength(input.message) > 64_000)) throw new Error("Wake needs a stable key and a bounded message");
  return input as unknown as WorkflowDecision;
}
export async function evaluatePlugin(plugin: InstalledWorkflow, request: unknown, cwd: string, signal: AbortSignal): Promise<WorkflowDecision> {
  const result = await runBounded({ cmd: plugin.command!, cwd, env: { PWD: cwd }, input: JSON.stringify(request), signal, timeoutMs: 20_000, maxBytes: 100_000, maxErrorBytes: 2000 });
  if (result.exitCode !== 0 || result.timedOut || result.truncated || result.cancelled || result.cleanupError) throw new Error("Plugin check failed, timed out, or exceeded its output budget");
  return validateDecision(JSON.parse(result.out));
}
