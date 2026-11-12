import { describe, expect, test } from "bun:test";
import { ciCoveredGates, linesNaming, localOnlyGates, pngInputChanges, sourceGates } from "../scripts/release-check";

describe("linesNaming", () => {
  test("finds exact version mentions with 1-based line numbers", () => {
    const text = [
      "install from v0.6.1 today",
      "0.6.10 is a different release",
      "the 10.6.1 subnet is unrelated",
      "plain 0.6.1 again",
    ].join("\n");
    expect(linesNaming(text, "0.6.1")).toEqual([1, 4]);
  });
});

describe("pngInputChanges", () => {
  test("flags the brand generator, brand assets, and desktop icons", () => {
    expect(pngInputChanges(["scripts/brand/mark.ts", "web/src/App.tsx"], "")).toEqual(["scripts/brand/mark.ts"]);
    expect(pngInputChanges(["brand/social-preview.png"], "")).toEqual(["brand/social-preview.png"]);
    expect(pngInputChanges(["desktop/src-tauri/icons/icon.png"], "")).toEqual(["desktop/src-tauri/icons/icon.png"]);
  });

  test("flags a change to the font package the PNGs are rendered with", () => {
    const diff = '@@\n-    "@fontsource-variable/geist": "1.0.0"\n+    "@fontsource-variable/geist": "1.1.0"\n';
    expect(pngInputChanges(["bun.lock"], diff)).toEqual(["@fontsource-variable/geist"]);
    expect(pngInputChanges(["bun.lock"], "+\t\"hono\": \"4.13.5\"\n")).toEqual([]);
  });
});

describe("sourceGates", () => {
  test("skips the PNG render only when no PNG input changed", () => {
    const skipped = sourceGates("v0.6.2", [], false).find((gate) => gate.id === "brand")!;
    expect(skipped.env).toEqual({ CHROME_PATH: "/nonexistent" });
    expect(skipped.note).toContain("v0.6.2");

    const rendered = sourceGates("v0.6.2", ["scripts/brand/mark.ts"], false).find((gate) => gate.id === "brand")!;
    expect(rendered.env).toBeUndefined();
    expect(rendered.note).toContain("scripts/brand/mark.ts");
  });

  // The default mode's whole point: these three are what no CI job runs, so
  // a gate that grows a fourth has either found real local-only coverage or
  // started duplicating CI again. Either way it should be a deliberate edit.
  test("by default runs only the gates CI does not", () => {
    expect(sourceGates("v0.6.2", [], false).map((gate) => gate.id)).toEqual(["whitespace", "brand", "evaluator"]);
  });

  test("--full adds what CI covers, cheapest first, ending with the build", () => {
    expect(sourceGates("v0.6.2", [], true).map((gate) => gate.id)).toEqual([
      "whitespace",
      "brand",
      "evaluator",
      "check",
      "tests",
      "smoke",
      "build",
    ]);
  });

  test("the local-only gates are a prefix of --full, so one mode cannot drift from the other", () => {
    const local = localOnlyGates("v0.6.2", []).map((gate) => gate.id);
    expect(sourceGates("v0.6.2", [], true).map((gate) => gate.id).slice(0, local.length)).toEqual(local);
  });

  test("the duplicated gates run the sharded suite, never the serial one", () => {
    const tests = ciCoveredGates().find((gate) => gate.id === "tests")!;
    expect(tests.cmd).toEqual(["bun", "run", "test:all:sharded"]);
    // `check:fast`, not `check`: the full `check` ends in test:all, which
    // would run the daemon suite serially a second time.
    expect(ciCoveredGates().find((gate) => gate.id === "check")!.cmd).toEqual(["bun", "run", "check:fast"]);
  });
});
