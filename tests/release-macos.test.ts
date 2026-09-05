import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertMacReleaseSource,
  deterministicTarGz,
  MACOS_CHECKSUMS,
  MACOS_MANIFEST,
  MACOS_SUPPORTED_BASELINE,
  MACOS_TARGET,
  type MacReleaseManifest,
} from "../scripts/release-macos";
import { VERSION } from "../src/version";

describe("Apple Silicon release metadata", () => {
  test("uses one stable native target and distinct metadata filenames", () => {
    expect(MACOS_TARGET).toBe("darwin-arm64");
    expect(MACOS_SUPPORTED_BASELINE).toBe("macOS 26.6.2 (Apple Silicon arm64)");
    expect(MACOS_MANIFEST).toBe("release-manifest-darwin-arm64.json");
    expect(MACOS_CHECKSUMS).toBe("SHA256SUMS-darwin-arm64");
  });

  test("creates byte-identical normalized archives", () => {
    const bytes = new TextEncoder().encode("#!/bin/sh\necho wisp\n");
    const first = deterministicTarGz(bytes);
    const second = deterministicTarGz(bytes);
    expect(first.equals(second)).toBe(true);
    expect([...first.subarray(4, 8)]).toEqual([0, 0, 0, 0]);

    const root = mkdtempSync(join(tmpdir(), "wisp-mac-archive-"));
    const archive = join(root, "wisp.tar.gz");
    const extracted = join(root, "out");
    mkdirSync(extracted);
    writeFileSync(archive, first);
    const result = Bun.spawnSync({
      cmd: ["/usr/bin/tar", "-xzf", archive, "-C", extracted],
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    expect(readFileSync(join(extracted, "wisp"))).toEqual(Buffer.from(bytes));
  });

  test("refuses dirty Mac release sources on every build host", () => {
    expect(() =>
      assertMacReleaseSource(
        mkdtempSync(join(tmpdir(), "wisp-release-mac-")),
        { commit: "a".repeat(40), dirty: true },
        false,
      ),
    ).toThrow("release builds require a clean working tree");
  });

  test("manifest states the ad-hoc and non-notarized security posture", () => {
    const manifest: MacReleaseManifest = {
      schemaVersion: 1,
      product: "wisp",
      version: VERSION,
      commit: "a".repeat(40),
      dirty: false,
      target: { os: "darwin", arch: "arm64" },
      supportedBaseline: MACOS_SUPPORTED_BASELINE,
      signing: {
        kind: "ad-hoc",
        developerId: false,
        notarized: false,
        timestamp: false,
      },
      artifact: {
        file: `wisp-v${VERSION}-darwin-arm64.tar.gz`,
        format: "tar.gz",
        sha256: "b".repeat(64),
        size: 42,
        binary: {
          file: "wisp",
          sha256: "c".repeat(64),
          size: 40,
          mode: "0755",
        },
      },
    };
    expect(manifest.signing).toEqual({
      kind: "ad-hoc",
      developerId: false,
      notarized: false,
      timestamp: false,
    });
  });
});
