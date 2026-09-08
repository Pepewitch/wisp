/**
 * `harness:snapshot` — extraction, the graded diff, and the escalation rules.
 *
 * The extractor cases feed each harness's real output shape through an
 * injected spawn, so the parsers are pinned against what the CLIs actually
 * print without any test ever launching one.
 */
import { describe, expect, test } from "bun:test";
import type { AdapterDef, ModelProbeSpawnFn } from "../src/adapters";
import { BUILTIN_ADAPTERS } from "../src/adapters";
import { adapterFlags, diffFacts, worstSeverity } from "../scripts/harness/diff";
import { EXTRACTORS, effortValuesFromRejection, flagsFromHelp } from "../scripts/harness/extract";
import { mergeSurfaces, renderChanges, renderLivePins } from "../scripts/harness/snapshot";
import type { HarnessFacts, Surface } from "../scripts/harness/facts";

/** Routes each expected argv to a canned result, so order never matters. */
function routedSpawn(routes: { match: (cmd: string[]) => boolean; stdout?: string; stderr?: string; exitCode?: number }[]): ModelProbeSpawnFn {
  return async (cmd) => {
    const hit = routes.find((r) => r.match(cmd));
    return { exitCode: hit?.exitCode ?? 0, stdout: hit?.stdout ?? "", stderr: hit?.stderr ?? "" };
  };
}

const facts = (surfaces: Record<string, Surface>): HarnessFacts => ({ harness: "codex", bin: "codex", surfaces });
const free = (lists: Record<string, string[]>, scalars?: Record<string, string | null>): Surface => ({
  cost: "free",
  verifiedAgainst: "1.0.0",
  source: "s",
  lists,
  ...(scalars ? { scalars } : {}),
});

describe("flagsFromHelp", () => {
  test("takes flag tokens and nothing else — the regex is the allowlist", () => {
    const help = [
      "  -o, --output-format <format>  Output format (default: \"text\")",
      "  -m, --model <id>              Model ID (default: /Users/someone/.config/model)",
      "      --skip-permissions-unsafe  Bypass",
    ].join("\n");
    const flags = flagsFromHelp(help);
    expect(flags).toEqual(["--model", "--output-format", "--skip-permissions-unsafe", "-m", "-o"]);
  });

  test("a home path in a default value can never reach the facts", () => {
    expect(flagsFromHelp("--config (default: /Users/pepe/.factory/settings.json)")).toEqual(["--config"]);
  });
});

describe("effortValuesFromRejection", () => {
  test("reads droid's own rejection text", () => {
    const stderr = [
      "Unsupported reasoning effort provided",
      "Allowed values: none, dynamic, off, minimal, low, medium, high, xhigh, max",
      "Invalid enum value. Expected 'none' | 'dynamic', received 'bogus'",
    ].join("\n");
    expect(effortValuesFromRejection(stderr)).toEqual([
      "dynamic",
      "high",
      "low",
      "max",
      "medium",
      "minimal",
      "none",
      "off",
      "xhigh",
    ]);
  });

  test("no allowed-values block yields nothing rather than a guess", () => {
    expect(effortValuesFromRejection("some other error")).toEqual([]);
  });
});

describe("extractors", () => {
  test("droid reads its catalog out of the invalid-model rejection", async () => {
    const spawn = routedSpawn([
      { match: (c) => c.includes("--help"), stdout: "  -m, --model <id>  Model ID to use (default: gpt-5.6-sol)" },
      {
        match: (c) => c.includes("-m"),
        stderr: "Invalid model: x\n\nAvailable built-in models:\n  auto, gpt-6-astra, kimi-k3\n",
      },
      { match: (c) => c.includes("-r"), stderr: "Allowed values: low, high" },
    ]);
    const surfaces = await EXTRACTORS.droid!({ def: BUILTIN_ADAPTERS.droid!, binPath: null, spawn });
    expect(surfaces.models!.lists!.ids).toEqual(["auto", "gpt-6-astra", "kimi-k3"]);
    expect(surfaces.models!.scalars!.default).toBe("gpt-5.6-sol");
    expect(surfaces.effortLevels!.lists!.observed).toEqual(["high", "low"]);
  });

  test("codex takes the union of per-model reasoning levels", async () => {
    const catalog = JSON.stringify({
      models: [
        { slug: "gpt-6-astra", visibility: "list", priority: 1, supported_reasoning_levels: [{ effort: "low" }, { effort: "ultra" }] },
        { slug: "hidden", visibility: "hide", priority: 2, supported_reasoning_levels: [{ effort: "high" }] },
      ],
    });
    const spawn = routedSpawn([
      { match: (c) => c.includes("models"), stdout: catalog },
      { match: (c) => c.includes("--help"), stdout: "--json  -m" },
    ]);
    const surfaces = await EXTRACTORS.codex!({ def: BUILTIN_ADAPTERS.codex!, binPath: null, spawn });
    // hidden models still contribute effort levels: the enum is not the picker
    expect(surfaces.effortLevels!.lists!.observed).toEqual(["high", "low", "ultra"]);
    expect(surfaces.models!.scalars!.default).toBe("gpt-6-astra");
  });

  test("claude reads effort off --help, never by risking a real turn", async () => {
    const help = "  --effort <level>   Effort level for the current session\n                     (low, medium, high, xhigh, max)";
    const spawn = routedSpawn([{ match: () => true, stdout: help }]);
    const surfaces = await EXTRACTORS.claude!({ def: BUILTIN_ADAPTERS.claude!, binPath: null, spawn });
    expect(surfaces.effortLevels!.lists!.observed).toEqual(["high", "low", "max", "medium", "xhigh"]);
  });

  test("cursor parses '<id> - <display name>' and ignores the heading", async () => {
    const listing = "Available models\n\nauto - Auto (default)\ncomposer-2.5 - Composer 2.5\n";
    const spawn = routedSpawn([{ match: (c) => c.includes("models"), stdout: listing }]);
    const surfaces = await EXTRACTORS.cursor!({ def: BUILTIN_ADAPTERS.cursor!, binPath: null, spawn });
    expect(surfaces.models!.lists!.ids).toEqual(["auto", "composer-2.5"]);
  });

  test("marker presence splits declared markers by whether the binary still ships them", async () => {
    const spawn = routedSpawn([
      { match: (c) => c[0] === "grep" && c.includes("usage limit"), exitCode: 0 },
      { match: (c) => c[0] === "grep", exitCode: 1 },
      { match: () => true, stdout: "" },
    ]);
    const surfaces = await EXTRACTORS.droid!({ def: BUILTIN_ADAPTERS.droid!, binPath: "/bin/fake", spawn });
    expect(surfaces.markerPresence!.lists!.present).toEqual(["usage limit"]);
    expect(surfaces.markerPresence!.lists!.missing).toContain("out of credits");
  });
});

describe("mergeSurfaces", () => {
  test("carries live surfaces forward untouched and re-pins the free ones", () => {
    const previous = facts({
      models: free({ ids: ["a"] }),
      fixtures: { cost: "live", verifiedAgainst: "0.149.0", source: "captures" },
    });
    const merged = mergeSurfaces(previous, { models: free({ ids: ["a", "b"] }) }, "0.153.4");
    expect(merged.surfaces.fixtures!.verifiedAgainst).toBe("0.149.0");
    expect(merged.surfaces.models!.verifiedAgainst).toBe("0.153.4");
  });

  test("a free surface the extractor could not read drops out rather than going stale", () => {
    const previous = facts({ models: free({ ids: ["a"] }) });
    expect(mergeSurfaces(previous, {}, "2.0.0").surfaces.models).toBeUndefined();
  });
});

describe("the graded diff", () => {
  const def = BUILTIN_ADAPTERS.codex!;

  test("a first capture is not a change", () => {
    const before = facts({ models: { cost: "free", verifiedAgainst: null, source: "s" } });
    const after = facts({ models: free({ ids: ["a"] }) });
    expect(diffFacts(before, after, def)).toEqual([]);
  });

  test("a new model grades as catalog", () => {
    const changes = diffFacts(facts({ models: free({ ids: ["a"] }) }), facts({ models: free({ ids: ["a", "b"] }) }), def);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.severity).toBe("catalog");
    expect(changes[0]!.values).toEqual(["b"]);
  });

  test("a dropped model that staticModels still offers escalates to breaking", () => {
    const pinned: AdapterDef = { ...def, staticModels: ["gone"] };
    const changes = diffFacts(facts({ models: free({ ids: ["gone"] }) }), facts({ models: free({ ids: [] }) }), pinned);
    expect(changes[0]!.severity).toBe("breaking");
    expect(changes[0]!.reason).toContain("fails pre-flight");
  });

  test("a dropped flag Wisp passes is breaking; one it never passes is not", () => {
    const used = adapterFlags(def)[0]!;
    const breaking = diffFacts(
      facts({ flags: free({ values: [used, "--unused-by-wisp"] }) }),
      facts({ flags: free({ values: [] }) }),
      def,
    );
    expect(breaking[0]!.severity).toBe("breaking");
    expect(breaking[0]!.reason).toContain(used);

    const harmless = diffFacts(
      facts({ flags: free({ values: ["--unused-by-wisp"] }) }),
      facts({ flags: free({ values: [] }) }),
      def,
    );
    expect(harmless[0]!.severity).toBe("capability");
  });

  test("a marker that stopped shipping is breaking — the failure it classifies goes unrecognised", () => {
    const changes = diffFacts(
      facts({ markerPresence: free({ present: ["usage limit"], missing: [] }) }),
      facts({ markerPresence: free({ present: [], missing: ["usage limit"] }) }),
      def,
    );
    expect(worstSeverity(changes)).toBe("breaking");
  });

  test("a moved default model is reported with both values", () => {
    const changes = diffFacts(
      facts({ models: free({ ids: ["a"] }, { default: "a" }) }),
      facts({ models: free({ ids: ["a"] }, { default: "b" }) }),
      def,
    );
    expect(changes[0]!.values).toEqual(["a → b"]);
  });

  test("live surfaces are never diffed — they are pins, not observations", () => {
    const before = facts({ fixtures: { cost: "live", verifiedAgainst: "1", source: "s", lists: { files: ["a"] } } });
    const after = facts({ fixtures: { cost: "live", verifiedAgainst: "1", source: "s", lists: { files: ["b"] } } });
    expect(diffFacts(before, after, def)).toEqual([]);
  });
});

describe("the snapshot report", () => {
  test("an empty diff says the CLI update is irrelevant, in those words", () => {
    expect(renderChanges("codex", "0.153.4", []).join("\n")).toContain("irrelevant to Wisp");
  });

  test("a baseline is called a first capture, not 'no change'", () => {
    const text = renderChanges("codex", "0.153.4", [], ["models"]).join("\n");
    expect(text).toContain("first capture");
    expect(text).not.toContain("no change");
  });

  test("the verdict names the next action, so the guide is optional", () => {
    const changes = diffFacts(facts({ models: free({ ids: [] }) }), facts({ models: free({ ids: ["new"] }) }), BUILTIN_ADAPTERS.codex!);
    expect(renderChanges("codex", "0.153.4", changes).join("\n")).toContain("src/adapters/builtins.ts");
  });

  test("stale live pins are flagged without being re-run", () => {
    const text = renderLivePins(
      facts({ fixtures: { cost: "live", verifiedAgainst: "0.149.0", source: "s" } }),
      "0.153.4",
    ).join("\n");
    expect(text).toContain("each costs a turn");
    expect(text).toContain("→ stale");
  });
});
