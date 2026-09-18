import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILTIN_ADAPTERS, DROID_MODEL_PROBE_SENTINEL, type AdapterDef } from "../src/adapters";
import {
  bunModelProbeSpawn,
  MODEL_PROBE_MAX_BYTES,
  ModelProbeCache,
  type ModelProbeCacheOptions,
} from "../src/model-probes";
import type { SpawnFn } from "../src/doctor";
import { subscribe, type WispEvent } from "../src/events";

const help = "  -m, --model <id>  Model ID to use (default: gpt-5.6-sol)\n";
const errorText = "Invalid model\nAvailable built-in models:\n  auto, gpt-6-astra, gpt-5.6-sol, kimi-k3\n";
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function cachePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "wisp-model-probes-"));
  tempDirs.push(dir);
  return join(dir, "models.json");
}

function droidSpawn(seen: string[][] = []): SpawnFn {
  return (cmd) => {
    seen.push(cmd);
    if (cmd.includes("--help")) return { exitCode: 0, stdout: help, stderr: "" };
    if (cmd.includes(DROID_MODEL_PROBE_SENTINEL)) return { exitCode: 1, stdout: "", stderr: errorText };
    throw new Error(`unexpected command: ${cmd.join(" ")}`);
  };
}

describe("daemon model probe cache", () => {
  test("production model probes stop on output floods", async () => {
    const error = await bunModelProbeSpawn(
      ["bash", "-c", `head -c ${MODEL_PROBE_MAX_BYTES + 1} /dev/zero | tr '\\0' x`],
    ).catch((value) => value instanceof Error ? value.message : String(value));
    expect(error).toContain("output budget");
  });

  test("populates from the named adapter strategy without making the first response wait", async () => {
    const cache = new ModelProbeCache({ droid: BUILTIN_ADAPTERS.droid }, { spawn: droidSpawn() });
    expect(cache.snapshot("droid").models).toBeNull();

    const pending = cache.refresh();
    expect(cache.snapshot("droid").models).toBeNull();
    await pending;

    expect(cache.snapshot("droid").models).toEqual({
      list: ["auto", "gpt-6-astra", "gpt-5.6-sol", "kimi-k3"],
      defaultModel: "gpt-5.6-sol",
      probedAt: expect.any(String),
    });
  });

  test("refresh replaces the old snapshot asynchronously and coalesces concurrent refreshes", async () => {
    let generation = 0;
    const spawn: SpawnFn = (cmd) => {
      if (cmd.includes("--help")) return { exitCode: 0, stdout: help.replace("gpt-5.6-sol", generation ? "next" : "first"), stderr: "" };
      return { exitCode: 1, stdout: "", stderr: `Available built-in models:\n  ${generation ? "next" : "first"}\n` };
    };
    const cache = new ModelProbeCache({ droid: BUILTIN_ADAPTERS.droid }, { spawn });
    await cache.refresh();
    expect(cache.snapshot("droid").models?.defaultModel).toBe("first");

    generation = 1;
    const first = cache.refresh();
    const second = cache.refresh();
    expect(second).toBe(first);
    expect(cache.snapshot("droid").models?.defaultModel).toBe("first");
    await first;
    expect(cache.snapshot("droid").models?.defaultModel).toBe("next");
  });

  test("announces changed model answers but not identical background refreshes", async () => {
    const events: WispEvent[] = [];
    const unsubscribe = subscribe((event) => events.push(event));
    const cache = new ModelProbeCache({ droid: BUILTIN_ADAPTERS.droid }, { spawn: droidSpawn() });
    try {
      await cache.refresh();
      expect(events).toEqual([{ type: "harnesses" }]);
      events.length = 0;

      await cache.refresh();
      expect(events).toEqual([]);
    } finally {
      unsubscribe();
    }
  });

  test("a reordered catalog is not announced, though the fresh order is kept", async () => {
    const events: WispEvent[] = [];
    const unsubscribe = subscribe((event) => events.push(event));
    const reversed = "Invalid model\nAvailable built-in models:\n  kimi-k3, gpt-5.6-sol, gpt-6-astra, auto\n";
    let generation = 0;
    const cache = new ModelProbeCache(
      { droid: BUILTIN_ADAPTERS.droid },
      {
        spawn: (cmd) => {
          if (generation && cmd.includes(DROID_MODEL_PROBE_SENTINEL)) {
            return { exitCode: 1, stdout: "", stderr: reversed };
          }
          return droidSpawn()(cmd);
        },
      },
    );
    try {
      await cache.refresh();
      events.length = 0;

      generation = 1;
      await cache.refresh();
      expect(events).toEqual([]);
      expect(cache.snapshot("droid").models?.list).toEqual(["kimi-k3", "gpt-5.6-sol", "gpt-6-astra", "auto"]);
    } finally {
      unsubscribe();
    }
  });

  test("loads a successful snapshot from disk and refreshes it only after it becomes stale", async () => {
    const path = cachePath();
    const now = new Date("2026-09-18T12:00:00.000Z");
    const adapters = { droid: BUILTIN_ADAPTERS.droid };
    const first = new ModelProbeCache(adapters, { cachePath: path, now: () => now, spawn: droidSpawn() });
    await first.refresh();

    let probes = 0;
    const restored = new ModelProbeCache(adapters, {
      cachePath: path,
      now: () => now,
      refreshIntervalMs: 60_000,
      spawn: (cmd) => {
        probes++;
        return droidSpawn()(cmd);
      },
    });
    expect(restored.snapshot("droid").models?.list).toEqual(["auto", "gpt-6-astra", "gpt-5.6-sol", "kimi-k3"]);
    await restored.refreshIfStale();
    expect(probes).toBe(0);

    now.setMinutes(now.getMinutes() + 2);
    await restored.refreshIfStale();
    expect(probes).toBe(2);
    expect(JSON.parse(readFileSync(path, "utf8")).entries.droid.models.probedAt).toBe(now.toISOString());
  });

  test("treats a future persisted timestamp as stale", async () => {
    const path = cachePath();
    const now = new Date("2026-09-18T12:00:00.000Z");
    const adapters = { droid: BUILTIN_ADAPTERS.droid };
    const future = new Date("2026-09-19T12:00:00.000Z");
    const first = new ModelProbeCache(adapters, { cachePath: path, now: () => future, spawn: droidSpawn() });
    await first.refresh();

    let probes = 0;
    const restored = new ModelProbeCache(adapters, {
      cachePath: path,
      now: () => now,
      spawn: (cmd) => {
        probes++;
        return droidSpawn()(cmd);
      },
    });
    await restored.refreshIfStale();
    expect(probes).toBe(2);
  });

  test("ignores persisted entries for a changed adapter", () => {
    const path = cachePath();
    writeFileSync(path, JSON.stringify({
      version: 1,
      entries: {
        droid: {
          adapterSignature: JSON.stringify(["different-droid", BUILTIN_ADAPTERS.droid.exec, BUILTIN_ADAPTERS.droid.model, "droid-models"]),
          models: { list: ["stale"], defaultModel: "stale", probedAt: "2026-09-18T12:00:00.000Z" },
        },
      },
    }));
    const cache = new ModelProbeCache({ droid: BUILTIN_ADAPTERS.droid }, { cachePath: path });
    expect(cache.snapshot("droid").models).toBeNull();
  });

  test("probe failure leaves models null and records an honest error", async () => {
    const cache = new ModelProbeCache(
      { codex: BUILTIN_ADAPTERS.codex },
      { spawn: () => { throw new Error("permission denied"); } },
    );
    await cache.refresh();
    expect(cache.snapshot("codex")).toEqual({ models: null, modelsError: "permission denied" });
  });

  test("probe failure keeps the last successful snapshot available", async () => {
    let fail = false;
    const cache = new ModelProbeCache(
      { droid: BUILTIN_ADAPTERS.droid },
      {
        spawn: (cmd) => {
          if (fail) throw new Error("temporarily unavailable");
          return droidSpawn()(cmd);
        },
      },
    );
    await cache.refresh();
    const successful = cache.snapshot("droid").models;
    fail = true;
    await cache.refresh();
    expect(cache.snapshot("droid")).toEqual({
      models: successful,
      modelsError: "temporarily unavailable",
    });
  });

  test("a hung injected probe is stopped by the per-probe timeout", async () => {
    const options: ModelProbeCacheOptions = {
      timeoutMs: 5,
      spawn: (_cmd, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
    };
    const def: AdapterDef = { bin: "fake", exec: [], parse: { format: "json" }, modelDiscovery: "codex-models" };
    const cache = new ModelProbeCache({ fake: def }, options);
    await cache.refresh();
    expect(cache.snapshot("fake").models).toBeNull();
    expect(cache.snapshot("fake").modelsError).toContain("timed out");
  });

  test("an adapter with no strategy still gets a successful empty cache", async () => {
    const cache = new ModelProbeCache({ claude: BUILTIN_ADAPTERS.claude }, { spawn: () => { throw new Error("must not spawn"); } });
    await cache.refresh();
    expect(cache.snapshot("claude").models?.list).toEqual([]);
    expect(cache.snapshot("claude").models?.defaultModel).toBeNull();
  });
});
