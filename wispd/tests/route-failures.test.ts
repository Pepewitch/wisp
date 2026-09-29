/**
 * A route that throws answers 500, as it always did, and now also leaves a
 * trace in the daemon log: method, path and stack. Nothing was logged before,
 * so the operator had a one-line client message and nothing to correlate.
 */
import { afterEach, expect, spyOn, test } from "bun:test";
import { writeFileSync } from "node:fs";

import { CONFIG_PATH } from "../src/config";
import { serve } from "../src/daemon";
import type { UpdateManager } from "../src/update";

const TOKEN = "route-failure-test-token";
let server: Awaited<ReturnType<typeof serve>> | null = null;

afterEach(async () => {
  if (server) await server.stop(true);
  server = null;
});

test("a route that throws is a 500 for the client and a logged stack for the operator, without the query or the token", async () => {
  writeFileSync(CONFIG_PATH, JSON.stringify({
    port: 18710, host: "127.0.0.1", token: TOKEN, webhooks: [], stuckMinutes: 10,
    logMaxBytes: 5_000_000, setupTimeoutMinutes: 10, envAllowlist: {}, harnessDefaults: {},
  }));
  const updateManager = {
    getStatus: () => Promise.reject(new Error("update status exploded")),
  } as unknown as UpdateManager;
  server = await serve({
    port: 0,
    updateManager,
    proseBackfill: false,
    modelProbeSpawn: () => {
      throw new Error("no model probes in the route failure test");
    },
  });
  const logged = spyOn(console, "error").mockImplementation(() => {});
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/update?note=private-words`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "update status exploded" });
    const lines = logged.mock.calls.map((call) => String(call[0]));
    const report = lines.find((line) => line.startsWith("[wisp] GET /api/update failed: "));
    expect(report).toBeDefined();
    expect(report).toContain("Error: update status exploded");
    expect(report).toContain("route-failures.test.ts"); // the stack
    expect(lines.join("\n")).not.toContain("private-words");
    expect(lines.join("\n")).not.toContain(TOKEN);
  } finally {
    logged.mockRestore();
  }
});
