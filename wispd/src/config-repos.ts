/**
 * `repos` in config.json: the projects Wisp offers, each a path or an object
 * with its settings. Beside config.ts because that file is at its size limit.
 */
import type { RepoConfig } from "./config";
import { validateCapturePublic, validateVerifyAgent } from "./config-verify";
import { isRecord, stringArray, typeName } from "./validate";

export function validateRepos(raw: unknown): (string | RepoConfig)[] {
  if (!Array.isArray(raw)) throw new Error(`config.json: repos must be an array of strings, got ${typeName(raw)}`);
  return raw.map((entry, index) => {
    const label = `config.json: repos[${index}]`;
    if (typeof entry === "string") return entry;
    if (!isRecord(entry)) {
      throw new Error(`${label} must be a string, got ${typeName(entry)}`);
    }
    if (typeof entry.path !== "string") {
      throw new Error(`${label}.path must be a string, got ${typeName(entry.path)}`);
    }
    if (entry.name !== undefined && typeof entry.name !== "string") {
      throw new Error(`${label}.name must be a string, got ${typeName(entry.name)}`);
    }
    for (const key of ["setupScript", "archiveScript", "baseBranch"] as const) {
      if (entry[key] !== undefined && typeof entry[key] !== "string") {
        throw new Error(`${label}.${key} must be a string, got ${typeName(entry[key])}`);
      }
    }
    const out: RepoConfig = { path: entry.path };
    if (entry.name !== undefined) out.name = entry.name;
    if (typeof entry.setupScript === "string" && entry.setupScript !== "") out.setupScript = entry.setupScript;
    if (typeof entry.archiveScript === "string" && entry.archiveScript !== "") out.archiveScript = entry.archiveScript;
    if (typeof entry.baseBranch === "string" && entry.baseBranch.trim() !== "") out.baseBranch = entry.baseBranch.trim();
    if (entry.copyFiles !== undefined) {
      const patterns = stringArray(entry.copyFiles, `${label}.copyFiles`).filter((v) => v.trim() !== "");
      if (patterns.length > 0) out.copyFiles = patterns;
    }
    const verify = validateVerifyAgent(entry.verify, `${label}.verify`);
    if (verify) out.verify = verify;
    const second = entry.verifySecond === "off" ? "off" : validateVerifyAgent(entry.verifySecond, `${label}.verifySecond`);
    if (second) out.verifySecond = second;
    const fallback = validateVerifyAgent(entry.verifyFallback, `${label}.verifyFallback`);
    if (fallback) out.verifyFallback = fallback;
    const secondFallback = validateVerifyAgent(entry.verifySecondFallback, `${label}.verifySecondFallback`);
    if (secondFallback) out.verifySecondFallback = secondFallback;
    if (validateCapturePublic(entry.capturePublic, label) === false) out.capturePublic = false;
    return out;
  });
}
