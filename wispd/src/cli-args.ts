interface Parsed {
  positional: string[];
  flags: Record<string, string | boolean | string[]>;
}
export type Flags = Parsed["flags"];

/** Everything else is boolean, so --force never eats a positional argument. */
const VALUE_FLAGS = new Set(["harness", "model", "effort", "timeout", "name", "setup", "archive", "base", "port", "confirm", "archived-before", "confirm-count"]);
const REPEAT_FLAGS = new Set(["attach", "image", "copy"]);
for (const flag of ["every", "pr", "prompt", "on-red", "on-green", "quiet-for", "lifetime", "max-wakeups", "reviewers", "exclude-authors", "params", "file"]) VALUE_FLAGS.add(flag);

export function parseArgs(args: string[]): Parsed {
  const positional: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (REPEAT_FLAGS.has(key) && next !== undefined) {
        const prior = flags[key];
        flags[key] = [...(Array.isArray(prior) ? prior : []), next];
        i++;
      } else if (VALUE_FLAGS.has(key) && next !== undefined) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else if (a.startsWith("-") && a.length > 1) {
      flags[a.slice(1)] = true;
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}
