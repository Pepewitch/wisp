import type { OutputStep } from "../../../shared/api/outputs";
import { outputStep } from "../outputs";
import { ACTIVITY_NORMALIZERS } from "./activity";
import { newNormalizeContext } from "./activity-context";
import { record, string } from "./activity-value";
import type { AdapterDef } from "./types";

const MAX_OPEN_STEPS = 256;

/**
 * Follows a turn's command steps through the same normalizer the activity
 * timeline uses, so the step a published image names is a step the timeline
 * shows, under the same id. A step is a command step when its input carries a
 * `command` (Bash, Execute, codex's Run, cursor's shell, opencode's bash).
 * Steps the harness gave no id cannot be matched later, so they are skipped.
 * opencode reports a tool only once it has finished, so it never has one
 * running. Returns the latest started, unfinished command step after `event`.
 */
export function createRunningStepTracker(def: AdapterDef): ((event: Record<string, unknown>) => OutputStep | null) | null {
  const normalizer = def.activity ? ACTIVITY_NORMALIZERS[def.activity] : undefined;
  if (!normalizer) return null;
  const context = newNormalizeContext(() => "");
  const open = new Map<string, OutputStep>();
  let latest: OutputStep | null = null;
  return (event) => {
    let changed = false;
    for (const activity of normalizer(event, context)) {
      if (activity.kind !== "tool" || !activity.id) continue;
      if (activity.phase === "completed") {
        changed = open.delete(activity.id) || changed;
        continue;
      }
      const command = string(record(activity.input).command);
      const step = command ? outputStep(activity.id, command) : null;
      if (!step) continue;
      open.delete(activity.id);
      open.set(activity.id, step);
      if (open.size > MAX_OPEN_STEPS) open.delete(open.keys().next().value!);
      changed = true;
    }
    if (changed) latest = [...open.values()].at(-1) ?? null;
    return latest;
  };
}
