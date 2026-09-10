import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { arch, platform } from "node:os";
import { BUILTIN_ADAPTERS, loadAdapters, validateAdapters, type AdapterDef } from "./adapters";
import { wispCommand, type WispCommand } from "./command";
import { ADAPTERS_PATH, CONFIG_PATH, DB_PATH, loadConfig, validateConfig, type WispConfig } from "./config";
import { assertExecutableAllowed } from "./launch-policy";
import { integrityProblems, SCHEMA_VERSION } from "./migrations";
import { ALLOWED_ORIGINS_ENV } from "./routes/auth";
import { trunc } from "./text";
import { readUserJson } from "./validate";
import { BUILD_COMMIT, BUILD_DIRTY, VERSION } from "./version";

const COMMAND = wispCommand();

/**
 * Activation-oriented self-check. A compiled-binary user does not need Bun,
 * one installed and authenticated harness is sufficient, and the final line
 * is a concise receipt naming any blockers or the first-task handoff.
 */
export type CheckStatus = "ok" | "warn" | "fail";

export interface DoctorCheck {
  name: string;
  status: CheckStatus;
  message: string;
}

const ok = (name: string, message: string): DoctorCheck => ({ name, status: "ok", message });
const warn = (name: string, message: string): DoctorCheck => ({ name, status: "warn", message });
const fail = (name: string, message: string): DoctorCheck => ({ name, status: "fail", message });

export interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Throws when the executable itself is absent, matching Bun.spawnSync. */
export type SpawnFn = (cmd: string[]) => SpawnResult;

export const bunSpawn: SpawnFn = (cmd) => {
  // `wisp doctor` and `wisp models` run the installed harness (`claude
  // --version`, auth probes), so this is a provider-CLI launch and belongs
  // behind the same gate as the runner's and the probes' (a review: the
  // launch-policy header claimed to cover "every provider CLI" while this one
  // was ungated). Daemon tests inject a fake `spawn`, so nothing in the suite
  // depended on it being open.
  assertExecutableAllowed(cmd, "doctor harness probe");
  const res = Bun.spawnSync({ cmd, stdout: "pipe", stderr: "pipe" });
  return { exitCode: res.exitCode, stdout: res.stdout.toString().trim(), stderr: res.stderr.toString().trim() };
};

const firstLine = (s: string): string => s.split("\n")[0]?.trim() ?? "";
const quote = (value: string): string => (/^[A-Za-z0-9_./:@+-]+$/.test(value) ? value : JSON.stringify(value));
const command = (parts: string[]): string => parts.map(quote).join(" ");

export function parseVersion(output: string): string | null {
  const match = output.match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/);
  return match ? match[0] : null;
}

export function checkPlatform(
  currentPlatform: NodeJS.Platform = platform(),
  currentArch: string = arch(),
): DoctorCheck {
  if (currentPlatform === "linux" && currentArch === "x64") {
    return ok("platform", "Linux x86_64 (supported v1.0 target: Ubuntu 24.04 LTS)");
  }
  if (currentPlatform === "darwin" && currentArch === "arm64") {
    return ok(
      "platform",
      "macOS Apple Silicon arm64 (experimental v0.4 target; qualification baseline: macOS 26.6.2)",
    );
  }
  if (currentPlatform === "darwin") {
    return fail("platform", `macOS ${currentArch} is unsupported; Wisp provides no Intel Mac artifact`);
  }
  return fail(
    "platform",
    `${currentPlatform} ${currentArch} is unsupported; use Linux x86_64 or Apple Silicon macOS`,
  );
}

export function checkHarness(
  name: string,
  def: AdapterDef,
  spawn: SpawnFn,
  required = true,
): DoctorCheck {
  const finding = required ? fail : warn;
  const check = `harness ${name}`;
  let result: SpawnResult;
  try {
    result = spawn([def.bin, "--version"]);
  } catch {
    return finding(
      check,
      `'${def.bin}' not found on PATH — install it for --harness ${name}, or select another installed harness`,
    );
  }
  if (result.exitCode !== 0) {
    const detail = firstLine(result.stderr) || firstLine(result.stdout);
    return finding(
      check,
      `'${def.bin} --version' exited ${result.exitCode}${detail ? ` — ${trunc(detail, 120)}` : ""}`,
    );
  }
  const version = parseVersion(result.stdout) ?? firstLine(result.stdout);
  return ok(check, version ? `${def.bin} ${trunc(version, 80)}` : `${def.bin} on PATH`);
}

export function checkHarnessAuth(
  name: string,
  def: AdapterDef,
  spawn: SpawnFn,
  required = true,
): DoctorCheck {
  const finding = required ? fail : warn;
  const check = `harness ${name} auth`;
  if (!def.auth) {
    return warn(check, "adapter declares no non-billing auth probe; verify authentication with the harness itself");
  }
  const argv = [def.bin, ...def.auth.check];
  let result: SpawnResult;
  try {
    result = spawn(argv);
  } catch {
    return finding(check, `could not run '${command(argv)}' — ${def.auth.fix}`);
  }
  if (result.exitCode !== 0) {
    return finding(check, `'${command(argv)}' says authentication is not ready — ${def.auth.fix}`);
  }
  if (def.auth.success === "json-ok") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      return finding(check, `'${command(argv)}' returned invalid JSON — rerun it directly, then ${def.auth.fix}`);
    }
    if (!parsed || typeof parsed !== "object" || (parsed as { ok?: unknown }).ok !== true) {
      return finding(check, `'${command(argv)}' reports authentication is not ready — ${def.auth.fix}`);
    }
  }
  return ok(check, `authenticated (${command(argv)})`);
}

export function checkGitBinary(spawn: SpawnFn): DoctorCheck {
  try {
    const result = spawn(["git", "--version"]);
    if (result.exitCode !== 0) return fail("git", `'git --version' exited ${result.exitCode} — reinstall git`);
    return ok("git", firstLine(result.stdout) || "on PATH");
  } catch {
    return fail("git", "git not found on PATH — install it (Wisp creates a worktree per task)");
  }
}

/** Use the project's effective identity, so repository-local Git config works. */
export function checkGitIdentity(spawn: SpawnFn, repoPath?: string): DoctorCheck {
  let unreadable = false;
  const get = (key: "user.name" | "user.email"): string | null => {
    try {
      const result = spawn([
        "git",
        ...(repoPath ? ["-C", repoPath] : []),
        "config",
        ...(repoPath ? [] : ["--global"]),
        "--get",
        key,
      ]);
      return result.exitCode === 0 && result.stdout ? result.stdout : null;
    } catch {
      unreadable = true;
      return null;
    }
  };
  const name = get("user.name");
  const email = get("user.email");
  if (name && email) return ok("git identity", `${name} <${email}>${repoPath ? ` (${repoPath})` : ""}`);
  if (unreadable) return fail("git identity", "cannot read git config — is git installed? (see the git check)");
  const missing = [name ? null : "user.name", email ? null : "user.email"].filter((key): key is string => key !== null);
  const prefix = repoPath ? `git -C ${quote(repoPath)} config` : "git config --global";
  const hints = missing.map((key) => `${prefix} ${key} "…"`).join(" && ");
  return fail("git identity", `${missing.join(" and ")} not set — harness commits need an identity: ${hints}`);
}

export function checkConfigFile(path: string = CONFIG_PATH): DoctorCheck {
  if (!existsSync(path)) return fail("config.json", `not initialized — run '${COMMAND} init'`);
  const warnings: string[] = [];
  try {
    validateConfig(readUserJson(path), (message) => warnings.push(message));
  } catch (error) {
    return fail("config.json", error instanceof Error ? error.message : String(error));
  }
  return warnings.length > 0 ? warn("config.json", warnings.join("; ")) : ok("config.json", "valid");
}

export function checkAdaptersFile(path: string = ADAPTERS_PATH): DoctorCheck {
  if (!existsSync(path)) {
    return ok("adapters.json", `builtin adapters (${Object.keys(BUILTIN_ADAPTERS).join(", ")})`);
  }
  const warnings: string[] = [];
  let merged: Record<string, AdapterDef>;
  try {
    merged = validateAdapters(readUserJson(path), (message) => warnings.push(message));
  } catch (error) {
    return fail("adapters.json", error instanceof Error ? error.message : String(error));
  }
  return warnings.length > 0
    ? warn("adapters.json", warnings.join("; "))
    : ok("adapters.json", `valid (${Object.keys(merged).join(", ")})`);
}

/**
 * The task database: what schema it is at, whether its pages are readable, and
 * whether foreign keys can be enforced (ENG-06).
 *
 * Opened READ-ONLY and separately from the daemon's own connection, because
 * `doctor` can run while a daemon is serving this home and must not take
 * ownership of it or migrate anything. A profile from a newer Wisp is the
 * interesting answer here: it is the state where the daemon would refuse to
 * start, and knowing that before restarting is the point of a diagnostic.
 */
export function checkDatabase(path: string = DB_PATH): DoctorCheck {
  if (!existsSync(path)) return ok("database", `not created yet — run '${COMMAND} serve' once`);
  let db: Database;
  try {
    db = new Database(path, { readonly: true });
  } catch (error) {
    return fail("database", `cannot open ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    const problems = integrityProblems(db);
    if (problems.length > 0) {
      return fail("database", `integrity check failed: ${problems.slice(0, 3).join("; ")} — restore a backup`);
    }
    // A profile that has never been opened by a ledger-aware build has no
    // `schema_migrations` table at all. That is schema 0 — the state the
    // INSTALL copy describes — not a failure (a review's note); the next
    // `serve` migrates it.
    const hasLedger =
      (db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get() ??
        null) !== null;
    const applied = hasLedger
      ? ((db.query("SELECT id FROM schema_migrations ORDER BY id DESC LIMIT 1").get() ?? null) as
          | { id: number }
          | null)
      : null;
    const version = applied?.id ?? 0;
    if (version > SCHEMA_VERSION) {
      return fail(
        "database",
        `schema ${version} was written by a newer Wisp; this build understands up to ${SCHEMA_VERSION} — upgrade Wisp or restore a pre-upgrade backup`,
      );
    }
    const violations = (db.query("PRAGMA foreign_key_check").all() as unknown[]).length;
    if (violations > 0) {
      return warn(
        "database",
        `schema ${version}, integrity ok, but ${violations} row(s) would violate a foreign key, so enforcement stays off`,
      );
    }
    return ok("database", `schema ${version} of ${SCHEMA_VERSION}, integrity ok, foreign keys enforceable`);
  } catch (error) {
    return fail("database", error instanceof Error ? error.message : String(error));
  } finally {
    db.close();
  }
}

export function checkProject(repoPath: string | undefined, spawn: SpawnFn): DoctorCheck {
  if (!repoPath) {
    return fail("project", `none registered — run '${COMMAND} project add /absolute/path/to/repo'`);
  }
  if (!existsSync(repoPath)) {
    return fail(
      "project",
      `registered path is missing: ${repoPath} — fix it with '${COMMAND} project rm' then '${COMMAND} project add'`,
    );
  }
  try {
    const result = spawn(["git", "-C", repoPath, "rev-parse", "--is-inside-work-tree"]);
    if (result.exitCode === 0 && result.stdout.trim() === "true") return ok("project", repoPath);
    return fail(
      "project",
      `${repoPath} is not a Git working tree — register a repository with '${COMMAND} project add'`,
    );
  } catch {
    return fail("project", `could not inspect ${repoPath} — install git, then rerun '${COMMAND} doctor'`);
  }
}

export function checkSupervisor(
  spawn: SpawnFn,
  currentPlatform: NodeJS.Platform = platform(),
  commandName: WispCommand = COMMAND,
): DoctorCheck {
  if (commandName === "wisp-dev") {
    return warn("supervisor", "development mode is foreground-only — keep 'wisp-dev serve' or 'bun run dev' running");
  }
  if (currentPlatform === "darwin") {
    try {
      const result = spawn(["brew", "services", "list"]);
      const row = result.stdout
        .split("\n")
        .map((line) => line.trim().split(/\s+/))
        .find((parts) => parts[0] === "wisp");
      if (result.exitCode === 0 && row?.[1] === "started") {
        return ok("supervisor", "Homebrew launchd service started (wisp)");
      }
    } catch {
      // The foreground path remains available during source development.
    }
    return warn(
      "supervisor",
      "Homebrew service is not started — run 'brew services start wisp' or keep 'wisp serve' in the foreground",
    );
  }
  if (currentPlatform !== "linux") {
    return warn("supervisor", "not checked on this platform; run 'wisp serve' in the foreground for best-effort use");
  }
  try {
    const result = spawn(["systemctl", "--user", "is-enabled", "wisp.service"]);
    if (result.exitCode === 0 && result.stdout.trim() === "enabled") {
      return ok("supervisor", "systemd user service enabled (wisp.service)");
    }
  } catch {
    // A foreground/container supervisor remains a supported path.
  }
  return warn(
    "supervisor",
    "wisp.service is not enabled — keep 'wisp serve' in the foreground or configure a restart-capable supervisor",
  );
}

export async function checkDaemon(
  cfg: { host: string; port: number },
  fetchFn: typeof fetch = fetch,
): Promise<DoctorCheck> {
  const url = `http://${cfg.host}:${cfg.port}/api/health`;
  let response: Response;
  try {
    response = await fetchFn(url, { signal: AbortSignal.timeout(2000) });
  } catch {
    return fail(
      "daemon",
      `nothing on ${cfg.host}:${cfg.port} — start it with '${COMMAND} serve' or the installed user service`,
    );
  }
  if (!response.ok) {
    return fail("daemon", `GET ${url} returned ${response.status} — is another service on port ${cfg.port}?`);
  }
  const data = (await response.json().catch(() => null)) as
    | { version?: string; commit?: string; dirty?: boolean }
    | null;
  if (!data?.version) return fail("daemon", `GET ${url} did not return a Wisp build identity`);
  if (
    data.version !== VERSION ||
    (data.commit && data.commit !== BUILD_COMMIT) ||
    (typeof data.dirty === "boolean" && data.dirty !== BUILD_DIRTY)
  ) {
    return warn(
      "daemon",
      `build skew: daemon ${data.version}@${data.commit ?? "unknown"}${data.dirty ? "+dirty" : ""}, CLI ${VERSION}@${BUILD_COMMIT}${BUILD_DIRTY ? "+dirty" : ""} — restart the daemon`,
    );
  }
  return ok("daemon", `${cfg.host}:${cfg.port} (${data.version}@${data.commit ?? "unknown"})`);
}

/**
 * Which browser origins the RUNNING daemon accepts a terminal socket from.
 *
 * Asked of the daemon rather than read from this shell, and that distinction
 * is the whole value of the check: `WISP_ALLOWED_ORIGINS` has to be in the
 * daemon's environment, and a daemon started by a user service or a container
 * supervisor does not share this terminal's. Reading it here would confidently
 * report "unset" for a daemon that has it set, and the reverse — a second
 * false diagnosis on top of the one this check exists to prevent (#139).
 */
export async function checkTerminalOrigins(
  cfg: { host: string; port: number; token: string },
  fetchFn: typeof fetch = fetch,
): Promise<DoctorCheck> {
  const check = "terminal origins";
  const url = `http://${cfg.host}:${cfg.port}/api/terminal-origin`;
  let response: Response;
  try {
    response = await fetchFn(url, {
      method: "POST",
      headers: { authorization: `Bearer ${cfg.token}` },
      signal: AbortSignal.timeout(2000),
    });
  } catch {
    return warn(check, `could not ask the daemon which origins it accepts (POST ${url})`);
  }
  if (response.status === 404) {
    return warn(check, `the running daemon does not report its origins yet — restart it to pick up this build`);
  }
  if (!response.ok) return warn(check, `POST ${url} returned ${response.status}`);
  const report = (await response.json().catch(() => null)) as { expected?: unknown; allowed?: unknown } | null;
  const expected = typeof report?.expected === "string" ? report.expected : null;
  if (!expected) return warn(check, `POST ${url} did not report an origin`);
  const allowed = Array.isArray(report?.allowed) ? report.allowed.filter((o): o is string => typeof o === "string") : [];
  return ok(
    check,
    allowed.length > 0
      ? `${expected}, plus ${ALLOWED_ORIGINS_ENV}: ${allowed.join(", ")}`
      : `${expected} only (${ALLOWED_ORIGINS_ENV} unset in the daemon's environment)`,
  );
}

export interface DoctorDeps {
  spawn?: SpawnFn;
  fetchFn?: typeof fetch;
  configPath?: string;
  adaptersPath?: string;
  selectedHarness?: string;
  currentPlatform?: NodeJS.Platform;
  currentArch?: string;
  config?: WispConfig;
  adapters?: Record<string, AdapterDef>;
}

function repoPath(entry: WispConfig["repos"][number] | undefined): string | undefined {
  if (typeof entry === "string") return entry;
  return entry?.path;
}

function loadDoctorConfig(deps: DoctorDeps): WispConfig | undefined {
  if (deps.config) return deps.config;
  const configFile = deps.configPath ?? CONFIG_PATH;
  if (!existsSync(configFile) || configFile !== CONFIG_PATH) return undefined;
  try {
    return loadConfig();
  } catch {
    return undefined;
  }
}

function loadDoctorAdapters(deps: DoctorDeps, checks: DoctorCheck[]): Record<string, AdapterDef> {
  if (deps.adapters) return deps.adapters;
  try {
    return loadAdapters();
  } catch {
    checks.push(fail("harnesses", "skipped — adapters.json is invalid (see above)"));
    return {};
  }
}

function appendHarnessChecks(
  checks: DoctorCheck[],
  adapters: Record<string, AdapterDef>,
  selected: string | undefined,
  spawn: SpawnFn,
): string[] {
  if (selected && !adapters[selected]) {
    checks.push(fail("harness", `unknown '${selected}' — choose one of: ${Object.keys(adapters).join(", ")}`));
  }
  const candidates: [string, AdapterDef][] = selected
    ? adapters[selected]
      ? [[selected, adapters[selected]]]
      : []
    : Object.entries(adapters);
  const ready: string[] = [];
  for (const [name, def] of candidates) {
    const required = selected === name;
    const binary = checkHarness(name, def, spawn, required);
    checks.push(binary);
    if (binary.status !== "ok") continue;
    const auth = checkHarnessAuth(name, def, spawn, required);
    checks.push(auth);
    if (auth.status === "ok" || !def.auth) ready.push(name);
  }
  checks.push(
    ready.length > 0
      ? ok("harness ready", ready.join(", "))
      : fail(
          "harness ready",
          selected
            ? `'${selected}' is not ready — fix its harness/auth finding above`
            : `no installed authenticated harness — install/login to one, then rerun with '${COMMAND} doctor --harness <name>'`,
        ),
  );
  return ready;
}

function activationReceipt(
  checks: DoctorCheck[],
  ready: string[],
  selected: string | undefined,
  project: string | undefined,
): DoctorCheck {
  const blockers = checks.filter((check) => check.status === "fail");
  if (blockers.length > 0) {
    return fail(
      "activation",
      `${blockers.length} blocker${blockers.length === 1 ? "" : "s"}: ${blockers.map((check) => check.name).join(", ")}; fix the first FAIL, then rerun '${COMMAND} doctor${selected ? ` --harness ${selected}` : ""}'`,
    );
  }
  return ok(
    "activation",
    `ready for a first task with ${ready.join(", ")} — run '${COMMAND} new ${quote(project!)} "your task" --harness ${selected ?? ready[0]}'`,
  );
}

export async function runDoctor(deps: DoctorDeps = {}): Promise<DoctorCheck[]> {
  const spawn = deps.spawn ?? bunSpawn;
  const fetchFn = deps.fetchFn ?? fetch;
  const configFile = deps.configPath ?? CONFIG_PATH;
  const cfg = loadDoctorConfig(deps);
  const checks: DoctorCheck[] = [
    checkPlatform(deps.currentPlatform ?? platform(), deps.currentArch ?? arch()),
    checkConfigFile(configFile),
    checkAdaptersFile(deps.adaptersPath),
    checkDatabase(),
    checkGitBinary(spawn),
  ];

  if (!cfg) checks.push(fail("project", "skipped — config.json is invalid (see above)"));
  const project = repoPath(cfg?.repos[0]);
  if (cfg) checks.push(checkProject(project, spawn));
  checks.push(checkGitIdentity(spawn, project));

  const selected = deps.selectedHarness;
  const ready = appendHarnessChecks(checks, loadDoctorAdapters(deps, checks), selected, spawn);

  checks.push(checkSupervisor(spawn, deps.currentPlatform ?? platform()));
  if (cfg) {
    const daemon = await checkDaemon(cfg, fetchFn);
    checks.push(daemon);
    // Only worth asking a daemon that answered. An unreachable one already
    // has its own FAIL above, and a second line saying so explains nothing.
    if (daemon.status !== "fail") checks.push(await checkTerminalOrigins(cfg, fetchFn));
  } else checks.push(fail("daemon", "skipped — config.json is invalid (see above)"));

  checks.push(activationReceipt(checks, ready, selected, project));
  return checks;
}
