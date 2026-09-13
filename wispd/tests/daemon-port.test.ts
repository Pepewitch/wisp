import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { portConflictMessage } from "../src/daemon";

let listener: Bun.Server<unknown> | null = null;

afterEach(async () => {
  if (listener) await listener.stop(true);
  listener = null;
});

describe("daemon port conflicts", () => {
  test("identifies another Wisp daemon without stopping it", async () => {
    listener = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => Response.json({ ok: true, version: "9.8.7", commit: "a".repeat(40) }),
    });
    const port = listener.port;
    const home = mkdtempSync(join(tmpdir(), "wisp-port-conflict-"));
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({
        port,
        host: "127.0.0.1",
        token: "port-conflict-test",
        webhooks: [],
        repos: [],
        stuckMinutes: 10,
        logMaxBytes: 5_000_000,
        setupTimeoutMinutes: 10,
        envAllowlist: {},
        harnessDefaults: {},
      }),
    );

    const proc = Bun.spawn({
      cmd: ["bun", "src/index.ts", "serve"],
      cwd: resolve(import.meta.dir, ".."),
      env: { ...process.env, WISP_HOME: home },
      stdout: "pipe",
      stderr: "pipe",
    });
    const timeout = setTimeout(() => proc.kill(), 10_000);
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    clearTimeout(timeout);

    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain(`127.0.0.1:${port} is already in use by another Wisp daemon (9.8.7`);
    expect(stderr).toContain("Wisp did not stop that process or change the persisted port.");
    expect(stderr).toContain(join(home, "config.json"));
    expect((await fetch(`http://127.0.0.1:${port}/api/health`)).status).toBe(200);
  });

  test("classifies an unrelated HTTP listener as non-Wisp", async () => {
    listener = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("not wisp"),
    });
    const message = await portConflictMessage("127.0.0.1", listener.port);
    expect(message).toContain("already in use by a non-Wisp service");
    expect(message).toContain("Wisp did not stop that process");
  });
});

describe("daemon host binding", () => {
  test("refuses a non-loopback WISP_HOST override before listening", async () => {
    const home = mkdtempSync(join(tmpdir(), "wisp-host-bind-"));
    const configPath = join(home, "config.json");
    const originalConfig = JSON.stringify({ port: 18710, host: "127.0.0.1", token: "host-bind-test" });
    writeFileSync(configPath, originalConfig);
    try {
      const proc = Bun.spawn({
        cmd: ["bun", "src/index.ts", "serve"],
        cwd: resolve(import.meta.dir, ".."),
        env: { ...process.env, WISP_HOME: home, WISP_HOST: "0.0.0.0" },
        stdout: "pipe",
        stderr: "pipe",
      });
      const timeout = setTimeout(() => proc.kill(), 10_000);
      const [exitCode, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      clearTimeout(timeout);

      expect(exitCode).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toContain("WISP_HOST must be exactly 127.0.0.1");
      expect(stderr).toContain("Wisp refuses direct network binds");
      expect(stderr).not.toContain("wispd listening");
      expect(readFileSync(configPath, "utf8")).toBe(originalConfig);
      expect(existsSync(join(home, "instance-id"))).toBe(false);
      expect(existsSync(join(home, "daemon-owner.lock.db"))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
