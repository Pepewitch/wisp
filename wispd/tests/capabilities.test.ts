import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { CONFIG_PATH } from "../src/config";
import { serve } from "../src/daemon";
import { API_PROTOCOL_VERSION, BUILD_INFO } from "../src/version";

const TOKEN = "capability-test-token";
let server: Awaited<ReturnType<typeof serve>> | null = null;

afterEach(async () => {
  if (server) await server.stop(true);
  server = null;
  rmSync(CONFIG_PATH, { force: true });
});

async function startServer(): Promise<{ base: string; instanceId: string }> {
  writeFileSync(
    CONFIG_PATH,
    JSON.stringify({
      port: 18710,
      host: "127.0.0.1",
      token: TOKEN,
      webhooks: [],
      repos: [],
      stuckMinutes: 10,
      logMaxBytes: 5_000_000,
      setupTimeoutMinutes: 10,
      envAllowlist: {},
      harnessDefaults: {},
    }),
  );
  server = await serve({
    port: 0,
    modelProbeSpawn: () => {
      throw new Error("no model probes in capability contract test");
    },
  });
  const persisted = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as { instanceId: string };
  return { base: `http://127.0.0.1:${server.port}`, instanceId: persisted.instanceId };
}

describe("daemon capabilities", () => {
  test("requires normal daemon authentication and never accepts a query token", async () => {
    const { base, instanceId } = await startServer();
    expect(instanceId).toMatch(/^[0-9a-f-]{36}$/);

    expect((await fetch(`${base}/api/capabilities`)).status).toBe(401);
    expect(
      (
        await fetch(`${base}/api/capabilities`, {
          headers: { authorization: "Bearer wrong-token" },
        })
      ).status,
    ).toBe(401);
    expect((await fetch(`${base}/api/capabilities?token=${TOKEN}`)).status).toBe(401);

    const response = await fetch(`${base}/api/capabilities`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({
      apiProtocolVersion: API_PROTOCOL_VERSION,
      instanceId,
      ...BUILD_INFO,
      capabilities: {
        projects: true,
        projectRemoval: true,
        events: true,
        taskLogStreaming: true,
        terminal: true,
        attachments: true,
        managedUpdates: true,
      },
    });

    const session = await fetch(`${base}/api/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: TOKEN }),
    });
    const cookie = session.headers.get("set-cookie");
    expect(cookie).not.toBeNull();
    expect(
      (
        await fetch(`${base}/api/capabilities`, {
          headers: { cookie: cookie! },
        })
      ).status,
    ).toBe(200);
  });

  test("keeps identity and feature details out of the public health response", async () => {
    const { base } = await startServer();
    const health = (await (await fetch(`${base}/api/health`)).json()) as Record<string, unknown>;

    expect(health).toEqual({ ok: true, ...BUILD_INFO });
    expect(health).not.toHaveProperty("instanceId");
    expect(health).not.toHaveProperty("apiProtocolVersion");
    expect(health).not.toHaveProperty("capabilities");
  });

  test("does not expose the contract on unsupported methods", async () => {
    const { base } = await startServer();
    expect((await fetch(`${base}/api/capabilities`, { method: "POST" })).status).toBe(401);
    const response = await fetch(`${base}/api/capabilities`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not found" });
  });
});
