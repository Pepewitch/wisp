import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILTIN_ADAPTERS, type AdapterDef } from "../src/adapters";
import {
  checkHarnessDefaults,
  CONFIG_PATH,
  FALLBACK_PORT_END,
  INSTANCE_ID_PATH,
  loadConfig,
  MAX_CONFIGURED_PORT,
  MIN_CONFIGURED_PORT,
  PREFERRED_PORT,
  resolveHarnessDefaults,
  selectInitialPort,
  validateConfig,
  type WispConfig,
} from "../src/config";

/** Exact-message assertions for the fail-at-boot errors (a prior audit). */
function thrownMessage(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  throw new Error("expected function to throw, but it returned");
}

async function loadFromIsolatedProcess(home: string): Promise<{ instanceId: string; token: string }> {
  const configModule = new URL("../src/config.ts", import.meta.url).href;
  const source = `import { loadConfig } from ${JSON.stringify(configModule)}; console.log(JSON.stringify(loadConfig({ initialPort: 18710, portAvailable: () => true })));`;
  const child = Bun.spawn({
    cmd: [process.execPath, "-e", source],
    env: { ...process.env, WISP_HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(`isolated config load failed: ${stderr.trim()}`);
  return JSON.parse(stdout) as { instanceId: string; token: string };
}

describe("validateConfig (a prior audit)", () => {
  test("a valid config passes through every known field", () => {
    const raw = {
      instanceId: "123e4567-e89b-42d3-a456-426614174000",
      port: 9000,
      host: "0.0.0.0",
      token: "t",
      webhooks: ["https://example.test/hook"],
      repos: ["/repo/a", "/repo/b"],
      stuckMinutes: 5,
      logMaxBytes: 123,
      setupTimeoutMinutes: 2,
      envAllowlist: { myrepo: [".env"] },
      harnessDefaults: { claude: { model: "claude-opus-5" }, droid: { model: "kimi-k3", reasoningEffort: "medium" } },
    };
    expect(validateConfig(raw)).toEqual(raw);
  });

  test("repos accepts legacy strings and named project objects", () => {
    const raw = { repos: ["/repo/a", { path: "/repo/b", name: "Beta" }, { path: "/repo/c" }] };
    expect(validateConfig(raw)).toEqual(raw);
  });

  test("an empty object is valid (all defaults)", () => {
    expect(validateConfig({})).toEqual({});
  });

  test("top level must be an object", () => {
    expect(thrownMessage(() => validateConfig([]))).toBe("config.json: top level must be an object, got array");
    expect(thrownMessage(() => validateConfig("x"))).toBe("config.json: top level must be an object, got string");
    expect(thrownMessage(() => validateConfig(null))).toBe("config.json: top level must be an object, got null");
  });

  test("wrong types name the field and the received type", () => {
    expect(thrownMessage(() => validateConfig({ port: "8710" }))).toBe(
      "config.json: port must be a number, got string",
    );
    expect(thrownMessage(() => validateConfig({ host: 8710 }))).toBe("config.json: host must be a string, got number");
    expect(thrownMessage(() => validateConfig({ token: 42 }))).toBe("config.json: token must be a string, got number");
    expect(thrownMessage(() => validateConfig({ instanceId: 42 }))).toBe(
      "config.json: instanceId must be a string, got number",
    );
    expect(thrownMessage(() => validateConfig({ instanceId: "not-a-uuid" }))).toBe(
      "config.json: instanceId must be a UUID",
    );
    expect(thrownMessage(() => validateConfig({ instanceId: "" }))).toBe(
      "config.json: instanceId must be a UUID",
    );
    expect(thrownMessage(() => validateConfig({ webhooks: "https://x" }))).toBe(
      "config.json: webhooks must be an array of strings, got string",
    );
    expect(thrownMessage(() => validateConfig({ webhooks: ["ok", 7] }))).toBe(
      "config.json: webhooks[1] must be a string, got number",
    );
    expect(thrownMessage(() => validateConfig({ repos: "/repo/a" }))).toBe(
      "config.json: repos must be an array of strings, got string",
    );
    expect(thrownMessage(() => validateConfig({ repos: ["/ok", 42] }))).toBe(
      "config.json: repos[1] must be a string, got number",
    );
    expect(thrownMessage(() => validateConfig({ repos: [{ path: 42 }] }))).toBe(
      "config.json: repos[0].path must be a string, got number",
    );
    expect(thrownMessage(() => validateConfig({ repos: [{ path: "/ok", name: 42 }] }))).toBe(
      "config.json: repos[0].name must be a string, got number",
    );
    expect(thrownMessage(() => validateConfig({ stuckMinutes: "10" }))).toBe(
      "config.json: stuckMinutes must be a number, got string",
    );
    expect(thrownMessage(() => validateConfig({ logMaxBytes: null }))).toBe(
      "config.json: logMaxBytes must be a number, got null",
    );
    expect(thrownMessage(() => validateConfig({ setupTimeoutMinutes: true }))).toBe(
      "config.json: setupTimeoutMinutes must be a number, got boolean",
    );
    expect(thrownMessage(() => validateConfig({ envAllowlist: [] }))).toBe(
      "config.json: envAllowlist must be an object mapping repo names to arrays of strings, got array",
    );
    expect(thrownMessage(() => validateConfig({ envAllowlist: { repo: ".env" } }))).toBe(
      "config.json: envAllowlist['repo'] must be an array of strings, got string",
    );
    expect(thrownMessage(() => validateConfig({ envAllowlist: { repo: [".env", 5] } }))).toBe(
      "config.json: envAllowlist['repo'][1] must be a string, got number",
    );
  });

  test("configured ports are bounded integers", () => {
    expect(thrownMessage(() => validateConfig({ port: 0 }))).toBe(
      `config.json: port must be an integer from ${MIN_CONFIGURED_PORT} to ${MAX_CONFIGURED_PORT}, got 0`,
    );
    expect(thrownMessage(() => validateConfig({ port: 8710.5 }))).toBe(
      `config.json: port must be an integer from ${MIN_CONFIGURED_PORT} to ${MAX_CONFIGURED_PORT}, got 8710.5`,
    );
    expect(thrownMessage(() => validateConfig({ port: 65536 }))).toBe(
      `config.json: port must be an integer from ${MIN_CONFIGURED_PORT} to ${MAX_CONFIGURED_PORT}, got 65536`,
    );
    expect(validateConfig({ port: MIN_CONFIGURED_PORT })).toEqual({ port: MIN_CONFIGURED_PORT });
    expect(validateConfig({ port: MAX_CONFIGURED_PORT })).toEqual({ port: MAX_CONFIGURED_PORT });
  });

  test("unknown keys warn and are dropped", () => {
    const warnings: string[] = [];
    const out = validateConfig({ port: 9000, prot: 9001 }, (m) => warnings.push(m));
    expect(warnings).toEqual([
      "config.json: unknown key 'prot' — ignoring (known: instanceId, port, host, token, webhooks, repos, stuckMinutes, logMaxBytes, setupTimeoutMinutes, envAllowlist, harnessDefaults)",
    ]);
    expect(out).toEqual({ port: 9000 });
  });
});

describe("loadConfig", () => {
  test("a new home persists the first available production port", () => {
    rmSync(CONFIG_PATH, { force: true });
    const seen: number[] = [];
    try {
      const cfg = loadConfig({
        portAvailable: (_host, port) => {
          seen.push(port);
          return port === PREFERRED_PORT + 2;
        },
      });
      expect(cfg.port).toBe(PREFERRED_PORT + 2);
      expect(seen).toEqual([PREFERRED_PORT, PREFERRED_PORT + 1, PREFERRED_PORT + 2]);
      expect((JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as WispConfig).port).toBe(PREFERRED_PORT + 2);
    } finally {
      rmSync(CONFIG_PATH, { force: true });
    }
  });

  test("an existing configured port never moves or gets probed", () => {
    writeFileSync(CONFIG_PATH, JSON.stringify({ port: 9000, token: "t" }));
    let probed = false;
    try {
      expect(loadConfig({ initialPort: 9001, portAvailable: () => (probed = true) }).port).toBe(9000);
      expect(probed).toBe(false);
    } finally {
      rmSync(CONFIG_PATH, { force: true });
    }
  });

  test("adds one stable instance ID to an existing config", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    writeFileSync(CONFIG_PATH, JSON.stringify({ port: 9000, token: "t", futureSetting: "preserved" }));
    try {
      const first = loadConfig();
      expect(first.instanceId).toMatch(/^[0-9a-f-]{36}$/);
      expect(loadConfig().instanceId).toBe(first.instanceId);
      expect(JSON.parse(readFileSync(CONFIG_PATH, "utf8"))).toMatchObject({
        instanceId: first.instanceId,
        port: 9000,
        token: "t",
        futureSetting: "preserved",
      });
      expect(statSync(CONFIG_PATH).mode & 0o777).toBe(0o600);
      expect(statSync(INSTANCE_ID_PATH).mode & 0o777).toBe(0o600);
    } finally {
      warn.mockRestore();
      rmSync(CONFIG_PATH, { force: true });
    }
  });

  test("refuses a malformed persisted instance ID instead of silently changing identity", () => {
    writeFileSync(CONFIG_PATH, JSON.stringify({ token: "t", instanceId: "not-a-uuid" }));
    try {
      expect(thrownMessage(() => loadConfig())).toBe("config.json: instanceId must be a UUID");
    } finally {
      rmSync(CONFIG_PATH, { force: true });
    }
  });

  test("serializes identity creation across simultaneous legacy migrations", async () => {
    const home = mkdtempSync(join(tmpdir(), "wisp-config-race-"));
    try {
      const [first, second] = await Promise.all([
        loadFromIsolatedProcess(home),
        loadFromIsolatedProcess(home),
      ]);
      const persisted = JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as { instanceId: string };
      expect(first.instanceId).toBe(second.instanceId);
      expect(persisted.instanceId).toBe(first.instanceId);
      expect(readFileSync(join(home, "instance-id"), "utf8").trim()).toBe(first.instanceId);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("uses different identities for independent Wisp homes", async () => {
    const firstHome = mkdtempSync(join(tmpdir(), "wisp-config-home-"));
    const secondHome = mkdtempSync(join(tmpdir(), "wisp-config-home-"));
    try {
      const [first, second] = await Promise.all([
        loadFromIsolatedProcess(firstHome),
        loadFromIsolatedProcess(secondHome),
      ]);
      expect(first.instanceId).not.toBe(second.instanceId);
    } finally {
      rmSync(firstHome, { recursive: true, force: true });
      rmSync(secondHome, { recursive: true, force: true });
    }
  });

  test("fails at boot on a bad type instead of booting into a broken config", () => {
    writeFileSync(CONFIG_PATH, JSON.stringify({ port: "8710" }));
    try {
      expect(thrownMessage(() => loadConfig())).toBe("config.json: port must be a number, got string");
    } finally {
      rmSync(CONFIG_PATH);
    }
  });

  test("round-trips harnessDefaults; a malformed block warns instead of failing the boot", () => {
    writeFileSync(CONFIG_PATH, JSON.stringify({ token: "t", harnessDefaults: { droid: { model: "kimi-k3" } } }));
    try {
      expect(loadConfig().harnessDefaults).toEqual({ droid: { model: "kimi-k3" } });
    } finally {
      rmSync(CONFIG_PATH);
    }
    writeFileSync(CONFIG_PATH, JSON.stringify({ token: "t", harnessDefaults: "stale" }));
    try {
      expect(loadConfig().harnessDefaults).toEqual({}); // warned and dropped, not a crash
    } finally {
      rmSync(CONFIG_PATH);
    }
  });

  test("fails at boot on malformed JSON, naming the file", () => {
    writeFileSync(CONFIG_PATH, "{ nope");
    try {
      expect(thrownMessage(() => loadConfig())).toStartWith("config.json: invalid JSON — ");
    } finally {
      rmSync(CONFIG_PATH);
    }
  });

  test("merges a valid user config over the defaults", () => {
    writeFileSync(CONFIG_PATH, JSON.stringify({ port: 9999, token: "abc" }));
    try {
      const cfg = loadConfig();
      expect(cfg.port).toBe(9999);
      expect(cfg.token).toBe("abc");
      expect(cfg.stuckMinutes).toBe(10); // default
      expect(cfg.repos).toEqual([]); // default
      expect(cfg.envAllowlist).toEqual({}); // default
      expect(cfg.harnessDefaults).toEqual({}); // default
    } finally {
      rmSync(CONFIG_PATH);
    }
  });
});

describe("first-run port selection", () => {
  test("uses the bounded production range in order", () => {
    const seen: number[] = [];
    expect(
      selectInitialPort(undefined, (_host, port) => {
        seen.push(port);
        return port === PREFERRED_PORT + 3;
      }),
    ).toBe(PREFERRED_PORT + 3);
    expect(seen).toEqual([PREFERRED_PORT, PREFERRED_PORT + 1, PREFERRED_PORT + 2, PREFERRED_PORT + 3]);
  });

  test("fails loudly when the production range is exhausted", () => {
    expect(() => selectInitialPort(undefined, () => false)).toThrow(
      `no available loopback port from ${PREFERRED_PORT} through ${FALLBACK_PORT_END}`,
    );
  });

  test("honors a valid explicit first-run port and rejects a collision", () => {
    expect(selectInitialPort(18710, (_host, port) => port === 18710)).toBe(18710);
    expect(() => selectInitialPort(18710, () => false)).toThrow(
      "initial port 127.0.0.1:18710 is already in use",
    );
  });
});

describe("harnessDefaults validation (P5b: warn and ignore, NEVER crash the daemon)", () => {
  test("a wrong-typed block warns and is dropped", () => {
    const warnings: string[] = [];
    expect(validateConfig({ harnessDefaults: [] }, (m) => warnings.push(m))).toEqual({});
    expect(warnings).toEqual([
      "config.json: harnessDefaults must be an object mapping harness names to defaults ({ model, reasoningEffort }), got array — ignoring it",
    ]);
  });

  test("a wrong-typed entry warns and is dropped; sibling entries still apply", () => {
    const warnings: string[] = [];
    const out = validateConfig(
      { harnessDefaults: { claude: "opus-5", droid: { model: "kimi-k3" } } },
      (m) => warnings.push(m),
    );
    expect(out.harnessDefaults).toEqual({ droid: { model: "kimi-k3" } });
    expect(warnings).toEqual([
      "config.json: harnessDefaults['claude'] must be an object of defaults ({ model, reasoningEffort }), got string — ignoring it",
    ]);
  });

  test("a wrong-typed field warns and is dropped; the entry's other fields still apply", () => {
    const warnings: string[] = [];
    const out = validateConfig({ harnessDefaults: { droid: { model: 7, reasoningEffort: "low" } } }, (m) =>
      warnings.push(m),
    );
    expect(out.harnessDefaults).toEqual({ droid: { reasoningEffort: "low" } });
    expect(warnings).toEqual(["config.json: harnessDefaults['droid'].model must be a string, got number — ignoring it"]);
  });

  test("an unknown field warns and is dropped — a config from another wisp version must not brick this one", () => {
    const warnings: string[] = [];
    const out = validateConfig({ harnessDefaults: { claude: { model: "opus-5", temperature: 0.2 } } }, (m) =>
      warnings.push(m),
    );
    expect(out.harnessDefaults).toEqual({ claude: { model: "opus-5" } });
    expect(warnings).toEqual([
      "config.json: harnessDefaults['claude']: unknown key 'temperature' — ignoring (known: model, reasoningEffort)",
    ]);
  });
});

const baseCfg: WispConfig = {
  instanceId: "123e4567-e89b-42d3-a456-426614174000",
  port: 0,
  host: "127.0.0.1",
  token: "t",
  webhooks: [],
  repos: [],
  stuckMinutes: 10,
  logMaxBytes: 5_000_000,
  setupTimeoutMinutes: 10,
  envAllowlist: {},
  harnessDefaults: {},
};

describe("checkHarnessDefaults (P5b: the adapter-name check only the merged adapter set can make)", () => {
  test("an entry for an unknown adapter warns and is ignored — it can never apply", () => {
    const warnings: string[] = [];
    checkHarnessDefaults(
      { ...baseCfg, harnessDefaults: { nosuch: { model: "x" }, droid: { model: "kimi-k3" } } },
      BUILTIN_ADAPTERS,
      (m) => warnings.push(m),
    );
    expect(warnings).toEqual([
      "config.json: harnessDefaults['nosuch'] names an adapter Wisp doesn't know (loaded: droid, claude, codex, cursor) — ignoring it",
    ]);
  });

  test("a default an adapter has no template for warns — recorded on the task but never reaching the harness", () => {
    const warnings: string[] = [];
    const fakeOnly: Record<string, AdapterDef> = { fake: { bin: "fake", exec: [], parse: { format: "text" } } };
    checkHarnessDefaults({ ...baseCfg, harnessDefaults: { fake: { model: "m", reasoningEffort: "low" } } }, fakeOnly, (m) =>
      warnings.push(m),
    );
    expect(warnings).toEqual([
      "config.json: harnessDefaults['fake'].model is set, but the 'fake' adapter has no model template — it is recorded on tasks but never reaches the harness",
      "config.json: harnessDefaults['fake'].reasoningEffort is set, but the 'fake' adapter has no effort template — task creation will reject this default instead of silently dropping it",
    ]);
  });

  test("a harness with no effort template warns when a reasoningEffort default is set", () => {
    const warnings: string[] = [];
    // claude gained --effort in claude-code 2.1.246, so every builtin now
    // supports effort — this path needs a synthetic adapter to stay covered.
    const plain: AdapterDef = { ...BUILTIN_ADAPTERS.claude!, effort: undefined };
    checkHarnessDefaults({ ...baseCfg, harnessDefaults: { plain: { reasoningEffort: "high" } } }, { plain }, (m) =>
      warnings.push(m),
    );
    expect(warnings).toEqual([
      "config.json: harnessDefaults['plain'].reasoningEffort is set, but the 'plain' adapter has no effort template — task creation will reject this default instead of silently dropping it",
    ]);
  });

  test("claude now HAS an effort template, so a reasoningEffort default for it is silent", () => {
    const warnings: string[] = [];
    checkHarnessDefaults({ ...baseCfg, harnessDefaults: { claude: { reasoningEffort: "high" } } }, BUILTIN_ADAPTERS, (m) =>
      warnings.push(m),
    );
    expect(warnings).toEqual([]);
  });

  test("a correct config is silent", () => {
    const warnings: string[] = [];
    checkHarnessDefaults(
      {
        ...baseCfg,
        harnessDefaults: {
          droid: { model: "kimi-k3", reasoningEffort: "medium" },
          claude: { model: "claude-opus-5" },
          codex: { model: "gpt-5.6-luna" },
        },
      },
      BUILTIN_ADAPTERS,
      (m) => warnings.push(m),
    );
    expect(warnings).toEqual([]);
  });
});

describe("resolveHarnessDefaults (P5b: default-applied vs flag-wins)", () => {
  const cfg: WispConfig = {
    ...baseCfg,
    harnessDefaults: { droid: { model: "kimi-k3", reasoningEffort: "medium" }, claude: { model: "claude-opus-5" } },
  };

  test("an explicit --model always wins over the config default", () => {
    expect(resolveHarnessDefaults(cfg, "droid", "other-model")).toEqual({ model: "other-model", effort: "medium" });
  });

  test("an explicit effort wins over the config default", () => {
    expect(resolveHarnessDefaults(cfg, "droid", undefined, "high")).toEqual({ model: "kimi-k3", effort: "high" });
  });

  test("the config default applies when no --model is passed", () => {
    expect(resolveHarnessDefaults(cfg, "droid", undefined)).toEqual({ model: "kimi-k3", effort: "medium" });
    expect(resolveHarnessDefaults(cfg, "claude", undefined)).toEqual({ model: "claude-opus-5", effort: null });
  });

  test("no default and no flag → nulls (the harness's own default)", () => {
    expect(resolveHarnessDefaults(cfg, "codex", undefined)).toEqual({ model: null, effort: null });
  });
});
