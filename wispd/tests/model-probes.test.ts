import { describe, expect, test } from "bun:test";
import { BUILTIN_ADAPTERS, DROID_MODEL_PROBE_SENTINEL, type AdapterDef } from "../src/adapters";
import { ModelProbeCache, type ModelProbeCacheOptions } from "../src/model-probes";
import type { SpawnFn } from "../src/doctor";

const help = "  -m, --model <id>  Model ID to use (default: gpt-5.6-sol)\n";
const errorText = "Invalid model\nAvailable built-in models:\n  auto, gpt-6-astra, gpt-5.6-sol, kimi-k3\n";

function droidSpawn(seen: string[][] = []): SpawnFn {
  return (cmd) => {
    seen.push(cmd);
    if (cmd.includes("--help")) return { exitCode: 0, stdout: help, stderr: "" };
    if (cmd.includes(DROID_MODEL_PROBE_SENTINEL)) return { exitCode: 1, stdout: "", stderr: errorText };
    throw new Error(`unexpected command: ${cmd.join(" ")}`);
  };
}

describe("daemon model probe cache", () => {
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

  test("probe failure leaves models null and records an honest error", async () => {
    const cache = new ModelProbeCache(
      { codex: BUILTIN_ADAPTERS.codex },
      { spawn: () => { throw new Error("permission denied"); } },
    );
    await cache.refresh();
    expect(cache.snapshot("codex")).toEqual({ models: null, modelsError: "permission denied" });
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
