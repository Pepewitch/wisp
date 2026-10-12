/**
 * A project's verification agent in config.json (`repos[].verify`): who
 * reviews its PRs under auto-review and sets up its recipe. Beside config.ts
 * because that file is at its size limit.
 */
import { isRecord, typeName } from "./validate";

export interface VerifyAgent {
  harness: string;
  model?: string;
  effort?: string;
}

/** The agent, normalized; undefined when unset or blank. Throws on a wrong shape, like every repos entry. */
export function validateVerifyAgent(raw: unknown, label: string): VerifyAgent | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) throw new Error(`${label} must be an object, got ${typeName(raw)}`);
  for (const key of ["harness", "model", "effort"] as const) {
    if (raw[key] !== undefined && typeof raw[key] !== "string") throw new Error(`${label}.${key} must be a string, got ${typeName(raw[key])}`);
  }
  const harness = typeof raw.harness === "string" ? raw.harness.trim() : "";
  if (harness === "") return undefined;
  const agent: VerifyAgent = { harness };
  if (typeof raw.model === "string" && raw.model.trim() !== "") agent.model = raw.model.trim();
  if (typeof raw.effort === "string" && raw.effort.trim() !== "") agent.effort = raw.effort.trim();
  return agent;
}
