import { existsSync } from "node:fs";
import { ADAPTERS_PATH } from "../config";
import { isRecord, readUserJson, stringArray, typeName } from "../validate";
import { liveCommandIssue } from "./live/command";
import { BUILTIN_ADAPTERS } from "./builtins";
import { ACTIVITY_NORMALIZERS } from "./activity";
import { MODEL_DISCOVERY } from "./discovery";
import { ERROR_STRATEGIES } from "./errors";
import { EVENT_FORMATTERS } from "./format";
import { IMAGE_DELIVERY_STRATEGIES, IMAGE_INPUT_STRATEGIES } from "./images";
import { COMPACT_STRATEGIES } from "./compact";
import { PARSE_STRATEGIES } from "./parse";
import { PROBE_STRATEGIES } from "./probe";
import { SKILL_STRATEGIES } from "./skills";
import type { AdapterDef } from "./types";
import { USAGE_FORMATTERS } from "./usage";

const LIVE_INPUT_STRATEGIES = {
  "claude-stream-json": true,
  "droid-jsonrpc": true,
  "codex-app-server": true,
} as const;

const ADAPTER_KEYS = [
  "bin",
  "auth",
  "exec",
  "resume",
  "model",
  "effort",
  "effortLevels",
  "staticModels",
  "defaultModel",
  "image",
  "imageInput",
  "imageDelivery",
  "liveInput",
  "allowEmptyResult",
  "parse",
  "events",
  "activity",
  "errors",
  "limitMarkers",
  "transientMarkers",
  "attach",
  "modelDiscovery",
  "usageFormat",
  "probe",
  "skillDiscovery",
  "compact",
  "compactPrompt",
] as const;
const PARSE_KEYS = ["format", "resultType", "result", "session", "needsInput", "model", "usage", "skills", "strategy"] as const;
const AUTH_KEYS = ["check", "fix", "success"] as const;
/** the field-mapping keys a named strategy replaces (it parses the stream itself, usage included) */
const PARSE_FIELD_KEYS = ["resultType", "result", "session", "needsInput", "model", "usage", "skills"] as const;

function namedStrategy(
  value: unknown,
  fieldLabel: string,
  registry: object,
  description: string,
  allowNull: true,
): string | null;
function namedStrategy(
  value: unknown,
  fieldLabel: string,
  registry: object,
  description: string,
  allowNull?: false,
): string;
function namedStrategy(
  value: unknown,
  fieldLabel: string,
  registry: object,
  description: string,
  allowNull = false,
): string | null {
  if (value === null && allowNull) return null;
  if (typeof value === "string" && value in registry) return value;
  const known = Object.keys(registry).join(", ");
  const got = typeof value === "string" ? JSON.stringify(value) : typeName(value);
  throw new Error(
    `${fieldLabel} must name a builtin ${description} (known: ${known})${allowNull ? " or null" : ""}, got ${got}`,
  );
}

function validateParse(name: string, raw: unknown, warn: (msg: string) => void): AdapterDef["parse"] {
  const label = `adapters.json: adapter '${name}'.parse`;
  if (!isRecord(raw)) throw new Error(`${label} must be an object, got ${typeName(raw)}`);
  for (const key of Object.keys(raw)) {
    if (!(PARSE_KEYS as readonly string[]).includes(key)) {
      warn(`${label}: unknown key '${key}' — ignoring (known: ${PARSE_KEYS.join(", ")})`);
    }
  }
  if (raw.format === undefined) throw new Error(`${label}.format is required ("json" or "text")`);
  if (raw.format !== "json" && raw.format !== "text") {
    const got = typeof raw.format === "string" ? JSON.stringify(raw.format) : typeName(raw.format);
    throw new Error(`${label}.format must be "json" or "text", got ${got}`);
  }
  const parse: AdapterDef["parse"] = { format: raw.format };
  for (const key of PARSE_FIELD_KEYS) {
    const v = raw[key];
    if (v === undefined) continue;
    if (typeof v !== "string") throw new Error(`${label}.${key} must be a string, got ${typeName(v)}`);
    parse[key] = v;
  }
  if (raw.strategy !== undefined) {
    const strategy = namedStrategy(raw.strategy, `${label}.strategy`, PARSE_STRATEGIES, "parse strategy");
    // a strategy owns the whole parse: silently ignoring a field mapping set
    // alongside it would hide a real misunderstanding of the adapter contract
    if (parse.format !== "json") {
      throw new Error(`${label}.strategy requires format "json", got ${JSON.stringify(parse.format)}`);
    }
    const conflicts = PARSE_FIELD_KEYS.filter((k) => raw[k] !== undefined);
    if (conflicts.length > 0) {
      throw new Error(
        `${label}.strategy ${JSON.stringify(raw.strategy)} parses the whole stream itself — remove ${conflicts.join(", ")}`,
      );
    }
    parse.strategy = strategy;
  }
  return parse;
}

function applyCoreFields(
  name: string,
  raw: Record<string, any>,
  builtin: AdapterDef | undefined,
  merged: AdapterDef,
  warn: (msg: string) => void,
): void {
  const label = `adapters.json: adapter '${name}'`;
  if (raw.bin === undefined) {
    if (!builtin) throw new Error(`${label} is missing required field 'bin' (must be a non-empty string)`);
  } else if (typeof raw.bin !== "string" || raw.bin === "") {
    const got = typeof raw.bin === "string" ? (raw.bin === "" ? '""' : "string") : typeName(raw.bin);
    throw new Error(`${label}.bin must be a non-empty string, got ${got}`);
  } else {
    merged.bin = raw.bin;
  }
  if (raw.exec === undefined) {
    if (!builtin) throw new Error(`${label} is missing required field 'exec' (must be an array of strings)`);
  } else {
    merged.exec = stringArray(raw.exec, `${label}.exec`);
  }
  if (raw.parse === undefined) {
    if (!builtin) {
      throw new Error(`${label} is missing required field 'parse' (must be an object with format "json" or "text")`);
    }
  } else {
    merged.parse = validateParse(name, raw.parse, warn);
  }
  if (raw.resume !== undefined) merged.resume = stringArray(raw.resume, `${label}.resume`);
  if (raw.model !== undefined) merged.model = stringArray(raw.model, `${label}.model`);
  if (raw.effort !== undefined) merged.effort = stringArray(raw.effort, `${label}.effort`);
  if (raw.effortLevels !== undefined) merged.effortLevels = stringArray(raw.effortLevels, `${label}.effortLevels`);
  if (raw.staticModels !== undefined) merged.staticModels = stringArray(raw.staticModels, `${label}.staticModels`);
  if (raw.defaultModel !== undefined) {
    if (typeof raw.defaultModel !== "string" || raw.defaultModel.length === 0) {
      throw new Error(`${label}.defaultModel must be a non-empty string, got ${typeName(raw.defaultModel)}`);
    }
    merged.defaultModel = raw.defaultModel;
  }
  if (merged.defaultModel !== undefined && !(merged.staticModels ?? []).includes(merged.defaultModel)) {
    throw new Error(
      `${label}.defaultModel '${merged.defaultModel}' is not in staticModels — the default must be one of the offered models`,
    );
  }
  if (raw.allowEmptyResult !== undefined) {
    if (typeof raw.allowEmptyResult !== "boolean") {
      throw new Error(`${label}.allowEmptyResult must be a boolean, got ${typeName(raw.allowEmptyResult)}`);
    }
    merged.allowEmptyResult = raw.allowEmptyResult;
  }
}

function applyAuthField(
  raw: Record<string, any>,
  merged: AdapterDef,
  label: string,
  warn: (msg: string) => void,
): void {
  if (raw.auth !== undefined) {
    if (raw.auth === null) {
      merged.auth = null;
    } else {
      const authLabel = `${label}.auth`;
      if (!isRecord(raw.auth)) throw new Error(`${authLabel} must be an object or null, got ${typeName(raw.auth)}`);
      for (const key of Object.keys(raw.auth)) {
        if (!(AUTH_KEYS as readonly string[]).includes(key)) {
          warn(`${authLabel}: unknown key '${key}' — ignoring (known: ${AUTH_KEYS.join(", ")})`);
        }
      }
      const check = stringArray(raw.auth.check, `${authLabel}.check`);
      if (check.length === 0) throw new Error(`${authLabel}.check must contain at least one argument`);
      if (typeof raw.auth.fix !== "string" || raw.auth.fix.length === 0) {
        throw new Error(`${authLabel}.fix must be a non-empty string, got ${typeName(raw.auth.fix)}`);
      }
      const success = raw.auth.success;
      if (success !== undefined && success !== "exit-zero" && success !== "json-ok") {
        throw new Error(`${authLabel}.success must be "exit-zero" or "json-ok", got ${JSON.stringify(success)}`);
      }
      merged.auth = { check, fix: raw.auth.fix, ...(success === undefined ? {} : { success }) };
    }
  }
}

function applyImageFields(raw: Record<string, any>, merged: AdapterDef, label: string): void {
  if (raw.image !== undefined) {
    if (raw.image === null) {
      merged.image = null;
    } else if (!Array.isArray(raw.image)) {
      throw new Error(`${label}.image must be an array of strings or null, got ${typeName(raw.image)}`);
    } else {
      merged.image = stringArray(raw.image, `${label}.image`);
      if (!merged.image.some((part) => part.includes("{path}"))) {
        throw new Error(`${label}.image must contain a {path} placeholder (e.g. ["-i", "{path}", "--"])`);
      }
    }
  }
  if (raw.imageInput !== undefined) {
    merged.imageInput = namedStrategy(
      raw.imageInput,
      `${label}.imageInput`,
      IMAGE_INPUT_STRATEGIES,
      "image-input strategy",
      true,
    );
  }
  if (raw.imageDelivery !== undefined) {
    merged.imageDelivery = namedStrategy(
      raw.imageDelivery,
      `${label}.imageDelivery`,
      IMAGE_DELIVERY_STRATEGIES,
      "image-delivery strategy",
      true,
    );
  }
  if (raw.liveInput !== undefined) {
    merged.liveInput = namedStrategy(
      raw.liveInput,
      `${label}.liveInput`,
      LIVE_INPUT_STRATEGIES,
      "live-input strategy",
      true,
    ) as AdapterDef["liveInput"];
  }
  const declared = (["image", "imageInput", "imageDelivery"] as const).filter((key) => merged[key] != null);
  if (declared.length > 1) {
    throw new Error(
      `${label}: ${declared.join(" and ")} are mutually exclusive — an argv template, a stdin-envelope strategy, OR a prompt-path delivery, not more than one`,
    );
  }
}

function applyEventFields(raw: Record<string, any>, merged: AdapterDef, label: string): void {
  if (raw.events !== undefined) {
    merged.events = namedStrategy(raw.events, `${label}.events`, EVENT_FORMATTERS, "event formatter");
  }
  if (raw.activity !== undefined) {
    merged.activity = namedStrategy(
      raw.activity,
      `${label}.activity`,
      ACTIVITY_NORMALIZERS,
      "activity normalizer",
      true,
    );
  }
  if (raw.errors !== undefined) {
    merged.errors = namedStrategy(raw.errors, `${label}.errors`, ERROR_STRATEGIES, "error strategy");
  }
  if (raw.limitMarkers !== undefined) merged.limitMarkers = stringArray(raw.limitMarkers, `${label}.limitMarkers`);
  if (raw.transientMarkers !== undefined) {
    merged.transientMarkers = stringArray(raw.transientMarkers, `${label}.transientMarkers`);
  }
  if (raw.attach !== undefined) {
    if (raw.attach === null) {
      merged.attach = null;
    } else if (!Array.isArray(raw.attach)) {
      throw new Error(`${label}.attach must be an array of strings or null, got ${typeName(raw.attach)}`);
    } else {
      merged.attach = stringArray(raw.attach, `${label}.attach`);
    }
  }
}

function applyDiscoveryFields(raw: Record<string, any>, merged: AdapterDef, label: string): void {
  if (raw.modelDiscovery !== undefined) {
    merged.modelDiscovery = namedStrategy(
      raw.modelDiscovery,
      `${label}.modelDiscovery`,
      MODEL_DISCOVERY,
      "model-discovery strategy",
      true,
    );
  }
  if (raw.usageFormat !== undefined) {
    merged.usageFormat = namedStrategy(
      raw.usageFormat,
      `${label}.usageFormat`,
      USAGE_FORMATTERS,
      "usage formatter",
    );
  }
  if (raw.probe !== undefined) {
    merged.probe = namedStrategy(raw.probe, `${label}.probe`, PROBE_STRATEGIES, "probe strategy");
  }
  if (raw.skillDiscovery !== undefined) {
    merged.skillDiscovery = namedStrategy(
      raw.skillDiscovery,
      `${label}.skillDiscovery`,
      SKILL_STRATEGIES,
      "skill-discovery strategy",
      true,
    );
  }
}

function applyCompactFields(raw: Record<string, any>, merged: AdapterDef, label: string): void {
  if (raw.compact !== undefined) {
    merged.compact = namedStrategy(
      raw.compact,
      `${label}.compact`,
      COMPACT_STRATEGIES,
      "compaction strategy",
      true,
    );
  }
  if (raw.compactPrompt !== undefined) {
    if (typeof raw.compactPrompt !== "string" || raw.compactPrompt.length === 0) {
      throw new Error(
        `${label}.compactPrompt must be a non-empty string (the harness's own compact command), got ${typeName(raw.compactPrompt)}`,
      );
    }
    merged.compactPrompt = raw.compactPrompt;
  }
  if (merged.compact && merged.compactPrompt) {
    throw new Error(
      `${label}: compact and compactPrompt are mutually exclusive — pick one (null the builtin's compact out first when overriding)`,
    );
  }
}

/**
 * Validate one user adapter def. When `builtin` exists the def is a partial
 * OVERRIDE (only provided fields are checked); a new adapter name must be
 * complete. Returns the merged, validated def — a fresh object, never a
 * mutated builtin.
 */
function validateAdapter(
  name: string,
  raw: unknown,
  builtin: AdapterDef | undefined,
  warn: (msg: string) => void,
): AdapterDef {
  const label = `adapters.json: adapter '${name}'`;
  if (!isRecord(raw)) throw new Error(`${label} must be an object, got ${typeName(raw)}`);
  for (const key of Object.keys(raw)) {
    if (!(ADAPTER_KEYS as readonly string[]).includes(key)) {
      warn(`${label}: unknown key '${key}' — ignoring (known: ${ADAPTER_KEYS.join(", ")})`);
    }
  }
  // required-field branches below throw before an incomplete new def can escape
  const merged: AdapterDef = builtin ? { ...builtin } : ({} as AdapterDef);
  if (
    builtin?.liveInput &&
    raw.liveInput === undefined &&
    (raw.bin !== undefined || raw.exec !== undefined)
  ) {
    merged.liveInput = null;
    warn(
      `${label}: overriding bin or exec disables inherited liveInput; set liveInput explicitly only after verifying the custom command's native protocol`,
    );
  }
  applyCoreFields(name, raw, builtin, merged, warn);
  applyAuthField(raw, merged, label, warn);
  applyImageFields(raw, merged, label);
  applyEventFields(raw, merged, label);
  applyDiscoveryFields(raw, merged, label);
  applyCompactFields(raw, merged, label);
  const liveIssue = liveCommandIssue(merged);
  if (liveIssue) {
    throw new Error(`${label}.liveInput '${merged.liveInput}' is incompatible with exec: ${liveIssue}`);
  }

  return merged;
}

/**
 * Validate user adapter defs and merge them over the builtins (a prior audit).
 * A malformed def throws at boot naming the adapter and field — never deep
 * inside parseOutput at turn-finalize time.
 *
 * Merge contract: a user def whose name matches a builtin is merged FIELD-WISE
 * over it — set only the fields you want to change; omitted fields keep the
 * builtin values. Every field replaces wholesale: arrays are not concatenated,
 * and `parse` is a single field (provide it whole or not at all). A user def
 * with a NEW name must be complete: bin, exec, and parse are required.
 * Example — tighten claude's permissions without restating the whole def:
 *   { "claude": { "exec": ["-p", "--output-format", "stream-json", "--verbose"] } }
 */
export function validateAdapters(
  raw: unknown,
  warn: (msg: string) => void = (m) => console.warn(m),
): Record<string, AdapterDef> {
  if (!isRecord(raw)) {
    throw new Error(`adapters.json: top level must be an object mapping adapter names to definitions, got ${typeName(raw)}`);
  }
  const out: Record<string, AdapterDef> = { ...BUILTIN_ADAPTERS };
  for (const [name, def] of Object.entries(raw)) {
    out[name] = validateAdapter(name, def, BUILTIN_ADAPTERS[name], warn);
  }
  return out;
}

export function loadAdapters(): Record<string, AdapterDef> {
  if (!existsSync(ADAPTERS_PATH)) return { ...BUILTIN_ADAPTERS };
  return validateAdapters(readUserJson(ADAPTERS_PATH));
}
