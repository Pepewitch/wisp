import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdapterDef } from "../src/adapters";
import { CONFIG_PATH, type WispConfig } from "../src/config";
import {
  checkAdaptersFile,
  checkConfigFile,
  checkDaemon,
  checkDaemonDiagnostics,
  checkGh,
  checkGitBinary,
  checkGitIdentity,
  checkHarness,
  checkHarnessAuth,
  checkLastUpdate,
  checkPlatform,
  checkProject,
  checkRestarts,
  checkSupervisor,
  checkTerminalOrigins,
  checkToken,
  parseVersion,
  runDoctor,
  type SpawnFn,
} from "../src/doctor";
import { BUILD_COMMIT, VERSION } from "../src/version";

const ENOENT: SpawnFn = (cmd) => {
  throw new Error(`spawnSync ${cmd[0]} ENOENT`);
};

const DROID: AdapterDef = {
  bin: "droid",
  auth: {
    check: ["doctor", "--auth", "--json", "--timeout", "3000"],
    fix: "run 'droid' and use /login",
    success: "json-ok",
  },
  exec: [],
  parse: { format: "json" },
};

const CLAUDE: AdapterDef = {
  bin: "claude",
  auth: { check: ["auth", "status"], fix: "run 'claude auth login'" },
  exec: [],
  parse: { format: "json" },
};

/**
 * One stub for both daemon probes, answering per route, because `runDoctor`
 * now asks the daemon two questions: who it is, and which browser origins it
 * accepts a terminal socket from.
 */
const healthyFetch = (async (input: string) => ({
  ok: true,
  status: 200,
  json: async () =>
    String(input).endsWith("/api/terminal-origin")
      ? { verdict: "absent", origin: null, expected: "http://127.0.0.1:8710", allowed: [], reason: null }
      : { ok: true, version: VERSION, commit: BUILD_COMMIT, dirty: true },
})) as unknown as typeof fetch;

function tempFile(name: string, contents: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "wisp-doctor-")), name);
  writeFileSync(path, contents);
  return path;
}

function missingFile(name: string): string {
  return join(mkdtempSync(join(tmpdir(), "wisp-doctor-")), name);
}

function config(repo: string): WispConfig {
  return {
    instanceId: "123e4567-e89b-42d3-a456-426614174000",
    host: "127.0.0.1",
    port: 8710,
    token: "test",
    webhooks: [],
    repos: [repo],
    stuckMinutes: 10,
    logMaxBytes: 5_000_000,
    setupTimeoutMinutes: 10,
    envAllowlist: {},
    harnessDefaults: {},
  };
}

function goodSpawn(cmd: string[]) {
  if (cmd[0] === "git" && cmd[1] === "--version") {
    return { exitCode: 0, stdout: "git version 2.43.0", stderr: "" };
  }
  if (cmd[0] === "git" && cmd.includes("rev-parse")) return { exitCode: 0, stdout: "true", stderr: "" };
  if (cmd[0] === "git" && cmd.at(-1) === "user.name") return { exitCode: 0, stdout: "Ada", stderr: "" };
  if (cmd[0] === "git" && cmd.at(-1) === "user.email") {
    return { exitCode: 0, stdout: "ada@example.com", stderr: "" };
  }
  if (cmd[0] === "systemctl") return { exitCode: 0, stdout: "enabled", stderr: "" };
  if (cmd[0] === "brew" && cmd[1] === "services") {
    return { exitCode: 0, stdout: "Name Status User File\nwisp started ada ~/Library/LaunchAgents/homebrew.mxcl.wisp.plist", stderr: "" };
  }
  if (cmd[0] === "droid" && cmd[1] === "doctor") {
    return { exitCode: 0, stdout: '{"ok":true}', stderr: "" };
  }
  if (cmd[0] === "droid" && cmd[1] === "--version") {
    return { exitCode: 0, stdout: "droid 0.205.0", stderr: "" };
  }
  if (cmd[0] === "claude" && cmd[1] === "--version") {
    return { exitCode: 0, stdout: "claude 2.1.258", stderr: "" };
  }
  if (cmd[0] === "claude" && cmd[1] === "auth") return { exitCode: 0, stdout: "", stderr: "" };
  return { exitCode: 1, stdout: "", stderr: "unexpected command" };
}

describe("parseVersion", () => {
  test("extracts semver from real-shaped output", () => {
    expect(parseVersion("2.1.3 (Claude Code)")).toBe("2.1.3");
    expect(parseVersion("droid version 0.22.1")).toBe("0.22.1");
    expect(parseVersion("1.4.0-beta.2")).toBe("1.4.0-beta.2");
  });

  test("returns null without a full semantic version", () => {
    expect(parseVersion("1.2")).toBeNull();
    expect(parseVersion("")).toBeNull();
  });
});

describe("platform", () => {
  test("Linux x64 is the supported path", () => {
    expect(checkPlatform("linux", "x64")).toEqual({
      name: "platform",
      status: "ok",
      message: "Linux x86_64 (supported v1.0 target: Ubuntu 24.04 LTS)",
    });
  });

  test("Apple Silicon is the experimental Mac path and Intel remains unsupported", () => {
    expect(checkPlatform("darwin", "arm64")).toEqual({
      name: "platform",
      status: "ok",
      message: "macOS Apple Silicon arm64 (experimental v0.4 target; qualification baseline: macOS 26.6.2)",
    });
    expect(checkPlatform("darwin", "x64").message).toContain("no Intel Mac artifact");
    expect(checkPlatform("linux", "arm64").status).toBe("fail");
    expect(checkPlatform("win32", "x64").status).toBe("fail");
  });
});

describe("harness readiness", () => {
  test("checks version without billing a turn", () => {
    let seen: string[] = [];
    const result = checkHarness("droid", DROID, (cmd) => {
      seen = cmd;
      return { exitCode: 0, stdout: "droid version 0.205.0", stderr: "" };
    });
    expect(seen).toEqual(["droid", "--version"]);
    expect(result).toEqual({ name: "harness droid", status: "ok", message: "droid 0.205.0" });
  });

  test("an absent selected harness fails, while an unused one only warns", () => {
    expect(checkHarness("droid", DROID, ENOENT).status).toBe("fail");
    expect(checkHarness("droid", DROID, ENOENT, false).status).toBe("warn");
  });

  test("runs the declared auth diagnostic and accepts explicit JSON ok", () => {
    let seen: string[] = [];
    const result = checkHarnessAuth("droid", DROID, (cmd) => {
      seen = cmd;
      return { exitCode: 0, stdout: '{"ok":true,"results":[]}', stderr: "" };
    });
    expect(seen).toEqual(["droid", "doctor", "--auth", "--json", "--timeout", "3000"]);
    expect(result.status).toBe("ok");
  });

  test("auth failure gives the adapter's tested next action without echoing output", () => {
    const result = checkHarnessAuth("droid", DROID, () => ({
      exitCode: 1,
      stdout: "account=private@example.com",
      stderr: "token expired",
    }));
    expect(result.status).toBe("fail");
    expect(result.message).toContain("run 'droid' and use /login");
    expect(result.message).not.toContain("private@example.com");
    expect(result.message).not.toContain("token expired");
  });

  test("json-ok rejects malformed and negative diagnostics", () => {
    expect(checkHarnessAuth("droid", DROID, () => ({ exitCode: 0, stdout: "nope", stderr: "" })).status).toBe(
      "fail",
    );
    expect(
      checkHarnessAuth("droid", DROID, () => ({ exitCode: 0, stdout: '{"ok":false}', stderr: "" })).status,
    ).toBe("fail");
  });

  test("a custom adapter without a probe is explicit rather than guessed", () => {
    const custom = { ...DROID, auth: null };
    expect(checkHarnessAuth("custom", custom, goodSpawn).status).toBe("warn");
  });
});

describe("git and project", () => {
  test("reports git and effective repository-local identity", () => {
    expect(checkGitBinary(goodSpawn).status).toBe("ok");
    const repo = mkdtempSync(join(tmpdir(), "wisp-project-"));
    expect(checkGitIdentity(goodSpawn, repo)).toEqual({
      name: "git identity",
      status: "ok",
      message: `Ada <ada@example.com> (${repo})`,
    });
  });

  test("missing identity names exact repository-local fixes", () => {
    const repo = "/repo with spaces";
    const result = checkGitIdentity(() => ({ exitCode: 1, stdout: "", stderr: "" }), repo);
    expect(result.status).toBe("fail");
    expect(result.message).toContain(`git -C "${repo}" config user.name`);
    expect(result.message).toContain("user.email");
  });

  test("project registration distinguishes absent, missing, and non-git paths", () => {
    expect(checkProject(undefined, goodSpawn).message).toContain("wisp project add");
    expect(checkProject("/definitely/missing/wisp-project", goodSpawn).message).toContain("registered path is missing");
    const repo = mkdtempSync(join(tmpdir(), "wisp-project-"));
    expect(checkProject(repo, goodSpawn).status).toBe("ok");
    expect(checkProject(repo, () => ({ exitCode: 1, stdout: "", stderr: "" })).status).toBe("fail");
  });
});

describe("configuration", () => {
  test("missing config is an initialization blocker", () => {
    expect(checkConfigFile(missingFile("config.json"))).toEqual({
      name: "config.json",
      status: "fail",
      message: "not initialized — run 'wisp init'",
    });
  });

  test("valid, malformed, and unknown-key configs stay distinguishable", () => {
    expect(checkConfigFile(tempFile("config.json", '{"port":9000}')).status).toBe("ok");
    expect(checkConfigFile(tempFile("config.json", "{ nope")).status).toBe("fail");
    expect(checkConfigFile(tempFile("config.json", '{"prot":9000}')).status).toBe("warn");
  });

  test("an out-of-range value is a warning that names the field, the value and the range", () => {
    const result = checkConfigFile(tempFile("config.json", '{"setupTimeoutMinutes":0}'));
    expect(result.status).toBe("warn");
    // once, and with no second config.json prefix after the check's own name
    expect(result.message).toStartWith("setupTimeoutMinutes is 0 but must be a number of minutes above 0 and at most 35791");
    expect(checkConfigFile(tempFile("config.json", '{"port":"x"}')).message).toBe("port must be a number, got string");
  });

  test("missing adapters file means the builtins, not a failure", () => {
    const result = checkAdaptersFile(missingFile("adapters.json"));
    expect(result.status).toBe("ok");
    expect(result.message).toContain("builtin");
  });
});

describe("supervision and daemon", () => {
  test("recognizes the installed systemd user unit", () => {
    expect(checkSupervisor(goodSpawn, "linux")).toEqual({
      name: "supervisor",
      status: "ok",
      message: "systemd user service enabled (wisp.service)",
    });
  });

  test("foreground operation is an actionable warning, not an activation blocker", () => {
    expect(checkSupervisor(ENOENT, "linux").status).toBe("warn");
    expect(checkSupervisor(ENOENT, "darwin").message).toContain("brew services start wisp");
  });

  test("recognizes the Homebrew launchd service", () => {
    expect(checkSupervisor(goodSpawn, "darwin")).toEqual({
      name: "supervisor",
      status: "ok",
      message: "Homebrew launchd service started (wisp)",
    });
  });

  test("development mode never mistakes the production service for its supervisor", () => {
    expect(checkSupervisor(goodSpawn, "darwin", "wisp-dev")).toEqual({
      name: "supervisor",
      status: "warn",
      message: "development mode is foreground-only — keep 'wisp-dev serve' or 'bun run dev' running",
    });
  });

  test("daemon identity agrees with this build", async () => {
    const result = await checkDaemon({ host: "127.0.0.1", port: 8710 }, healthyFetch);
    expect(result.status).toBe("ok");
    expect(result.message).toContain(VERSION);
  });

  test("version or commit skew warns; unreachable and foreign ports fail", async () => {
    const stale = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, version: "0.0.9", commit: "abc" }),
    })) as unknown as typeof fetch;
    expect((await checkDaemon({ host: "127.0.0.1", port: 8710 }, stale)).status).toBe("warn");
    const down = (async () => {
      throw new Error("fetch failed");
    }) as unknown as typeof fetch;
    expect((await checkDaemon({ host: "127.0.0.1", port: 8710 }, down)).status).toBe("fail");
    const foreign = (async () => ({ ok: false, status: 503, json: async () => ({}) })) as unknown as typeof fetch;
    expect((await checkDaemon({ host: "127.0.0.1", port: 8710 }, foreign)).status).toBe("fail");
  });
});

describe("terminal origins (#139)", () => {
  const cfg = { host: "127.0.0.1", port: 8710, token: "doctor-token" };
  const answering = (status: number, body: unknown) =>
    (async (_input: string, init?: RequestInit) => {
      // The report is a POST on purpose: a browser omits Origin on a
      // same-origin GET, so only a POST sees the header a handshake sent.
      expect(init?.method).toBe("POST");
      expect((init?.headers as Record<string, string>).authorization).toBe(`Bearer ${cfg.token}`);
      return { ok: status < 400, status, json: async () => body };
    }) as unknown as typeof fetch;

  test("reports the origins the RUNNING daemon accepts, not this shell's environment", async () => {
    const unset = await checkTerminalOrigins(
      cfg,
      answering(200, { verdict: "absent", expected: "http://127.0.0.1:8710", allowed: [] }),
    );
    expect(unset.status).toBe("ok");
    expect(unset.message).toContain("http://127.0.0.1:8710");
    expect(unset.message).toContain("WISP_ALLOWED_ORIGINS unset in the daemon's environment");

    const configured = await checkTerminalOrigins(
      cfg,
      answering(200, {
        verdict: "absent",
        expected: "http://127.0.0.1:8710",
        allowed: ["https://wisp.example.ts.net"],
      }),
    );
    expect(configured.status).toBe("ok");
    expect(configured.message).toContain("https://wisp.example.ts.net");
  });

  test("an older daemon, an error, and an unreachable port all warn rather than guess", async () => {
    expect((await checkTerminalOrigins(cfg, answering(404, {}))).status).toBe("warn");
    expect((await checkTerminalOrigins(cfg, answering(500, {}))).status).toBe("warn");
    expect((await checkTerminalOrigins(cfg, answering(200, { allowed: [] }))).status).toBe("warn");
    const down = (async () => {
      throw new Error("fetch failed");
    }) as unknown as typeof fetch;
    expect((await checkTerminalOrigins(cfg, down)).status).toBe("warn");
  });

  test("runDoctor skips the report when the daemon itself is not answering", async () => {
    const repo = mkdtempSync(join(tmpdir(), "wisp-project-"));
    const down = (async () => {
      throw new Error("fetch failed");
    }) as unknown as typeof fetch;
    const checks = await runDoctor({
      spawn: goodSpawn,
      fetchFn: down,
      configPath: tempFile("config.json", JSON.stringify(config(repo))),
      adaptersPath: missingFile("adapters.json"),
      config: config(repo),
      adapters: { droid: DROID },
      selectedHarness: "droid",
      currentPlatform: "linux",
      currentArch: "x64",
    });
    expect(checks.find((check) => check.name === "daemon")?.status).toBe("fail");
    expect(checks.some((check) => check.name === "terminal origins")).toBe(false);
  });

  test("an ignored config value is reported once, in the report, not also on stderr", async () => {
    writeFileSync(CONFIG_PATH, JSON.stringify({ token: "t", setupTimeoutMinutes: -7 }));
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const checks = await runDoctor({
        spawn: goodSpawn,
        fetchFn: healthyFetch,
        adaptersPath: missingFile("adapters.json"),
        adapters: { droid: DROID },
        selectedHarness: "droid",
        currentPlatform: "linux",
        currentArch: "x64",
      });
      expect(checks.find((check) => check.name === "config.json")?.message).toContain("setupTimeoutMinutes is -7");
      expect(warn.mock.calls.filter(([message]) => String(message).includes("setupTimeoutMinutes is -7"))).toEqual([]);
    } finally {
      warn.mockRestore();
      rmSync(CONFIG_PATH, { force: true });
    }
  });

  test("a healthy daemon reports its origins in the activation output", async () => {
    const repo = mkdtempSync(join(tmpdir(), "wisp-project-"));
    const checks = await runDoctor({
      spawn: goodSpawn,
      fetchFn: healthyFetch,
      configPath: tempFile("config.json", JSON.stringify(config(repo))),
      adaptersPath: missingFile("adapters.json"),
      config: config(repo),
      adapters: { droid: DROID },
      selectedHarness: "droid",
      currentPlatform: "linux",
      currentArch: "x64",
    });
    expect(checks.find((check) => check.name === "terminal origins")?.status).toBe("ok");
    expect(checks.filter((check) => check.status === "fail")).toEqual([]);
  });
});

describe("activation receipt", () => {
  test("one selected authenticated harness is enough and Bun is not a prerequisite", async () => {
    const repo = mkdtempSync(join(tmpdir(), "wisp-project-"));
    const checks = await runDoctor({
      spawn: goodSpawn,
      fetchFn: healthyFetch,
      configPath: tempFile("config.json", JSON.stringify(config(repo))),
      adaptersPath: missingFile("adapters.json"),
      config: config(repo),
      adapters: { droid: DROID },
      selectedHarness: "droid",
      currentPlatform: "linux",
      currentArch: "x64",
    });
    expect(checks.find((check) => check.name === "activation")?.status).toBe("ok");
    expect(checks.find((check) => check.name === "activation")?.message).toContain("wisp new");
    expect(checks.some((check) => check.name === "bun")).toBe(false);
    expect(checks.filter((check) => check.status === "fail")).toEqual([]);
  });

  test("unused missing builtins warn but do not block a ready harness", async () => {
    const repo = mkdtempSync(join(tmpdir(), "wisp-project-"));
    const spawn: SpawnFn = (cmd) => {
      if (cmd[0] === "claude") throw new Error("ENOENT");
      return goodSpawn(cmd);
    };
    const checks = await runDoctor({
      spawn,
      fetchFn: healthyFetch,
      configPath: tempFile("config.json", JSON.stringify(config(repo))),
      adaptersPath: missingFile("adapters.json"),
      config: config(repo),
      adapters: { droid: DROID, claude: CLAUDE },
      currentPlatform: "linux",
      currentArch: "x64",
    });
    expect(checks.find((check) => check.name === "harness claude")?.status).toBe("warn");
    expect(checks.find((check) => check.name === "activation")?.status).toBe("ok");
  });

  test("a required missing harness creates a concise blocker receipt", async () => {
    const repo = mkdtempSync(join(tmpdir(), "wisp-project-"));
    const checks = await runDoctor({
      spawn: (cmd) => {
        if (cmd[0] === "claude") throw new Error("ENOENT");
        return goodSpawn(cmd);
      },
      fetchFn: healthyFetch,
      configPath: tempFile("config.json", JSON.stringify(config(repo))),
      adaptersPath: missingFile("adapters.json"),
      config: config(repo),
      adapters: { droid: DROID, claude: CLAUDE },
      selectedHarness: "claude",
      currentPlatform: "linux",
      currentArch: "x64",
    });
    expect(checks.find((check) => check.name === "harness claude")?.status).toBe("fail");
    const receipt = checks.at(-1)!;
    expect(receipt.name).toBe("activation");
    expect(receipt.status).toBe("fail");
    expect(receipt.message).toContain("harness claude");
    expect(receipt.message).toContain("wisp doctor --harness claude");
  });
});

describe("GitHub CLI", () => {
  test("missing gh is a warning, and its auth is not probed", () => {
    const seen: string[][] = [];
    const checks = checkGh((cmd) => {
      seen.push(cmd);
      throw new Error("ENOENT");
    });
    expect(checks).toEqual([expect.objectContaining({ name: "gh", status: "warn" })]);
    expect(seen).toEqual([["gh", "--version"]]);
  });

  test("a logged-out gh warns with the fix; a logged-in one is ok, read-only either way", () => {
    const answer = (loggedIn: boolean): SpawnFn => (cmd) =>
      cmd[1] === "--version"
        ? { exitCode: 0, stdout: "gh version 2.63.0 (2026-01-01)", stderr: "" }
        : loggedIn
          ? { exitCode: 0, stdout: "github.com\n  Logged in", stderr: "" }
          : { exitCode: 1, stdout: "", stderr: "You are not logged into any GitHub hosts." };
    const out = checkGh(answer(false));
    expect(out[0]).toMatchObject({ name: "gh", status: "ok", message: "gh 2.63.0" });
    expect(out[1]).toMatchObject({ name: "gh auth", status: "warn" });
    expect(out[1]!.message).toContain("gh auth login");
    expect(checkGh(answer(true))[1]).toMatchObject({ name: "gh auth", status: "ok" });

    const seen: string[][] = [];
    checkGh((cmd) => { seen.push(cmd); return answer(true)(cmd); });
    expect(seen).toEqual([["gh", "--version"], ["gh", "auth", "status"]]);
  });
});

describe("token strength", () => {
  test("a short hand-set token warns and names the rotation; a minted one is fine", () => {
    expect(checkToken({ token: "test" })).toMatchObject({ status: "warn" });
    expect(checkToken({ token: "test" }).message).toContain("wisp token --rotate");
    expect(checkToken({ token: crypto.randomUUID() }).status).toBe("ok");
  });
});

describe("every project is checked", () => {
  test("a broken project next to a healthy one warns; the healthy one is the handoff", async () => {
    const healthy = mkdtempSync(join(tmpdir(), "wisp-project-"));
    const missing = "/definitely/missing/wisp-project";
    const cfg = { ...config(missing), repos: [missing, healthy] };
    const checks = await runDoctor({
      spawn: goodSpawn,
      fetchFn: healthyFetch,
      configPath: tempFile("config.json", JSON.stringify(cfg)),
      adaptersPath: missingFile("adapters.json"),
      config: cfg,
      adapters: { droid: DROID },
      selectedHarness: "droid",
      currentPlatform: "linux",
      currentArch: "x64",
    });
    const projects = checks.filter((check) => check.name === "project");
    expect(projects.map((check) => check.status)).toEqual(["warn", "ok"]);
    expect(projects[0]!.message).toContain(missing);
    expect(checks.find((check) => check.name === "activation")).toMatchObject({ status: "ok" });
    expect(checks.find((check) => check.name === "activation")!.message).toContain(healthy);
  });

  test("with no healthy project, the first finding is still the blocker", async () => {
    const cfg = { ...config("/definitely/missing/one"), repos: ["/definitely/missing/one", "/definitely/missing/two"] };
    const checks = await runDoctor({
      spawn: goodSpawn,
      fetchFn: healthyFetch,
      configPath: tempFile("config.json", JSON.stringify(cfg)),
      adaptersPath: missingFile("adapters.json"),
      config: cfg,
      adapters: { droid: DROID },
      selectedHarness: "droid",
      currentPlatform: "linux",
      currentArch: "x64",
    });
    expect(checks.filter((check) => check.name === "project").map((check) => check.status)).toEqual(["fail", "fail"]);
    expect(checks.at(-1)).toMatchObject({ name: "activation", status: "fail" });
  });
});

describe("restarts and self-updates the daemon recorded", () => {
  const now = new Date("2026-09-01T12:00:00Z");
  const exit = (minutesAgo: number) => ({
    pid: 100 + minutesAgo,
    startedAt: "2026-09-01T00:00:00.000Z",
    version: "0.6.0",
    detectedAt: new Date(now.getTime() - minutesAgo * 60_000).toISOString(),
  });

  test("two unclean exits within the hour is a crash loop; one, or old ones, is not", () => {
    expect(checkRestarts(missingFile("daemon-exits.json"), now)).toMatchObject({ status: "ok", message: "no unclean daemon exit recorded" });
    const one = tempFile("daemon-exits.json", JSON.stringify({ exits: [exit(300), exit(10)] }));
    expect(checkRestarts(one, now).status).toBe("ok");
    const loop = tempFile("daemon-exits.json", JSON.stringify({ exits: [exit(50), exit(20), exit(5)] }));
    const finding = checkRestarts(loop, now, "darwin");
    expect(finding.status).toBe("warn");
    expect(finding.message).toContain("3 unclean daemon exits in the last hour");
    expect(finding.message).toContain("var/log/wisp.log");
    expect(checkRestarts(loop, now, "linux").message).toContain("journalctl --user -u wisp.service");
  });

  test("the last self-update is reported only when one was recorded, and a failure warns with its error", () => {
    expect(checkLastUpdate(missingFile("update-last.json"), now)).toBeNull();
    const attempt = {
      fromVersion: "0.6.0",
      toVersion: "0.6.1",
      method: "homebrew",
      startedAt: "2026-09-01T11:00:00.000Z",
      finishedAt: "2026-09-01T11:02:00.000Z",
      outcome: "failed",
      error: "brew upgrade Pepewitch/tap/wisp exited 1: Error: tap unavailable",
    };
    const failed = checkLastUpdate(tempFile("update-last.json", JSON.stringify(attempt)), now)!;
    expect(failed.status).toBe("warn");
    expect(failed.message).toContain("0.6.0 → 0.6.1 failed");
    expect(failed.message).toContain("tap unavailable");
    const installed = checkLastUpdate(tempFile("update-last.json", JSON.stringify({ ...attempt, outcome: "installed", error: null })), now)!;
    expect(installed.status).toBe("ok");
    const stranded = checkLastUpdate(tempFile("update-last.json", JSON.stringify({ ...attempt, outcome: "installing", finishedAt: null })), now)!;
    expect(stranded).toMatchObject({ status: "warn" });
    expect(stranded.message).toContain("never finished");
  });
});

describe("background work, as the running daemon reports it", () => {
  const cfg = { host: "127.0.0.1", port: 8710, token: "test" };
  const now = new Date("2026-09-01T12:00:00Z");
  const ago = (seconds: number) => new Date(now.getTime() - seconds * 1000).toISOString();
  const answering = (status: number, body: unknown) =>
    (async () => ({ ok: status >= 200 && status < 300, status, json: async () => body })) as unknown as typeof fetch;
  const healthyLoop = (name: string) => ({ name, lastSuccessAt: ago(5), lastFailureAt: null, lastError: null, consecutiveFailures: 0 });
  const noWebhookTrouble = { failing: 0, dead: 0, oldestAt: null, lastError: null };

  test("healthy loops and no failing webhooks are two ok lines", async () => {
    const checks = await checkDaemonDiagnostics(
      cfg,
      answering(200, { pid: 1, startedAt: ago(600), uptimeSeconds: 600, loops: [healthyLoop("webhook delivery")], webhooks: noWebhookTrouble }),
      now,
    );
    expect(checks.map((check) => [check.name, check.status])).toEqual([["background loops", "ok"], ["webhooks", "ok"]]);
    expect(checks[0]!.message).toContain("webhook delivery 5 s ago");
  });

  test("a failing loop, a stalled loop and undelivered webhooks each warn", async () => {
    const checks = await checkDaemonDiagnostics(
      cfg,
      answering(200, {
        pid: 1,
        startedAt: ago(7200),
        uptimeSeconds: 7200,
        loops: [
          { name: "autopilot check", lastSuccessAt: ago(100), lastFailureAt: ago(5), lastError: "gh: not logged in", consecutiveFailures: 4 },
          { name: "stuck detection", lastSuccessAt: ago(3600), lastFailureAt: null, lastError: null, consecutiveFailures: 0 },
        ],
        webhooks: { failing: 2, dead: 1, oldestAt: ago(3600), lastError: "webhook 1 (https://hooks.example.com/…): HTTP 500" },
      }),
      now,
    );
    expect(checks[0]).toMatchObject({ name: "background loops", status: "warn" });
    expect(checks[0]!.message).toContain("autopilot check failed 4 passes in a row: gh: not logged in");
    expect(checks[0]!.message).toContain("stalled: stuck detection (last success 60 min ago)");
    expect(checks[1]).toMatchObject({ name: "webhooks", status: "warn" });
    expect(checks[1]!.message).toContain("2 failing and still retried, 1 given up on");
    expect(checks[1]!.message).toContain("HTTP 500");
  });

  test("an older daemon, an error and an unreachable one warn rather than guess", async () => {
    expect((await checkDaemonDiagnostics(cfg, answering(404, {}), now))[0]!.message).toContain("restart it");
    expect((await checkDaemonDiagnostics(cfg, answering(500, {}), now))[0]!.status).toBe("warn");
    expect((await checkDaemonDiagnostics(cfg, answering(200, { ok: true }), now))[0]!.status).toBe("warn");
    const down = (async () => { throw new Error("fetch failed"); }) as unknown as typeof fetch;
    expect((await checkDaemonDiagnostics(cfg, down, now))[0]!.status).toBe("warn");
  });
});
