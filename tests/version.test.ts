import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BUILD_COMMIT, BUILD_DIRTY, BUILD_INFO, VERSION, versionLine } from "../src/version";

describe("build identity", () => {
  test("the source tree is explicit about not being a release artifact", () => {
    expect(BUILD_INFO).toEqual({
      version: "0.4.0-alpha.7",
      commit: "unknown",
      dirty: true,
    });
    expect(BUILD_COMMIT).toBe("unknown");
    expect(BUILD_DIRTY).toBe(true);
    expect(VERSION).toBe("0.4.0-alpha.7");
    expect(versionLine()).toBe("0.4.0-alpha.7 (commit unknown, dirty)");
  });

  test("package.json carries the same release version", async () => {
    const pkg = (await Bun.file(new URL("../package.json", import.meta.url)).json()) as { version?: string };
    expect(pkg.version).toBe(VERSION);
  });

  test("version inspection does not initialize a read-only home", () => {
    const home = mkdtempSync(join(tmpdir(), "wisp-version-home-"));
    chmodSync(home, 0o500);
    const env = { ...process.env, HOME: home };
    delete env.WISP_HOME;
    try {
      const result = Bun.spawnSync({
        cmd: ["bun", "src/index.ts", "version", "--json"],
        cwd: resolve(import.meta.dir, ".."),
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(Buffer.from(result.stdout).toString("utf8"))).toEqual(BUILD_INFO);
      expect(Buffer.from(result.stderr).toString("utf8")).toBe("");
      expect(existsSync(join(home, ".wisp"))).toBe(false);
    } finally {
      chmodSync(home, 0o700);
    }
  });
});
