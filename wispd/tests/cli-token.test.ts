import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const INSTANCE_ID = "123e4567-e89b-42d3-a456-426614174000";
const ENTRYPOINT = join(import.meta.dir, "../src/index.ts");
const HOME_LOCK = new URL("../src/home-lock.ts", import.meta.url).href;

describe("wisp token", () => {
  test("--rotate replaces only the persisted token and explains the restart boundary", async () => {
    const home = mkdtempSync(join(tmpdir(), "wisp-token-rotate-"));
    const configPath = join(home, "config.json");
    const original = {
      instanceId: INSTANCE_ID,
      host: "127.0.0.1",
      port: 18710,
      token: "leaked-token",
      repos: ["/example/repo"],
    };
    writeFileSync(join(home, "instance-id"), `${INSTANCE_ID}\n`, { mode: 0o600 });
    writeFileSync(configPath, JSON.stringify(original), { mode: 0o644 });

    try {
      const child = Bun.spawn({
        cmd: [process.execPath, ENTRYPOINT, "token", "--rotate"],
        env: { ...process.env, WISP_HOME: home },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);

      expect(exitCode, stderr).toBe(0);
      const token = stdout.match(/^token: ([0-9a-f]{32})$/m)?.[1];
      expect(token).toBeDefined();
      expect(token).not.toBe(original.token);
      expect(stdout).toContain("Start the Wisp daemon again now.");
      expect(stdout).toContain("The old token is invalid after startup.");
      expect(stdout).toContain("Update every browser and saved Desktop connection");

      expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({ ...original, token });
      expect(statSync(configPath).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("--rotate refuses while the daemon owns the Wisp home", async () => {
    const home = mkdtempSync(join(tmpdir(), "wisp-token-busy-"));
    const configPath = join(home, "config.json");
    const original = { instanceId: INSTANCE_ID, host: "127.0.0.1", port: 18710, token: "current-token" };
    writeFileSync(join(home, "instance-id"), `${INSTANCE_ID}\n`, { mode: 0o600 });
    writeFileSync(configPath, JSON.stringify(original), { mode: 0o600 });
    const holder = Bun.spawn({
      cmd: [
        process.execPath,
        "-e",
        `const { acquireHomeOwnership } = await import(${JSON.stringify(HOME_LOCK)}); acquireHomeOwnership(); console.log("ready"); await new Promise(() => {});`,
      ],
      env: { ...process.env, WISP_HOME: home },
      stdout: "pipe",
      stderr: "pipe",
    });

    try {
      const reader = holder.stdout.getReader();
      const ready = await reader.read();
      reader.releaseLock();
      expect(new TextDecoder().decode(ready.value)).toContain("ready");

      const child = Bun.spawn({
        cmd: [process.execPath, ENTRYPOINT, "token", "--rotate"],
        env: { ...process.env, WISP_HOME: home },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited]);

      expect(exitCode).toBe(1);
      expect(stderr).toContain("cannot rotate the token while the daemon is running");
      expect(stderr).toContain("stop it first");
      expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual(original);
    } finally {
      holder.kill();
      await holder.exited;
      rmSync(home, { recursive: true, force: true });
    }
  });
});
