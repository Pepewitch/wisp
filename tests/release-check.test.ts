import { describe, expect, test } from "bun:test";
import { linesNaming, pngInputChanges, sourceGates } from "../scripts/release-check";

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
    const skipped = sourceGates("v0.6.2", []).find((gate) => gate.id === "brand")!;
    expect(skipped.env).toEqual({ CHROME_PATH: "/nonexistent" });
    expect(skipped.note).toContain("v0.6.2");

    const rendered = sourceGates("v0.6.2", ["scripts/brand/mark.ts"]).find((gate) => gate.id === "brand")!;
    expect(rendered.env).toBeUndefined();
    expect(rendered.note).toContain("scripts/brand/mark.ts");
  });

  test("runs the cheapest gates first and ends with the build", () => {
    expect(sourceGates("v0.6.2", []).map((gate) => gate.id)).toEqual([
      "whitespace",
      "brand",
      "evaluator",
      "check",
      "smoke",
      "build",
    ]);
  });
});
