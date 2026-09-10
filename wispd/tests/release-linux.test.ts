import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  LINUX_TARGET,
  MINIMUM_GLIBC,
  releaseLinux,
  sha256File,
  SUPPORTED_BASELINE,
  type ReleaseManifest,
} from "../scripts/release-linux";
import { API_PROTOCOL_VERSION, VERSION } from "../src/version";

describe("Linux release metadata", () => {
  test("uses one stable, explicit supported target", () => {
    expect(LINUX_TARGET).toBe("linux-x86_64");
    expect(SUPPORTED_BASELINE).toBe("Ubuntu 24.04 LTS (x86_64)");
  });

  // The floor separates "qualified on Ubuntu 24.04" from "runs at all", so a
  // doc that states a different number is a support promise nothing enforces.
  test("states the derived glibc floor identically wherever a doc promises one", () => {
    const root = resolve(import.meta.dir, "../..");
    for (const file of ["README.md", "docs/INSTALL.md"]) {
      const stated = [...readFileSync(join(root, file), "utf8").matchAll(/glibc (\d+\.\d+(?:\.\d+)?)/g)];
      expect(stated.length).toBeGreaterThan(0);
      expect([...new Set(stated.map((match) => match[1]))]).toEqual([MINIMUM_GLIBC]);
    }
  });

  test("hashes artifact bytes with SHA-256", () => {
    const path = join(mkdtempSync(join(tmpdir(), "wisp-release-")), "artifact");
    writeFileSync(path, "wisp\n");
    expect(sha256File(path)).toBe("b2fd0b0c0bbc70751cdff553b0229f5d4fba07d1dd578756db6b9b796f0a3d5b");
  });

  test("refuses to label a dirty tree as a release", () => {
    expect(() =>
      releaseLinux({
        root: mkdtempSync(join(tmpdir(), "wisp-release-")),
        identity: { commit: "a".repeat(40), dirty: true },
      }),
    ).toThrow("release builds require a clean working tree");
  });

  test("refuses inconsistent source and package versions before building", () => {
    const root = mkdtempSync(join(tmpdir(), "wisp-release-"));
    mkdirSync(join(root, "wispd"));
    writeFileSync(join(root, "wispd/package.json"), JSON.stringify({ version: "9.9.9" }));
    expect(() =>
      releaseLinux({
        root,
        identity: { commit: "a".repeat(40), dirty: false },
      }),
    ).toThrow(`version mismatch: wispd/package.json="9.9.9", source="${VERSION}"`);
  });

  test("manifest shape cannot claim a dirty release", () => {
    const manifest: ReleaseManifest = {
      schemaVersion: 1,
      product: "wisp",
      version: VERSION,
      apiProtocolVersion: API_PROTOCOL_VERSION,
      commit: "a".repeat(40),
      dirty: false,
      target: { os: "linux", arch: "x86_64", libc: "glibc" },
      supportedBaseline: SUPPORTED_BASELINE,
      artifact: {
        file: `wisp-v${VERSION}-linux-x86_64`,
        sha256: "b".repeat(64),
        size: 42,
      },
    };
    const path = join(mkdtempSync(join(tmpdir(), "wisp-release-")), "release-manifest.json");
    writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(manifest);
  });
});
