import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { wispCommand } from "../src/command";
import { VERSION } from "../src/version";

const ROOT = resolve(import.meta.dir, "..");

function output(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("utf8");
}

function freePort(): number {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = listener.port;
  listener.stop(true);
  return port;
}

describe("wisp command name", () => {
  test("accepts only the launcher sentinel", () => {
    expect(wispCommand({})).toBe("wisp");
    expect(wispCommand({ WISP_COMMAND_NAME: "anything-else" })).toBe("wisp");
    expect(wispCommand({ WISP_COMMAND_NAME: "wisp-dev" })).toBe("wisp-dev");
  });
});

describe("wisp-dev launcher", () => {
  test("overrides a global WISP_HOME and initializes only isolated development state", () => {
    const home = mkdtempSync(join(tmpdir(), "wisp-dev-home-"));
    const productionHome = join(home, ".wisp");
    const developmentHome = join(home, ".wisp-dev");
    const inheritedHome = join(home, ".wisp-from-shell");
    mkdirSync(productionHome);
    writeFileSync(join(productionHome, "witness"), "production\n");
    const port = freePort();

    const result = Bun.spawnSync({
      cmd: ["sh", "scripts/wisp-dev", "init"],
      cwd: ROOT,
      env: {
        ...process.env,
        HOME: home,
        WISP_HOME: inheritedHome,
        WISP_DEV_HOME: developmentHome,
        WISP_DEV_PORT: String(port),
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(0);
    expect(output(result.stderr)).toBe("");
    expect(output(result.stdout)).toContain(`Wisp home ready: ${developmentHome}`);
    expect(output(result.stdout)).toContain("wisp-dev project add");
    expect(JSON.parse(readFileSync(join(developmentHome, "config.json"), "utf8")).port).toBe(port);
    expect(readFileSync(join(productionHome, "witness"), "utf8")).toBe("production\n");
    expect(existsSync(join(productionHome, "config.json"))).toBe(false);
    expect(existsSync(inheritedHome)).toBe(false);
  });

  test("refuses the production home even when explicitly requested", () => {
    const home = mkdtempSync(join(tmpdir(), "wisp-dev-home-"));
    const productionHome = join(home, ".wisp");
    mkdirSync(productionHome);
    const result = Bun.spawnSync({
      cmd: ["sh", "scripts/wisp-dev", "version"],
      cwd: ROOT,
      env: {
        ...process.env,
        HOME: home,
        WISP_DEV_HOME: join(productionHome, "..", ".wisp"),
        WISP_PRODUCTION_HOME: productionHome,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(1);
    expect(output(result.stderr)).toContain("refusing production home");
  });

  test("installer creates a managed command that resolves this checkout", () => {
    const home = mkdtempSync(join(tmpdir(), "wisp-dev-install-"));
    const bin = join(home, "bin");
    const install = Bun.spawnSync({
      cmd: ["sh", "scripts/install-wisp-dev.sh"],
      cwd: ROOT,
      env: { ...process.env, HOME: home, WISP_DEV_BIN_DIR: bin },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(install.exitCode).toBe(0);

    const command = join(bin, "wisp-dev");
    const result = Bun.spawnSync({
      cmd: [command, "version", "--json"],
      cwd: home,
      env: { ...process.env, HOME: home, WISP_DEV_ROOT: ROOT },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(output(result.stdout))).toMatchObject({ version: VERSION, dirty: true });
    expect(output(result.stderr)).toBe("");
  });
});
