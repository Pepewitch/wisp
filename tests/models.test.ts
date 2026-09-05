import { describe, expect, test } from "bun:test";
import {
  BUILTIN_ADAPTERS,
  DROID_MODEL_PROBE_SENTINEL,
  discoverModels,
  validateAdapters,
  type AdapterDef,
} from "../src/adapters";
import type { SpawnFn } from "../src/doctor";
import { formatModelsReport, modelsReport, probeModels } from "../src/models";
import { fixture } from "./fixtures";

/**
 * The droid exec --help option lines, verbatim from droid 0.202.0 (plus the
 * JSON-RPC note line that also mentions --model): the -o line is a decoy
 * carrying its own "(default: …)", and the --spec-model/--worker-model lines
 * prove the parser keys on the --model line specifically.
 */
const DROID_HELP = `  -o, --output-format <format>  Output format (default: "text")
  --input-format <format>     Input format: stream-json for multi-turn sessions
  --auto <level>              Autonomy level: low|medium|high
  -s, --session-id <id>       Existing session to continue (requires a prompt)
  -m, --model <id>            Model ID to use (default: claude-opus-5)
  -r, --reasoning-effort <level>  Reasoning effort (defaults per model)
  --spec-model <id>           Model ID to use for spec mode (defaults to main model)
  --worker-model <id>         Model ID used by mission workers (only valid with --mission)
  -h, --help                  display help for command

Stream JSON-RPC Mode:
  CLI flags do not configure JSON-RPC sessions: -m/--model, --auto, -r/--reasoning-effort,
`;

/** Routes droid probe spawns: --help gets the help text; the sentinel-model exec gets the real captured error text. */
function droidSpawn(opts: { help?: string; errorText?: string; seen?: string[][] }): SpawnFn {
  return (cmd) => {
    opts.seen?.push(cmd);
    if (cmd.includes("--help")) return { exitCode: 0, stdout: opts.help ?? DROID_HELP, stderr: "" };
    if (cmd.includes(DROID_MODEL_PROBE_SENTINEL)) {
      return { exitCode: 1, stdout: "", stderr: opts.errorText ?? fixture("droid-unknown-model.stderr.txt") };
    }
    throw new Error(`unexpected spawn: ${cmd.join(" ")}`);
  };
}

const ENOENT: SpawnFn = (cmd) => {
  throw new Error(`spawnSync ${cmd[0]} ENOENT`);
};

const failIfSpawned: SpawnFn = (cmd) => {
  throw new Error(`must not spawn, but got: ${cmd.join(" ")}`);
};

describe("builtin wiring", () => {
  test("droid and codex name discovery strategies; claude honestly has none", async () => {
    expect(BUILTIN_ADAPTERS.droid.modelDiscovery).toBe("droid-models");
    expect(BUILTIN_ADAPTERS.codex.modelDiscovery).toBe("codex-models");
    expect(BUILTIN_ADAPTERS.claude.modelDiscovery).toBeUndefined();
  });
});

describe("droid-models strategy", () => {
  test("default comes from the --model line of exec --help, not other options' (default: …) text", async () => {
    const d = await discoverModels(BUILTIN_ADAPTERS.droid, droidSpawn({}));
    expect(d.defaultModel).toBe("claude-opus-5");
  });

  test("the model list is parsed from the real invalid-model error capture", async () => {
    const d = await discoverModels(BUILTIN_ADAPTERS.droid, droidSpawn({}));
    expect(d.models).not.toBeNull();
    // the fixture block lists 44 ids and repeats itself; the parse dedupes the repeat
    expect(d.models!.length).toBe(44);
    expect(d.models).toContain("auto");
    expect(d.models).toContain("claude-opus-5");
    expect(d.models).toContain("kimi-k3");
    expect(d.models).not.toContain(DROID_MODEL_PROBE_SENTINEL);
    expect(d.notes.join(" ")).toContain("invalid-model error text");
  });

  test("the sentinel probe rides the adapter's own exec/model argv templates", async () => {
    const seen: string[][] = [];
    await discoverModels(BUILTIN_ADAPTERS.droid, droidSpawn({ seen }));
    expect(seen[0]).toEqual([...["droid"], ...BUILTIN_ADAPTERS.droid.exec, "--help"]);
    expect(seen[1]).toEqual([
      "droid",
      "exec",
      "-o",
      "stream-json",
      "--skip-permissions-unsafe",
      "-m",
      DROID_MODEL_PROBE_SENTINEL,
      ".",
    ]);
  });

  test("a def without a model template is never probed (the probe would launch a REAL turn without -m)", async () => {
    const noModelTpl: AdapterDef = { ...BUILTIN_ADAPTERS.droid, model: undefined };
    const seen: string[][] = [];
    const d = await discoverModels(noModelTpl, droidSpawn({ seen }));
    expect(seen.every((cmd) => !cmd.includes(DROID_MODEL_PROBE_SENTINEL))).toBe(true);
    expect(d.defaultModel).toBe("claude-opus-5"); // help probe still runs
    expect(d.models).toBeNull();
    expect(d.notes.join(" ")).toContain("no model argv template");
  });

  test("changed help text: default is null with a note, never a guess", async () => {
    const d = await discoverModels(BUILTIN_ADAPTERS.droid, droidSpawn({ help: "  -m, --model <id>  Model ID to use\n" }));
    expect(d.defaultModel).toBeNull();
    expect(d.notes.join(" ")).toContain("named no default model");
  });

  test("changed error text: the list is null with a note, never a guess", async () => {
    const d = await discoverModels(BUILTIN_ADAPTERS.droid, droidSpawn({ errorText: "Invalid model: whatever\n" }));
    expect(d.models).toBeNull();
    expect(d.notes.join(" ")).toContain("no 'Available … models:' block");
  });
});

describe("codex-models strategy", () => {
  const catalog = (models: unknown[]) => JSON.stringify({ models });
  const codexSpawn = (stdout: string, exitCode = 0): SpawnFn => {
    return (cmd) => {
      expect(cmd).toEqual(["codex", "debug", "models"]);
      return { exitCode, stdout, stderr: "" };
    };
  };

  test("lists picker-visible models by catalog priority; default is the first of them", async () => {
    // priorities deliberately out of order; the hidden entry has the BEST
    // priority to prove visibility beats priority for the picker/default
    const d = await discoverModels(
      BUILTIN_ADAPTERS.codex,
      codexSpawn(
        catalog([
          { slug: "gpt-z", visibility: "list", priority: 9, supported_in_api: true },
          { slug: "gpt-a", visibility: "list", priority: 1, supported_in_api: true },
          { slug: "gpt-internal", visibility: "hide", priority: 0, supported_in_api: true },
        ]),
      ),
    );
    expect(d.models).toEqual(["gpt-a", "gpt-z"]);
    expect(d.defaultModel).toBe("gpt-a");
  });

  test("codex's own fallback: nothing picker-visible → first entry by priority", async () => {
    const d = await discoverModels(
      BUILTIN_ADAPTERS.codex,
      codexSpawn(catalog([{ slug: "gpt-hidden-b", visibility: "hide", priority: 2 }, { slug: "gpt-hidden-a", visibility: "hide", priority: 1 }])),
    );
    expect(d.defaultModel).toBe("gpt-hidden-a");
    expect(d.models).toEqual(["gpt-hidden-a", "gpt-hidden-b"]);
  });

  test("a missing visibility field predates picker hiding — treated as listed", async () => {
    const d = await discoverModels(BUILTIN_ADAPTERS.codex, codexSpawn(catalog([{ slug: "gpt-old", priority: 1 }])));
    expect(d.models).toEqual(["gpt-old"]);
    expect(d.defaultModel).toBe("gpt-old");
  });

  test("non-JSON output: nulls with a note naming the changed shape", async () => {
    const d = await discoverModels(BUILTIN_ADAPTERS.codex, codexSpawn("not json", 1));
    expect(d).toEqual({
      defaultModel: null,
      models: null,
      notes: ["'codex debug models' printed no JSON catalog (exit 1) — this codex version may not expose one"],
    });
  });

  test("a catalog without a models array: nulls with a note", async () => {
    const d = await discoverModels(BUILTIN_ADAPTERS.codex, codexSpawn("{}"));
    expect(d.models).toBeNull();
    expect(d.notes.join(" ")).toContain("no models array");
  });
});

describe("discoverModels without a strategy", () => {
  test("returns nulls without spawning anything (the claude case)", async () => {
    expect(await discoverModels(BUILTIN_ADAPTERS.claude, failIfSpawned)).toEqual({
      defaultModel: null,
      models: null,
      notes: [],
    });
  });
});

describe("probeModels", () => {
  test("a missing binary fails THAT harness loudly and leaves the others alone", async () => {
    const infos = await probeModels(
      { droid: BUILTIN_ADAPTERS.droid, claude: BUILTIN_ADAPTERS.claude },
      {},
      ENOENT,
    );
    const droid = infos.find((i) => i.name === "droid")!;
    expect(droid.probeError).toBe("'droid' not found on PATH");
    expect(droid.discovery).toBeNull();
    const claude = infos.find((i) => i.name === "claude")!; // no strategy → spawn never attempted
    expect(claude.probeError).toBeNull();
    expect(claude.discovery).toEqual({ defaultModel: null, models: null, notes: [] });
  });

  test("a non-ENOENT spawn failure keeps its raw message", async () => {
    const infos = await probeModels({ droid: BUILTIN_ADAPTERS.droid }, {}, () => {
      throw new Error("permission denied");
    });
    expect(infos[0]!.probeError).toBe("permission denied");
  });
});

describe("formatModelsReport — the effective-choice line", () => {
  const render = (
    adapters: Record<string, AdapterDef>,
    harnessDefaults: Parameters<typeof probeModels>[1],
    spawn: SpawnFn,
  ) => probeModels(adapters, harnessDefaults, spawn).then(formatModelsReport);

  test("config override beats a known harness default (the P5c example line)", async () => {
    const lines = await render({ droid: BUILTIN_ADAPTERS.droid }, { droid: { model: "kimi-k3" } }, droidSpawn({}));
    expect(lines).toContain("droid: effective kimi-k3 (from config; harness default claude-opus-5)");
    expect(lines).toContain("  harness default: claude-opus-5");
    expect(lines).toContain(
      "  config default: kimi-k3 — new tasks get this unless --model is passed (config.json harnessDefaults)",
    );
  });

  test("config override equal to the harness default says so", async () => {
    const lines = await render({ droid: BUILTIN_ADAPTERS.droid }, { droid: { model: "claude-opus-5" } }, droidSpawn({}));
    expect(lines).toContain("droid: effective claude-opus-5 (from config; same as the harness default)");
  });

  test("config override with no discoverable harness default names that gap", async () => {
    const lines = await render({ claude: BUILTIN_ADAPTERS.claude }, { claude: { model: "opus-5" } }, failIfSpawned);
    expect(lines).toContain("claude: effective opus-5 (from config; harness default not exposed by claude)");
  });

  test("no config override: the harness default wins and says no override exists", async () => {
    const lines = await render({ droid: BUILTIN_ADAPTERS.droid }, {}, droidSpawn({}));
    expect(lines).toContain("droid: effective claude-opus-5 (harness default; no config override)");
  });

  test("neither config nor a discoverable default: the report is honest and points at the fix", async () => {
    const lines = await render({ claude: BUILTIN_ADAPTERS.claude }, {}, failIfSpawned);
    expect(lines).toContain(
      "claude: effective <harness default> — claude exposes no default; no config override (pin one via config.json harnessDefaults or pass --model)",
    );
    expect(lines).toContain("  model list not exposed by claude — any id the CLI accepts works");
  });

  test("probe failure: the verdict line and detail say so instead of claiming 'not exposed'", async () => {
    const lines = await render({ droid: BUILTIN_ADAPTERS.droid }, { droid: { model: "kimi-k3" } }, ENOENT);
    expect(lines).toContain("droid: effective kimi-k3 (from config; harness default unknown (probe failed))");
    expect(lines).toContain("  probe failed: 'droid' not found on PATH");
    expect(lines.some((l) => l.includes("model list not exposed"))).toBe(false);
  });

  test("a config default the adapter cannot pass through carries the boot warning", async () => {
    const fake: AdapterDef = { bin: "fake", exec: [], parse: { format: "text" } };
    const lines = await render({ fake }, { fake: { model: "fake-7b" } }, failIfSpawned);
    expect(
      lines.some((l) => l.includes("config default: fake-7b") && l.includes("WARNING") && l.includes("no model argv template")),
    ).toBe(true);
  });

  test("header states the precedence; blocks are separated by blank lines", async () => {
    const lines = await render({ claude: BUILTIN_ADAPTERS.claude }, {}, failIfSpawned);
    expect(lines[0]).toBe(
      "precedence for new tasks: explicit --model > config.json harnessDefaults > the harness's own default",
    );
    expect(lines[1]).toBe("");
  });
});

describe("modelsReport", () => {
  test("harnessDefaults entries for unknown adapters are surfaced, not silently dropped", async () => {
    const lines = await modelsReport({ claude: BUILTIN_ADAPTERS.claude }, { ghost: { model: "x" } }, failIfSpawned);
    expect(lines.at(-1)).toBe("harnessDefaults entries naming no known adapter (ignored): ghost");
  });
});

describe("modelDiscovery validation (adapters.json merge contract)", () => {
  test("an unknown strategy name is rejected at load, naming the known ones", async () => {
    expect(() => validateAdapters({ droid: { modelDiscovery: "typo-models" } }, () => {})).toThrow(
      /adapter 'droid'\.modelDiscovery must name a builtin model-discovery strategy \(known: droid-models, codex-models\)/,
    );
  });

  test("a user adapter may name a builtin strategy; null clears a builtin's", async () => {
    const merged = validateAdapters(
      {
        fake: { bin: "bash", exec: [], parse: { format: "text" }, modelDiscovery: "codex-models" },
        droid: { modelDiscovery: null },
      },
      () => {},
    );
    expect(merged.fake!.modelDiscovery).toBe("codex-models");
    expect(merged.droid!.modelDiscovery).toBeNull();
    // and a cleared strategy means no discovery, no probing
    expect(await discoverModels(merged.droid!, failIfSpawned)).toEqual({ defaultModel: null, models: null, notes: [] });
  });

  test("a wrong-typed modelDiscovery is a named load error", async () => {
    expect(() => validateAdapters({ droid: { modelDiscovery: 42 } }, () => {})).toThrow(
      /adapter 'droid'\.modelDiscovery.*got number/,
    );
  });
});
