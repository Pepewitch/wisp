import type { OutputStep } from "../../../shared/api/outputs";
import { outputStep } from "../outputs";
import { ACTIVITY_NORMALIZERS } from "./activity";
import { newNormalizeContext } from "./activity-context";
import { record, string } from "./activity-value";
import type { AdapterDef } from "./types";

const MAX_OPEN_STEPS = 256;
/** Enough of a command to find the file names it publishes. */
const MAX_COMMAND_CHARS = 8_192;

/** A started, unfinished command step and the command it runs. */
export interface OpenCommand {
  step: OutputStep;
  command: string;
}

/**
 * Follows a turn's command steps through the same normalizer the activity
 * timeline uses, so the step a published image names is a step the timeline
 * shows, under the same id. A step is a command step when its input carries a
 * `command` (Bash, Execute, codex's Run, opencode's bash). Steps the harness
 * gave no id cannot be matched later, so they are skipped. opencode reports a
 * tool only once it has finished, so it never has one running. Returns the
 * command steps open after `event`, oldest first.
 */
export function createRunningStepTracker(def: AdapterDef): ((event: Record<string, unknown>) => readonly OpenCommand[]) | null {
  const normalizer = def.activity ? ACTIVITY_NORMALIZERS[def.activity] : undefined;
  if (!normalizer) return null;
  const context = newNormalizeContext(() => "");
  const open = new Map<string, OpenCommand>();
  let current: readonly OpenCommand[] = [];
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
      if (!step || !command) continue;
      open.delete(activity.id);
      open.set(activity.id, { step, command: command.slice(0, MAX_COMMAND_CHARS) });
      if (open.size > MAX_OPEN_STEPS) open.delete(open.keys().next().value!);
      changed = true;
    }
    if (changed) current = [...open.values()];
    return current;
  };
}
