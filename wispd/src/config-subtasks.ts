/**
 * The subtask keys in config.json. Beside config.ts because that file is at
 * its size limit. None has a default written into config.json: an unset key
 * is read through the accessors below, so a later default needs no
 * migration of stored files.
 */
import type { WispConfig } from "./config";

export const SUBTASK_CONFIG_KEYS = ["maxRunningSubtasks", "maxSubtasks", "subtasks"] as const;

export interface SubtaskConfig {
  /** Unarchived non-reviewer children of one parent that may be starting or running a turn at once. Default 3. */
  maxRunningSubtasks?: number;
  /** Unarchived non-reviewer children one parent may have. Default 10. */
  maxSubtasks?: number;
  /**
   * `false` turns subtasks off: the daemon refuses every subtask field and
   * reports `features.subtasks: false`. On when unset. Wisp's own reviewers
   * are subtasks either way.
   */
  subtasks?: boolean;
}

export const runningSubtaskCap = (cfg: Pick<WispConfig, "maxRunningSubtasks">): number => cfg.maxRunningSubtasks ?? 3;
export const totalSubtaskCap = (cfg: Pick<WispConfig, "maxSubtasks">): number => cfg.maxSubtasks ?? 10;
export const subtasksEnabled = (cfg: Pick<WispConfig, "subtasks">): boolean => cfg.subtasks !== false;

/** The valid subtask keys of a raw config.json; a wrong one throws with its name, like every other key. */
export function subtaskConfig(raw: Record<string, unknown>): SubtaskConfig {
  const out: SubtaskConfig = {};
  for (const key of ["maxRunningSubtasks", "maxSubtasks"] as const) {
    const value = raw[key];
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(`config.json: ${key} must be a positive integer`);
    out[key] = value as number;
  }
  if (raw.subtasks !== undefined) {
    if (typeof raw.subtasks !== "boolean") throw new Error("config.json: subtasks must be true or false");
    out.subtasks = raw.subtasks;
  }
  return out;
}
