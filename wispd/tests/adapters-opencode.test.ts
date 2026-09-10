/**
 * opencode's adapter, asserted against output captured from opencode 1.18.29
 * (wispd/tests/fixtures/README.md names the exact commands). It lives in its
 * own file for the same reason the harness needed its own parse strategy: its
 * wire agrees with none of the other four, so none of adapters.test.ts's
 * shared setup applies to it.
 */
import { describe, expect, test } from "bun:test";
import {
  BUILTIN_ADAPTERS,
  buildArgv,
  buildAttachArgv,
  discoverModels,
  errorDetail,
  foldIncrementalOutcome,
  formatUsage,
  isLimitError,
  isTransientError,
  parseOutput,
  type ModelProbeSpawnFn,
} from "../src/adapters";
import { fixture } from "./fixtures";

/** Serves the captured `opencode models --verbose` catalog to the strategy. */
function catalogSpawn(stdout: string, seen?: string[][]): ModelProbeSpawnFn {
  return (cmd) => {
    seen?.push(cmd);
    return { exitCode: 0, stdout, stderr: "" };
  };
}

const opencode = BUILTIN_ADAPTERS.opencode!;

describe("opencode argv (opencode 1.18.29)", () => {
  // opencode 1.18.29: `run` is a subcommand, the bypass is --auto, and
  // --thinking is what makes reasoning reach the stream at all.
  test("opencode: run subcommand with --auto bypass, resume via -s, effort via --variant", () => {
    const opencode = BUILTIN_ADAPTERS.opencode!;
    expect(buildArgv(opencode, { prompt: "do it" })).toEqual([
      "opencode", "run", "--format", "json", "--thinking", "--auto", "do it",
    ]);
    expect(
      buildArgv(opencode, {
        prompt: "next",
        session: "ses_abc",
        model: "google/gemini-3.6-flash",
        effort: "high",
      }),
    ).toEqual([
      "opencode", "run", "--format", "json", "--thinking", "--auto",
      "-s", "ses_abc", "-m", "google/gemini-3.6-flash", "--variant", "high", "next",
    ]);
  });

  // The trailing "--" is load-bearing, not decoration: opencode's --file is
  // variadic AND validated before the message check, so without the separator
  // `-f a.png "prompt"` fails with `File not found: prompt` — the prompt gets
  // eaten. Proven on 1.18.29 without spending a turn.
  test("opencode: images ride argv, and the mandatory -- keeps the prompt out of --file", () => {
    const opencode = BUILTIN_ADAPTERS.opencode!;
    expect(opencode.image).toEqual(["-f", "{path}", "--"]);
    expect(opencode.imageInput).toBeUndefined();
    expect(opencode.imageDelivery).toBeUndefined();
    expect(buildArgv(opencode, { prompt: "what is this", images: ["/a.png", "/b.png"] })).toEqual([
      "opencode", "run", "--format", "json", "--thinking", "--auto",
      "-f", "/a.png", "/b.png", "--", "what is this",
    ]);
  });

  test("attach resumes the TUI on the stored session via the top-level flag", () => {
    // `--session` belongs to the default TUI command, not to `run`; verified
    // routed by `opencode --session <bogus>` answering "Session not found"
    expect(buildAttachArgv(opencode, "ses_abc")).toEqual(["opencode", "--session", "ses_abc"]);
  });

  // The absences are part of the contract: each one has a named refusal
  // downstream, and asserting them here is what stops a future edit from
  // quietly inventing a surface opencode does not have.
  test("the unverified surfaces stay absent rather than guessed", () => {
    expect(opencode.probe).toBeUndefined(); // `opencode stats` is lifetime, account-wide
    expect(opencode.skillDiscovery).toBeUndefined(); // no CLI list surface
    expect(opencode.compact).toBeUndefined(); // no headless compact
    expect(opencode.compactPrompt).toBeUndefined();
    expect(opencode.liveInput).toBeUndefined(); // no verified steering protocol
    expect(opencode.staticModels).toBeUndefined(); // the catalog is probed
    expect(opencode.parse.model).toBeUndefined(); // --format json reports none
    expect(opencode.auth).toBeNull(); // `auth list` exits 0 with zero credentials
  });
});

// opencode 1.18.29's `run --format json`. Every assertion below is against
// output captured from the installed CLI (wispd/tests/fixtures/README.md), not
// a hand-written approximation of it.
describe("parseOutput (opencode, captured fixtures)", () => {
  const opencode = BUILTIN_ADAPTERS.opencode!;

  // The fixture is a real 2-tool turn: read, write, then the answer. It pins
  // all three shapes that forced a strategy — the conclusion is on a `text`
  // event, settlement is a `step_finish`, and usage arrives once PER STEP.
  test("a multi-step turn concludes on the last message, not on its narration", () => {
    const p = parseOutput(opencode, fixture("opencode-tool-turn.jsonl"));
    expect(p.result).toBe("`a.txt` said: `hello`");
    expect(p.session).toBe("ses_opencodefixture0000000001");
    expect(p.isError).toBe(false);
    expect(p.needsInput).toBe(false);
    // --format json never reports the resolved model; the UI says "(requested)"
    expect(p.model).toBeNull();
    expect(p.skills).toBeNull();
  });

  test("usage is summed across every step, because opencode reports no turn total", () => {
    const p = parseOutput(opencode, fixture("opencode-tool-turn.jsonl"));
    // the raw blob keeps each step verbatim — three step_finish events
    expect((p.usage as { steps: unknown[] }).steps).toHaveLength(3);
    // 8556 + 9128 + 9518 input, 25 + 31 + 10 output, 386 + 249 + 150 reasoning
    expect(formatUsage(opencode, p.usage)).toEqual({
      inputTokens: 27_202,
      outputTokens: 66,
      reasoningTokens: 785,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
    });
  });

  test("cost stays in the raw blob and never reaches the normalized summary", () => {
    const p = parseOutput(opencode, fixture("opencode-tool-turn.jsonl"));
    const steps = (p.usage as { steps: { cost?: number }[] }).steps;
    expect(steps.every((step) => typeof step.cost === "number")).toBe(true);
    expect(JSON.stringify(formatUsage(opencode, p.usage))).not.toContain("cost");
  });

  test("a reasoning turn parses the same; thinking is activity, never the conclusion", () => {
    const p = parseOutput(opencode, fixture("opencode-thinking-turn.jsonl"));
    expect(p.result).toBe("17 × 23 = 17 × (20 + 3) = 340 + 51 = 391");
    expect(p.session).toBe("ses_opencodefixture0000000003");
    expect(p.isError).toBe(false);
  });

  test("a failed turn reports the error on stdout: no result, session still salvaged", () => {
    const p = parseOutput(opencode, fixture("opencode-unknown-model.jsonl"));
    expect(p.result).toBeNull();
    expect(p.isError).toBe(true);
    // the session survives even though the turn never produced a step
    expect(p.session).toBe("ses_opencodefixture0000000002");
    expect(p.usage).toBeNull();
  });

  test("an interrupted turn salvages the session from any event, not just the first", () => {
    // sessionID rides every event, so a turn cut off mid-stream still resumes
    const raw = fixture("opencode-tool-turn.jsonl").split("\n").slice(0, 2).join("\n");
    const p = parseOutput(opencode, raw);
    expect(p.session).toBe("ses_opencodefixture0000000001");
    expect(p.result).toBeNull();
  });

  // "tool-calls" is opencode's "the loop continues" reason. Treating it as
  // terminal would settle a turn on its first tool call and throw away the
  // answer; the recorder policy is where that distinction actually bites.
  test("a turn still mid-tool-call has not settled under the recorder policy", () => {
    const midTurn = fixture("opencode-tool-turn.jsonl").split("\n").slice(0, 3).join("\n");
    const settled = foldIncrementalOutcome(opencode, midTurn, "", "recorder-v1")!;
    expect(settled.outcome.isError).toBe(true); // no positive settlement yet
    const whole = foldIncrementalOutcome(opencode, fixture("opencode-tool-turn.jsonl"), "", "recorder-v1")!;
    expect(whole.outcome.isError).toBe(false);
    expect(whole.outcome.result).toBe("`a.txt` said: `hello`");
  });

  test("the usage formatter refuses a blob that is not opencode's step list", () => {
    expect(formatUsage(opencode, { input_tokens: 10 })).toBeNull();
    expect(formatUsage(opencode, { steps: [] })).toBeNull();
  });
});

// opencode writes a failed turn's cause to STDOUT and leaves stderr empty, so
// the generic stderr-tail fallback would surface nothing at all.
describe("errorDetail (opencode, captured fixtures)", () => {
  test("opencode: the cause is on STDOUT while stderr is empty, read from error.data.message", () => {
    const opencode = BUILTIN_ADAPTERS.opencode!;
    // the captured failure wrote nothing at all to stderr, so the tail
    // fallback would have surfaced nothing — the strategy is what names it
    expect(errorDetail(opencode, fixture("opencode-unknown-model.jsonl"), "")).toBe(
      "This model models/gemini-2.5-flash is no longer available to new users. " +
        "Please update your code to use models/gemini-3.6-flash for the latest features and improvements.",
    );
  });

  test("opencode: an error with no data.message falls back to the error's name", () => {
    const opencode = BUILTIN_ADAPTERS.opencode!;
    // opencode's own renderer uses exactly this precedence, so Wisp names a
    // failure the way opencode does rather than inventing a third wording
    const raw = `{"type":"error","sessionID":"ses_1","error":{"name":"GatewayRateLimitError"}}`;
    expect(errorDetail(opencode, raw, "")).toBe("GatewayRateLimitError");
    // and that name is exactly why "ratelimit" is a declared limit marker
    expect(isLimitError(opencode, "GatewayRateLimitError")).toBe(true);
  });

  // A REAL quota exhaustion, captured live on 2026-09-10 when the provider's
  // free tier ran out mid-bring-up. This is the marker set's strongest
  // evidence: the wording was derived from the shipped binary BEFORE this
  // failure happened, and the failure then matched it.
  test("opencode: a captured quota exhaustion is named and classified as a limit", () => {
    const detail = errorDetail(opencode, fixture("opencode-quota-exhausted.jsonl"), "");
    expect(detail).toStartWith("You exceeded your current quota");
    expect(isLimitError(opencode, detail!)).toBe(true);
    // and not mistaken for a retryable blip, which would auto-retry into the
    // same wall — even though the provider's own payload says isRetryable
    expect(isTransientError(opencode, detail!)).toBe(false);
  });

  test("opencode: quota wording classifies as a limit, overload wording as transient", () => {
    const opencode = BUILTIN_ADAPTERS.opencode!;
    expect(isLimitError(opencode, "Usage limit reached. It will reset in 3 hours.")).toBe(true);
    expect(isLimitError(opencode, "Rate limit exceeded")).toBe(true);
    expect(isTransientError(opencode, "Provider is overloaded")).toBe(true);
    // and an ordinary failure is neither — the prefixes must stay meaningful
    expect(isLimitError(opencode, "This model is no longer available to new users.")).toBe(false);
    expect(isTransientError(opencode, "This model is no longer available to new users.")).toBe(false);
  });
});

/**
 * What the picker offers. The rule: hide a model for what it IS (a permanent
 * fact the catalog states), never for whether it happens to answer right now
 * (a fact that changes minute to minute, and would hide the local model
 * someone is about to start a server for).
 */
describe("opencode model discovery (fail-open capability filter)", () => {
  const CATALOG = fixture("opencode-models-verbose.txt");

  test("one --verbose spawn answers both the id list and the capabilities", async () => {
    const seen: string[][] = [];
    await discoverModels(opencode, catalogSpawn(CATALOG, seen));
    expect(seen).toEqual([["opencode", "models", "--verbose"]]);
  });

  test("models that cannot run a coding turn are hidden", async () => {
    const { models } = await discoverModels(opencode, catalogSpawn(CATALOG));
    // every one of these is explicitly toolcall:false in the catalog
    expect(models).not.toContain("google/gemini-embedding-2");
    expect(models).not.toContain("google/veo-3.1-generate-preview");
    expect(models).not.toContain("google/gemini-3.1-flash-tts-preview");
  });

  test("ordinary chat models and the zero-credential Zen models stay", async () => {
    const { models } = await discoverModels(opencode, catalogSpawn(CATALOG));
    expect(models).toContain("google/gemini-3.6-flash");
    expect(models).toContain("opencode/nemotron-3.5-lightning-free");
  });

  // The filter's whole risk is hiding somebody's own provider, so this is the
  // case that matters most: a hand-written provider block in opencode.json can
  // describe its model with no capability metadata at all.
  test("a CUSTOM provider's model survives with no capability metadata", async () => {
    const { models } = await discoverModels(opencode, catalogSpawn(CATALOG));
    expect(models).toContain("llamacpp/qwen38"); // no `capabilities` key at all
    expect(models).toContain("mylocal/some-model"); // partial metadata
  });

  test("the note says how many were hidden, so a short list is never a mystery", async () => {
    const { models, notes } = await discoverModels(opencode, catalogSpawn(CATALOG));
    expect(models).toHaveLength(4);
    expect(notes.join(" ")).toContain("3 model(s) hidden");
  });

  // An empty picker is never the right answer to "the shape changed".
  test("if EVERY model looks unusable, nothing is hidden", async () => {
    const allRejected = [
      "a/one",
      JSON.stringify({ id: "one", providerID: "a", capabilities: { toolcall: false } }),
      "a/two",
      JSON.stringify({ id: "two", providerID: "a", capabilities: { toolcall: false } }),
    ].join("\n");
    const { models, notes } = await discoverModels(opencode, catalogSpawn(allRejected));
    expect(models).toEqual(["a/one", "a/two"]);
    expect(notes.join(" ")).toContain("capability shape has probably changed");
  });

  test("an unparseable catalog keeps every id rather than emptying the picker", async () => {
    // ids still line-parse; the JSON records do not
    const { models, notes } = await discoverModels(opencode, catalogSpawn("a/one\na/two\n<not json>\n"));
    expect(models).toEqual(["a/one", "a/two"]);
    expect(notes.join(" ")).not.toContain("hidden");
  });

  test("no output at all is reported honestly, not as an empty catalog", async () => {
    const { models, notes } = await discoverModels(opencode, catalogSpawn(""));
    expect(models).toBeNull();
    expect(notes.join(" ")).toContain("may be unauthenticated");
  });

  test("opencode still names no default model", async () => {
    expect((await discoverModels(opencode, catalogSpawn(CATALOG))).defaultModel).toBeNull();
  });
});
