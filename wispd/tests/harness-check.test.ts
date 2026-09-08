/**
 * `harness:check` — version reading, pin comparison and the verdict line.
 *
 * Every spawn and fetch is injected: a test that shells out to a real harness
 * is a flake and a quota leak, and this suite must pass on a machine with no
 * harness CLI installed at all.
 */
import { describe, expect, test } from "bun:test";
import type { ModelProbeSpawnFn } from "../src/adapters";
import {
  compareHarnessVersions,
  hasDrift,
  pinState,
  renderRow,
  surfaceStates,
  type CheckRow,
} from "../scripts/harness/check";
import type { HarnessFacts } from "../scripts/harness/facts";
import { installedVersion, latestVersion, parseVersionOutput, UPSTREAM_SOURCES } from "../scripts/harness/upstream";

const spawnOf =
  (result: { exitCode?: number; stdout?: string; stderr?: string } | Error): ModelProbeSpawnFn =>
  async () => {
    if (result instanceof Error) throw result;
    return { exitCode: result.exitCode ?? 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  };

const facts = (surfaces: HarnessFacts["surfaces"]): HarnessFacts => ({ harness: "x", bin: "x", surfaces });

describe("parseVersionOutput", () => {
  // the four shapes the installed CLIs actually print
  test.each([
    ["0.213.0", "0.213.0"],
    ["codex-cli 0.153.4", "0.153.4"],
    ["2.1.261 (Claude Code)", "2.1.261"],
    ["2026.09.02-c22c1a3", "2026.09.02-c22c1a3"],
  ])("reads %p", (raw, expected) => {
    expect(parseVersionOutput(raw)).toBe(expected);
  });

  test("returns null rather than guessing when nothing looks like a version", () => {
    expect(parseVersionOutput("command not found")).toBeNull();
  });
});

describe("compareHarnessVersions", () => {
  test("orders semver", () => {
    expect(compareHarnessVersions("0.149.0", "0.153.4")).toBeLessThan(0);
    expect(compareHarnessVersions("0.153.4", "0.153.4")).toBe(0);
  });

  test("returns null for cursor's date builds rather than inventing an order", () => {
    // semver rejects the leading zero in 2026.09.02; an invented ordering here
    // would report drift that does not exist
    expect(compareHarnessVersions("2026.08.31-4057e58", "2026.09.02-c22c1a3")).toBeNull();
  });

  test("still recognises equality when ordering is impossible", () => {
    expect(compareHarnessVersions("2026.09.02-c22c1a3", "2026.09.02-c22c1a3")).toBe(0);
  });
});

describe("pinState", () => {
  test("a pin older than the installed CLI is behind", () => {
    expect(pinState("0.149.0", "0.153.4")).toBe("behind");
  });

  test("a matching pin is current", () => {
    expect(pinState("0.153.4", "0.153.4")).toBe("current");
  });

  test("a pin ahead of the installed CLI is current, not behind", () => {
    // the facts were verified on a newer build than this machine has; nothing
    // to re-verify here
    expect(pinState("0.153.4", "0.149.0")).toBe("current");
  });

  test("unorderable but different means behind — it was verified on another build", () => {
    expect(pinState("2026.08.31-4057e58", "2026.09.02-c22c1a3")).toBe("behind");
  });

  test("a missing pin is unpinned, never silently current", () => {
    expect(pinState(null, "1.0.0")).toBe("unpinned");
  });
});

describe("installedVersion", () => {
  test("reads the version", async () => {
    expect(await installedVersion("droid", spawnOf({ stdout: "0.213.0" }))).toEqual({ version: "0.213.0", error: null });
  });

  test("a non-zero exit is an error, not a version", async () => {
    const result = await installedVersion("droid", spawnOf({ exitCode: 1 }));
    expect(result.version).toBeNull();
    expect(result.error).toContain("exited 1");
  });

  test("a missing binary is reported, never thrown", async () => {
    const result = await installedVersion("nope", spawnOf(new Error("ENOENT: no such file")));
    expect(result.error).toBe("'nope' not found on PATH");
  });
});

describe("latestVersion", () => {
  const okFetch = (body: string) => async () => ({ ok: true, status: 200, text: async () => body });

  test("reads an npm dist-tag", async () => {
    const source = UPSTREAM_SOURCES.claude!;
    expect(await latestVersion(source, okFetch('{"version":"2.1.261"}'))).toEqual({ version: "2.1.261", error: null });
  });

  test("reads a homebrew cask", async () => {
    expect(await latestVersion(UPSTREAM_SOURCES.droid!, okFetch('{"version":"0.213.0"}'))).toEqual({
      version: "0.213.0",
      error: null,
    });
  });

  test("a harness with no published source says so instead of guessing", async () => {
    const result = await latestVersion(UPSTREAM_SOURCES.cursor!, okFetch("{}"));
    expect(result.version).toBeNull();
    expect(result.error).toContain("no machine-readable version endpoint");
  });

  test("network failure degrades to unknown rather than crashing the report", async () => {
    const result = await latestVersion(UPSTREAM_SOURCES.codex!, async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    });
    expect(result.version).toBeNull();
    expect(result.error).toContain("ENOTFOUND");
  });

  test("a non-200 is reported with its status", async () => {
    const result = await latestVersion(UPSTREAM_SOURCES.codex!, async () => ({
      ok: false,
      status: 503,
      text: async () => "",
    }));
    expect(result.error).toContain("503");
  });
});

describe("the report", () => {
  const row = (over: Partial<CheckRow> = {}): CheckRow => ({
    harness: "codex",
    bin: "codex",
    installed: { version: "0.153.4", error: null },
    latest: null,
    surfaces: surfaceStates(
      facts({
        models: { cost: "free", verifiedAgainst: "0.153.4", source: "s" },
        fixtures: { cost: "live", verifiedAgainst: "0.149.0", source: "s" },
      }),
      "0.153.4",
    ),
    ...over,
  });

  test("names the snapshot command when a free surface is behind", () => {
    const behind = row({
      surfaces: surfaceStates(facts({ models: { cost: "free", verifiedAgainst: "0.149.0", source: "s" } }), "0.153.4"),
    });
    expect(renderRow(behind).join("\n")).toContain("harness:snapshot --harness codex");
  });

  test("tells the reader a live surface costs a turn instead of running one", () => {
    const text = renderRow(row()).join("\n");
    expect(text).toContain("live surfaces need a turn each: fixtures");
    expect(text).toContain("harness-sync.md");
  });

  test("says to upgrade the CLI first when upstream is ahead", () => {
    const text = renderRow(row({ latest: { version: "0.160.0", error: null } })).join("\n");
    expect(text).toContain("upgrade the CLI first (0.153.4 → 0.160.0)");
  });

  test("an uninstalled harness is skipped, never a failure", () => {
    const text = renderRow(row({ installed: { version: null, error: "'codex' not found on PATH" } })).join("\n");
    expect(text).toContain("skipped");
    expect(hasDrift([row({ installed: { version: null, error: "gone" } })])).toBe(false);
  });

  test("everything matching reads as up to date", () => {
    const clean = row({
      surfaces: surfaceStates(facts({ models: { cost: "free", verifiedAgainst: "0.153.4", source: "s" } }), "0.153.4"),
    });
    expect(renderRow(clean).join("\n")).toContain("up to date");
    expect(hasDrift([clean])).toBe(false);
  });
});
