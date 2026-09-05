import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

describe("wisp init", () => {
  test("creates private state once and gives the activation handoff", () => {
    const home = mkdtempSync(join(tmpdir(), "wisp-init-"));
    const wispHome = join(home, ".wisp");
    const reserve = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const initialPort = reserve.port;
    reserve.stop(true);
    const run = (port = initialPort) => {
      const env = { ...process.env, HOME: home };
      delete env.WISP_HOME;
      return Bun.spawnSync({
        cmd: ["bun", "src/index.ts", "init", "--port", String(port)],
        cwd: resolve(import.meta.dir, ".."),
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
    };

    const first = run();
    expect(first.exitCode).toBe(0);
    const output = Buffer.from(first.stdout).toString("utf8");
    expect(output).toContain("Wisp home ready");
    expect(output).toContain("wisp project add /path/to/repo");
    expect(output).toContain("wisp doctor");
    expect(Buffer.from(first.stderr).toString("utf8")).toBe("");
    expect(statSync(wispHome).mode & 0o777).toBe(0o700);
    expect(statSync(join(wispHome, "config.json")).mode & 0o777).toBe(0o600);

    const configBefore = JSON.parse(readFileSync(join(wispHome, "config.json"), "utf8")) as {
      token: string;
      port: number;
    };
    expect(configBefore.port).toBe(initialPort);

    const second = run(initialPort === 18710 ? 18711 : 18710);
    expect(second.exitCode).toBe(0);
    expect(Buffer.from(second.stdout).toString("utf8")).toContain(`existing config kept port ${initialPort}`);
    const configAfter = JSON.parse(readFileSync(join(wispHome, "config.json"), "utf8")) as {
      token: string;
      port: number;
    };
    expect(configAfter).toEqual(configBefore);
  });
});
