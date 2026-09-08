import { readFileSync } from "node:fs";
import { basename } from "node:path";

/**
 * Hand-rolled validation for user-supplied JSON (a prior audit) — zero deps on
 * purpose. The contract: a malformed config/adapters file fails at BOOT with a
 * named, actionable error, never deep inside a request. Every message names
 * the file and the field, e.g. "config.json: port must be a number, got string".
 */

/** JSON-flavored type name for error messages ("array" and "null" instead of "object"). */
export function typeName(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

/** A plain JSON object (not null, not an array). */
export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Read + parse a user JSON file; syntax errors name the file, not just the parser. */
export function readUserJson(path: string): unknown {
  const text = readFileSync(path, "utf8");
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`${basename(path)}: invalid JSON — ${e instanceof Error ? e.message : e}`, { cause: e });
  }
}

/**
 * Throw unless v is an array of strings. label is the full message prefix
 * ("config.json: webhooks", "adapters.json: adapter 'x'.exec") so element
 * errors come out as "<label>[2] must be a string, got number".
 */
export function stringArray(v: unknown, label: string): string[] {
  if (!Array.isArray(v)) throw new Error(`${label} must be an array of strings, got ${typeName(v)}`);
  for (let i = 0; i < v.length; i++) {
    if (typeof v[i] !== "string") throw new Error(`${label}[${i}] must be a string, got ${typeName(v[i])}`);
  }
  return v;
}
