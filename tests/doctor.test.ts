import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdapterDef } from "../src/adapters";
import type { WispConfig } from "../src/config";
import {
  checkAdaptersFile,
  checkConfigFile,
  checkDaemon,
  checkGitBinary,
  checkGitIdentity,
  checkHarness,
  checkHarnessAuth,
  checkPlatform,
  checkProject,
  checkSupervisor,
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

const healthyFetch = (async () => ({
  ok: true,
  status: 200,
  json: async () => ({ ok: true, version: VERSION, commit: BUILD_COMMIT, dirty: true }),
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
