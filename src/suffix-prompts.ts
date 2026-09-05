import { chmodSync, existsSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { SUFFIX_PROMPTS_PATH } from "./config";
import { isRecord, readUserJson, typeName } from "./validate";

export interface SuffixPrompt {
  id: string;
  name: string;
  prompt: string;
  createdAt: string;
}

interface SuffixPromptStore {
  version: 1;
  suffixPrompts: SuffixPrompt[];
}

export const SUFFIX_PROMPT_SEPARATOR = "\n\n\n";

/** A duplicate is a request conflict, unlike a malformed on-disk store. */
export class DuplicateSuffixPromptNameError extends Error {}

/**
 * Read the daemon-wide prompt library. The file is user-editable, so every
 * field is validated at the boundary rather than trusted deep in task launch.
 */
export function listSuffixPrompts(): SuffixPrompt[] {
  if (!existsSync(SUFFIX_PROMPTS_PATH)) return [];
  const raw = readUserJson(SUFFIX_PROMPTS_PATH);
  if (!isRecord(raw)) {
    throw new Error(`suffix-prompts.json: top level must be an object, got ${typeName(raw)}`);
  }
  if (raw.version !== 1) {
    throw new Error(`suffix-prompts.json: version must be 1, got ${JSON.stringify(raw.version)}`);
  }
  if (!Array.isArray(raw.suffixPrompts)) {
    throw new Error(
      `suffix-prompts.json: suffixPrompts must be an array, got ${typeName(raw.suffixPrompts)}`,
    );
  }

  const ids = new Set<string>();
  const names = new Set<string>();
  return raw.suffixPrompts.map((value, index) => {
    const label = `suffix-prompts.json: suffixPrompts[${index}]`;
    if (!isRecord(value)) throw new Error(`${label} must be an object, got ${typeName(value)}`);
    const stringField = (key: "id" | "name" | "prompt" | "createdAt"): string => {
      const field = value[key];
      if (typeof field !== "string") {
        throw new Error(`${label}.${key} must be a string, got ${typeName(field)}`);
      }
      if (field.trim() === "") throw new Error(`${label}.${key} must not be empty`);
      return field;
    };
    const prompt: SuffixPrompt = {
      id: stringField("id"),
      name: stringField("name"),
      prompt: stringField("prompt"),
      createdAt: stringField("createdAt"),
    };
    if (ids.has(prompt.id)) throw new Error(`${label}.id duplicates '${prompt.id}'`);
    const foldedName = prompt.name.toLowerCase();
    if (names.has(foldedName)) throw new Error(`${label}.name duplicates '${prompt.name}'`);
    ids.add(prompt.id);
    names.add(foldedName);
    return prompt;
  });
}

/** Save one prompt atomically, preserving creation order for the menu. */
export function createSuffixPrompt(name: string, prompt: string): SuffixPrompt {
  const cleanName = name.trim();
  const cleanPrompt = prompt.trim();
  const existing = listSuffixPrompts();
  if (existing.some((item) => item.name.toLowerCase() === cleanName.toLowerCase())) {
    throw new DuplicateSuffixPromptNameError(`a suffix prompt named '${cleanName}' already exists`);
  }
  const saved: SuffixPrompt = {
    id: crypto.randomUUID(),
    name: cleanName,
    prompt: cleanPrompt,
    createdAt: new Date().toISOString(),
  };
  writeStore({ version: 1, suffixPrompts: [...existing, saved] });
  return saved;
}

/**
 * Replace a prompt's editable fields, keeping its id and creation stamp so a
 * selected prompt survives being renamed. Null means the id is gone.
 */
export function updateSuffixPrompt(id: string, name: string, prompt: string): SuffixPrompt | null {
  const cleanName = name.trim();
  const cleanPrompt = prompt.trim();
  const existing = listSuffixPrompts();
  const index = existing.findIndex((item) => item.id === id);
  const current = existing[index];
  if (!current) return null;
  const collision = existing.some(
    (item) => item.id !== id && item.name.toLowerCase() === cleanName.toLowerCase(),
  );
  if (collision) {
    throw new DuplicateSuffixPromptNameError(`a suffix prompt named '${cleanName}' already exists`);
  }
  const saved: SuffixPrompt = { ...current, name: cleanName, prompt: cleanPrompt };
  const next = [...existing];
  next[index] = saved;
  writeStore({ version: 1, suffixPrompts: next });
  return saved;
}

/** Remove one prompt. False means the id was already gone. */
export function deleteSuffixPrompt(id: string): boolean {
  const existing = listSuffixPrompts();
  const next = existing.filter((item) => item.id !== id);
  if (next.length === existing.length) return false;
  writeStore({ version: 1, suffixPrompts: next });
  return true;
}

/**
 * Resolve at submission time so the daemon, not a browser cache, is the source
 * of truth. Null means the request referenced a prompt that no longer exists.
 */
export function promptWithSuffix(prompt: string, suffixPromptId: string | undefined): string | null {
  if (suffixPromptId === undefined) return prompt;
  const suffix = listSuffixPrompts().find((item) => item.id === suffixPromptId);
  return suffix ? `${prompt}${SUFFIX_PROMPT_SEPARATOR}${suffix.prompt}` : null;
}

function writeStore(store: SuffixPromptStore): void {
  const temp = `${SUFFIX_PROMPTS_PATH}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(store, null, 2) + "\n", { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, SUFFIX_PROMPTS_PATH);
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
  }
}
