import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import type { AdapterDef } from "./adapters";
import { wispCommand } from "./command";
import { isRecord, readUserJson, stringArray, typeName } from "./validate";

/** Per-harness turn defaults (P5b): applied at task creation when the request passes no explicit value. */
export interface HarnessDefaults {
  model?: string;
  reasoningEffort?: string;
}

/**
 * A configured project. Beyond identity, this carries the three per-project
 * hooks the web UI's project settings edits — all of which apply to WORKTREE
 * tasks only, because they exist to make a fresh worktree usable and a local
 * task runs in the checkout the user is already working in.
 */
export interface RepoConfig {
  path: string;
  name?: string;
  /**
   * Shell run in a NEW worktree once it exists and files are copied in.
   * Runs IN ADDITION to a repo-committed .wisp/setup.sh (which goes first):
   * that one is the team's, this one is this machine's, and dropping either
   * would silently change behaviour for repos already relying on it.
   */
  setupScript?: string;
  /** Shell run in the worktree BEFORE it is removed at archive, after .wisp/cleanup.sh. */
  archiveScript?: string;
  /**
   * Glob patterns for untracked/ignored files copied from the repo into a new
   * worktree — the .env problem: git does not carry them, so a worktree cannot
   * run without them. A pattern with no "/" matches at ANY depth (".env*" also
   * takes "backend/.env"), which is what makes one line cover a monorepo.
   */
  copyFiles?: string[];
}

/** The configured entry for a repo path, if it has one. Paths are compared resolved. */
export function repoConfigFor(cfg: WispConfig, repoPath: string): RepoConfig | undefined {
  const target = resolvePath(repoPath);
  // callers include tests and tools holding a PARTIAL config; a missing repos
  // list means "nothing configured", never a crash inside worktree creation
  for (const entry of cfg.repos ?? []) {
    if (typeof entry === "string") {
      if (resolvePath(entry) === target) return { path: entry };
    } else if (resolvePath(entry.path) === target) {
      return entry;
    }
  }
  return undefined;
}

export interface WispConfig {
  port: number;
  host: string;
  token: string;
  webhooks: string[];
  /** repos offered in the web UI's new-task form (merged with the repo_paths of existing tasks by GET /api/repos) */
  repos: (string | RepoConfig)[];
  stuckMinutes: number;
  logMaxBytes: number;
  /** minutes .wisp/setup.sh may run before it's killed and the task fails loudly (a prior audit) */
  setupTimeoutMinutes: number;
  /** repo path or repo basename -> untracked files to copy into new worktrees (e.g. [".env"]) */
  envAllowlist: Record<string, string[]>;
  /**
   * harness name -> default model/effort for new tasks (P5b). An explicit
   * --model always wins. The motivating incident: dogfood tasks silently ran
   * on the most expensive claude model because nothing pinned one.
   */
  harnessDefaults: Record<string, HarnessDefaults>;
}

export const WISP_HOME = process.env.WISP_HOME ?? join(homedir(), ".wisp");
export const LOG_DIR = join(WISP_HOME, "logs");
export const WORKTREE_ROOT = join(WISP_HOME, "worktrees");
/** per-turn image attachments live at tasks/<id>/attachments/turn-<n>/ (S3; dirs are created at write time) */
export const TASKS_DIR = join(WISP_HOME, "tasks");
export const DB_PATH = join(WISP_HOME, "wisp.db");
export const CONFIG_PATH = join(WISP_HOME, "config.json");
export const ADAPTERS_PATH = join(WISP_HOME, "adapters.json");
export const SUFFIX_PROMPTS_PATH = join(WISP_HOME, "suffix-prompts.json");

mkdirSync(WISP_HOME, { recursive: true, mode: 0o700 });
chmodSync(WISP_HOME, 0o700);
mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
mkdirSync(WORKTREE_ROOT, { recursive: true, mode: 0o700 });

const DEFAULTS: WispConfig = {
  port: 8710,
  host: "127.0.0.1",
  token: "",
  webhooks: [],
  repos: [],
  stuckMinutes: 10,
  logMaxBytes: 5_000_000,
  setupTimeoutMinutes: 10,
  envAllowlist: {},
  harnessDefaults: {},
};

const CONFIG_KEYS = [
  "port",
  "host",
  "token",
  "webhooks",
  "repos",
  "stuckMinutes",
  "logMaxBytes",
  "setupTimeoutMinutes",
  "envAllowlist",
  "harnessDefaults",
] as const;

export const MIN_CONFIGURED_PORT = 1024;
export const MAX_CONFIGURED_PORT = 65535;
export const PREFERRED_PORT = 8710;
export const FALLBACK_PORT_END = 8799;

export type PortAvailable = (host: string, port: number) => boolean;

function assertPort(port: number, label = "config.json: port"): void {
  if (!Number.isInteger(port) || port < MIN_CONFIGURED_PORT || port > MAX_CONFIGURED_PORT) {
    throw new Error(
      `${label} must be an integer from ${MIN_CONFIGURED_PORT} to ${MAX_CONFIGURED_PORT}, got ${JSON.stringify(port)}`,
    );
  }
}

/** A short-lived bind is the only reliable cross-platform answer to “is this loopback port free?”. */
function loopbackPortAvailable(host: string, port: number): boolean {
  try {
    const listener = Bun.listen({
      hostname: host,
      port,
      socket: { data() {} },
    });
    listener.stop(true);
    return true;
  } catch {
    return false;
  }
}

/**
 * Select only while creating a brand-new config. A persisted port is authority
 * and never comes through this function again.
 */
export function selectInitialPort(
  requestedPort?: number,
  available: PortAvailable = loopbackPortAvailable,
): number {
  if (requestedPort !== undefined) {
    assertPort(requestedPort, "initial port");
    if (available(DEFAULTS.host, requestedPort)) return requestedPort;
    throw new Error(
      `initial port ${DEFAULTS.host}:${requestedPort} is already in use; choose another with '${wispCommand()} init --port <port>'`,
    );
  }
  for (let port = PREFERRED_PORT; port <= FALLBACK_PORT_END; port++) {
    if (available(DEFAULTS.host, port)) return port;
  }
  throw new Error(
    `no available loopback port from ${PREFERRED_PORT} through ${FALLBACK_PORT_END}; choose one with '${wispCommand()} init --port <port>'`,
  );
}

/**
 * Shape-check config.json at load (a prior audit): a wrong-typed value must
 * throw at boot with a named field ("config.json: port must be a number, got
 * string"), not surface deep in a request. Unknown keys warn — a typo'd key
 * silently falling back to its default is the same class of silent failure.
 * Returns only the recognized keys, ready to spread over DEFAULTS.
 */
export function validateConfig(raw: unknown, warn: (msg: string) => void = (m) => console.warn(m)): Partial<WispConfig> {
  if (!isRecord(raw)) throw new Error(`config.json: top level must be an object, got ${typeName(raw)}`);
  for (const key of Object.keys(raw)) {
    if (!(CONFIG_KEYS as readonly string[]).includes(key)) {
      warn(`config.json: unknown key '${key}' — ignoring (known: ${CONFIG_KEYS.join(", ")})`);
    }
  }
  const out: Partial<WispConfig> = {};
  const num = (key: "port" | "stuckMinutes" | "logMaxBytes" | "setupTimeoutMinutes"): void => {
    const v = raw[key];
    if (v === undefined) return;
    if (typeof v !== "number") throw new Error(`config.json: ${key} must be a number, got ${typeName(v)}`);
    if (key === "port") assertPort(v);
    out[key] = v;
  };
  const str = (key: "host" | "token"): void => {
    const v = raw[key];
    if (v === undefined) return;
    if (typeof v !== "string") throw new Error(`config.json: ${key} must be a string, got ${typeName(v)}`);
    out[key] = v;
  };
  num("port");
  str("host");
  str("token");
  if (raw.webhooks !== undefined) out.webhooks = stringArray(raw.webhooks, "config.json: webhooks");
  if (raw.repos !== undefined) out.repos = validateRepos(raw.repos);
  num("stuckMinutes");
  num("logMaxBytes");
  num("setupTimeoutMinutes");
  if (raw.envAllowlist !== undefined) {
    if (!isRecord(raw.envAllowlist)) {
      throw new Error(
        `config.json: envAllowlist must be an object mapping repo names to arrays of strings, got ${typeName(raw.envAllowlist)}`,
      );
    }
    const allow: Record<string, string[]> = {};
    for (const [repo, files] of Object.entries(raw.envAllowlist)) {
      allow[repo] = stringArray(files, `config.json: envAllowlist['${repo}']`);
    }
    out.envAllowlist = allow;
  }
  if (raw.harnessDefaults !== undefined) {
    const defaults = validateHarnessDefaults(raw.harnessDefaults, warn);
    if (defaults) out.harnessDefaults = defaults;
  }
  return out;
}

function validateRepos(raw: unknown): (string | RepoConfig)[] {
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
    for (const key of ["setupScript", "archiveScript"] as const) {
      if (entry[key] !== undefined && typeof entry[key] !== "string") {
        throw new Error(`${label}.${key} must be a string, got ${typeName(entry[key])}`);
      }
    }
    const out: RepoConfig = { path: entry.path };
    if (entry.name !== undefined) out.name = entry.name;
    if (typeof entry.setupScript === "string" && entry.setupScript !== "") out.setupScript = entry.setupScript;
    if (typeof entry.archiveScript === "string" && entry.archiveScript !== "") out.archiveScript = entry.archiveScript;
    if (entry.copyFiles !== undefined) {
      const patterns = stringArray(entry.copyFiles, `${label}.copyFiles`).filter((v) => v.trim() !== "");
      if (patterns.length > 0) out.copyFiles = patterns;
    }
    return out;
  });
}

/**
 * harnessDefaults is the ONE config block whose problems warn instead of
 * throwing (P5b — this fallback behavior is itself the requirement): a config
 * written for an older or newer wisp — naming a harness this build doesn't
 * have, or carrying a field from another version — must never brick the
 * daemon. Anything unusable is warned about and dropped; the rest applies.
 */
function validateHarnessDefaults(
  raw: unknown,
  warn: (msg: string) => void,
): Record<string, HarnessDefaults> | null {
  const shape = "an object mapping harness names to defaults ({ model, reasoningEffort })";
  if (!isRecord(raw)) {
    warn(`config.json: harnessDefaults must be ${shape}, got ${typeName(raw)} — ignoring it`);
    return null; // dropped entirely, as if the key were absent
  }
  const out: Record<string, HarnessDefaults> = {};
  for (const [harness, entry] of Object.entries(raw)) {
    if (!isRecord(entry)) {
      warn(`config.json: harnessDefaults['${harness}'] must be an object of defaults ({ model, reasoningEffort }), got ${typeName(entry)} — ignoring it`);
      continue;
    }
    const defaults: HarnessDefaults = {};
    for (const [key, value] of Object.entries(entry)) {
      if (key !== "model" && key !== "reasoningEffort") {
        warn(`config.json: harnessDefaults['${harness}']: unknown key '${key}' — ignoring (known: model, reasoningEffort)`);
        continue;
      }
      if (typeof value !== "string") {
        warn(`config.json: harnessDefaults['${harness}'].${key} must be a string, got ${typeName(value)} — ignoring it`);
        continue;
      }
      defaults[key] = value;
    }
    out[harness] = defaults;
  }
  return out;
}

/**
 * Loud fallback, part 2 (P5b): shape is checked in validateHarnessDefaults at
 * config load, but only the daemon knows the merged adapter set — so this
 * runs at boot and warns (never crashes) about defaults that can never do
 * anything: an entry naming an adapter wisp doesn't know, or a knob the
 * adapter has no argv template for. Task creation rejects an effective effort
 * default without an adapter template, so the value is never silently lost.
 */
export function checkHarnessDefaults(
  cfg: WispConfig,
  adapters: Record<string, AdapterDef>,
  warn: (msg: string) => void = (m) => console.warn(m),
): void {
  for (const [harness, defaults] of Object.entries(cfg.harnessDefaults)) {
    const def = adapters[harness];
    if (!def) {
      warn(
        `config.json: harnessDefaults['${harness}'] names an adapter Wisp doesn't know (loaded: ${Object.keys(adapters).join(", ")}) — ignoring it`,
      );
      continue;
    }
    if (defaults.model !== undefined && !def.model) {
      warn(
        `config.json: harnessDefaults['${harness}'].model is set, but the '${harness}' adapter has no model template — it is recorded on tasks but never reaches the harness`,
      );
    }
    if (defaults.reasoningEffort !== undefined && !def.effort) {
      warn(
        `config.json: harnessDefaults['${harness}'].reasoningEffort is set, but the '${harness}' adapter has no effort template — task creation will reject this default instead of silently dropping it`,
      );
    }
  }
}

/**
 * What a new task runs on (P5b): explicit model/effort values win; otherwise
 * the config's per-harness defaults apply; otherwise null means the harness's
 * own default. Snapshotted onto the task row at creation, like model.
 */
export function resolveHarnessDefaults(
  cfg: WispConfig,
  harness: string,
  requestedModel?: string,
  requestedEffort?: string,
): { model: string | null; effort: string | null } {
  const defaults = cfg.harnessDefaults[harness];
  return {
    model: requestedModel ?? defaults?.model ?? null,
    effort: requestedEffort ?? defaults?.reasoningEffort ?? null,
  };
}

export interface LoadConfigOptions {
  /** Applies only while creating a new config. Existing persisted ports always win. */
  initialPort?: number;
  /** Test seam for deterministic first-run selection. */
  portAvailable?: PortAvailable;
}

export function loadConfig(options: LoadConfigOptions = {}): WispConfig {
  let stored: Partial<WispConfig> = {};
  const configExists = existsSync(CONFIG_PATH);
  if (configExists) {
    stored = validateConfig(readUserJson(CONFIG_PATH));
    chmodSync(CONFIG_PATH, 0o600); // holds the bearer token; repair older installs
  }
  const cfg: WispConfig = { ...DEFAULTS, ...stored };
  if (!configExists) {
    cfg.port = selectInitialPort(options.initialPort, options.portAvailable);
  }
  if (!cfg.token) {
    // First run (no config file, or one written without a token): mint a token
    // and persist the merged defaults so the file documents every knob.
    cfg.token = crypto.randomUUID().replaceAll("-", "");
    writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  }
  return cfg;
}
