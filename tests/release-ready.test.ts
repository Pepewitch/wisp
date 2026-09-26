import { describe, expect, test } from "bun:test";
import { progressLine, releaseCommit } from "../scripts/release-ready";
import type { CheckVerdict } from "../scripts/release-github";

describe("releaseCommit", () => {
  test("walks back to the commit that set the version, not the newest touch of the file", () => {
    const versions: Record<string, string> = { a: "0.6.3", b: "0.6.3", c: "0.6.2", d: "0.6.2" };
    expect(releaseCommit(["a", "b", "c", "d"], (sha) => versions[sha] ?? null, "0.6.3")).toBe("b");
  });

  test("a later version-file touch that kept the version does not become the release commit", () => {
    const versions: Record<string, string> = { a: "0.6.3", b: "0.6.3", c: "0.6.2" };
    expect(releaseCommit(["a", "b", "c"], (sha) => versions[sha] ?? null, "0.6.3")).toBe("b");
  });

  test("stops at a commit carrying a different version", () => {
    const versions: Record<string, string> = { a: "0.6.4", b: "0.6.3" };
    expect(releaseCommit(["a", "b"], (sha) => versions[sha] ?? null, "0.6.3")).toBeNull();
    expect(releaseCommit([], () => null, "0.6.3")).toBeNull();
  });
});

describe("progressLine", () => {
  const verdict = (name: string, state: CheckVerdict["state"]): CheckVerdict => ({ name, state, detail: "", url: null });

  test("summarizes what is still running", () => {
    expect(progressLine([verdict("test", "passed"), verdict("supply-chain", "pending"), verdict("linux-contract", "missing")])).toBe(
      "  1/3 passed; waiting for supply-chain, linux-contract",
    );
    expect(progressLine([verdict("test", "passed")])).toBe("  1/1 passed");
  });
});
