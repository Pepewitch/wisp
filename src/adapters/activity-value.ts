import { trunc } from "../text";
import { isRecord } from "../validate";

interface ProjectionBudget {
  chars: number;
  nodes: number;
  stringChars?: number;
}

function boundedValue(
  value: unknown,
  budget: ProjectionBudget,
  seen = new WeakSet<object>(),
  depth = 0,
): unknown {
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") {
    const limit = Math.max(0, Math.min(value.length, budget.chars, budget.stringChars ?? Number.POSITIVE_INFINITY));
    budget.chars -= limit;
    return trunc(value, limit);
  }
  if (value === undefined) return null;
  if (typeof value !== "object") return trunc(String(value), Math.max(0, budget.chars));
  if (budget.nodes-- <= 0 || budget.chars <= 0) return "…";
  if (seen.has(value)) return "[circular]";
  if (depth >= 4) return "[nested data omitted]";
  seen.add(value);

  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (let index = 0; index < value.length && index < 32 && budget.chars > 0; index++) {
      out.push(boundedValue(value[index], budget, seen, depth + 1));
    }
    if (value.length > out.length) out.push(`… ${value.length - out.length} more items`);
    seen.delete(value);
    return out;
  }

  const out: Record<string, unknown> = {};
  let count = 0;
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue;
    if (count >= 32 || budget.chars <= 0) {
      out["…"] = "Additional fields omitted";
      break;
    }
    count++;
    budget.chars = Math.max(0, budget.chars - key.length);
    out[key] = boundedValue((value as Record<string, unknown>)[key], budget, seen, depth + 1);
  }
  seen.delete(value);
  return out;
}

function boundedJson(value: unknown, chars: number): string {
  try {
    return trunc(JSON.stringify(boundedValue(value, { chars, nodes: 128 })), chars);
  } catch {
    return trunc(String(value), chars);
  }
}

export function text(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (Array.isArray(value)) {
    const parts: string[] = [];
    let remaining = 4_000;
    for (let index = 0; index < value.length && index < 64 && remaining > 0; index++) {
      const part = value[index];
      const item = isRecord(part) ? part : {};
      const next =
        typeof part === "string"
          ? part
          : (typeof item.text === "string" && item.text.trim()) ||
            (typeof item.content === "string" && item.content.trim()) ||
            "";
      if (!next) continue;
      const projected = trunc(next, remaining);
      parts.push(projected);
      remaining -= projected.length;
    }
    const joined = parts.join("\n").trim();
    return joined ? trunc(joined, 4_000) : null;
  }
  if (value === null || value === undefined) return null;
  return boundedJson(value, 4_000);
}

export function boundedInput(value: unknown): unknown {
  if (typeof value === "string") return trunc(value, 4_000);
  return boundedValue(value, { chars: 4_000, nodes: 128, stringChars: 2_000 });
}
