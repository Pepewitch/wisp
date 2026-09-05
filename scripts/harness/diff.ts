/**
 * Turning a facts diff into a verdict.
 *
 * The question this answers is the expensive one: a harness CLI updated — does
 * it matter? An empty diff means the update is irrelevant to Wisp no matter
 * how loud its release notes are. A non-empty diff is graded so the reader
 * knows, without opening the guide, whether this is a twenty-minute catalog
 * edit or a wire-shape break.
 *
 * Severity is direction-dependent, because the same surface hurts differently
 * depending on which way it moved: a flag Wisp passes disappearing is a broken
 * turn, a new flag appearing is an opportunity.
 */
import type { AdapterDef } from "../../src/adapters";
import type { HarnessFacts, Surface } from "./facts";

/**
 * - `breaking`   a surface Wisp depends on moved; turns will fail until fixed
 * - `catalog`    models / effort levels changed; cheap edit, user-visible
 * - `capability` something new Wisp could adopt; never urgent
 * - `cosmetic`   observed, depended on by nothing
 */
export type Severity = "breaking" | "catalog" | "capability" | "cosmetic";

export const SEVERITY_ORDER: Severity[] = ["breaking", "catalog", "capability", "cosmetic"];

export interface Change {
  surface: string;
  key: string;
  direction: "added" | "removed" | "changed";
  values: string[];
  severity: Severity;
  /** Present when a rule escalated this change; explains why, in one line. */
  reason?: string;
}

/** How each surface grades, per direction. Unlisted surfaces are cosmetic. */
const GRADES: Record<string, { added: Severity; removed: Severity }> = {
  models: { added: "catalog", removed: "catalog" },
  effortLevels: { added: "catalog", removed: "catalog" },
  flags: { added: "capability", removed: "breaking" },
  markerPresence: { added: "cosmetic", removed: "cosmetic" },
};

function grade(surface: string, direction: "added" | "removed" | "changed"): Severity {
  const rule = GRADES[surface];
  if (!rule) return "cosmetic";
  if (direction === "changed") return rule.added === "catalog" ? "catalog" : "capability";
  return rule[direction];
}

function diffSurface(name: string, before: Surface | undefined, after: Surface): Change[] {
  const changes: Change[] = [];
  for (const [key, values] of Object.entries(after.lists ?? {})) {
    const previous = new Set(before?.lists?.[key] ?? []);
    const current = new Set(values);
    // a surface that did not exist before is a first capture, not a change
    if (!before?.lists?.[key]) continue;
    const added = [...current].filter((v) => !previous.has(v)).sort();
    const removed = [...previous].filter((v) => !current.has(v)).sort();
    if (added.length > 0) changes.push({ surface: name, key, direction: "added", values: added, severity: grade(name, "added") });
    if (removed.length > 0) {
      changes.push({ surface: name, key, direction: "removed", values: removed, severity: grade(name, "removed") });
    }
  }
  for (const [key, value] of Object.entries(after.scalars ?? {})) {
    const previous = before?.scalars?.[key];
    if (previous === undefined || previous === value) continue;
    changes.push({
      surface: name,
      key,
      direction: "changed",
      values: [`${previous ?? "none"} → ${value ?? "none"}`],
      severity: grade(name, "changed"),
    });
  }
  return changes;
}

/**
 * Cross-reference a change against what the adapter actually asserts, and
 * escalate when the two now contradict. This is what turns "the catalog moved"
 * into "a model Wisp offers no longer exists" — the difference between a note
 * and a bug.
 */
function escalate(change: Change, def: AdapterDef): Change {
  if (change.surface === "models" && change.direction === "removed") {
    const pinned = change.values.filter((id) => def.staticModels?.includes(id));
    if (pinned.length > 0) {
      return {
        ...change,
        severity: "breaking",
        reason: `staticModels still offers ${pinned.join(", ")} — a task picking one fails pre-flight`,
      };
    }
  }
  if (change.surface === "flags" && change.direction === "removed") {
    const used = change.values.filter((flag) => adapterFlags(def).includes(flag));
    if (used.length > 0) {
      return { ...change, severity: "breaking", reason: `Wisp passes ${used.join(", ")} on every turn` };
    }
    return { ...change, severity: "capability", reason: "Wisp does not pass these" };
  }
  if (change.surface === "markerPresence" && change.key === "missing" && change.direction === "added") {
    return { ...change, severity: "breaking", reason: "these markers can no longer fire — the failure they classify is now unrecognised" };
  }
  return change;
}

/** Every flag token the adapter itself passes, across all its argv templates. */
export function adapterFlags(def: AdapterDef): string[] {
  const templates = [def.exec, def.resume, def.model, def.effort, def.image, def.attach];
  const flags = new Set<string>();
  for (const template of templates) {
    for (const token of template ?? []) {
      if (/^-{1,2}[a-zA-Z]/.test(token)) flags.add(token);
    }
  }
  return [...flags].sort();
}

export function diffFacts(before: HarnessFacts | null, after: HarnessFacts, def: AdapterDef): Change[] {
  const changes: Change[] = [];
  for (const [name, surface] of Object.entries(after.surfaces)) {
    if (surface.cost !== "free") continue; // live surfaces are pins, never re-read
    changes.push(...diffSurface(name, before?.surfaces[name], surface).map((c) => escalate(c, def)));
  }
  return changes.sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));
}

export function worstSeverity(changes: Change[]): Severity | null {
  for (const severity of SEVERITY_ORDER) {
    if (changes.some((c) => c.severity === severity)) return severity;
  }
  return null;
}
