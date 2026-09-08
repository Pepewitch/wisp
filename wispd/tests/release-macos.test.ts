import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertMacReleaseSource,
  deterministicTarGz,
  isAdHocCodeSignature,
  MACOS_CHECKSUMS,
  MACOS_MANIFEST,
  MACOS_SUPPORTED_BASELINE,
  MACOS_TARGET,
  type MacReleaseManifest,
} from "../scripts/release-macos";
import { API_PROTOCOL_VERSION, VERSION } from "../src/version";

function git(root: string, ...args: string[]): string {
  const result = Bun.spawnSync({ cmd: ["git", "-C", root, ...args], stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(Buffer.from(result.stderr).toString("utf8"));
  return Buffer.from(result.stdout).toString("utf8").trim();
}

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

  test("recognizes both codesign representations of an ad-hoc signature", () => {
    expect(isAdHocCodeSignature("Signature=adhoc\nInfo.plist=not bound")).toBe(true);
    expect(
      isAdHocCodeSignature(
        "CodeDirectory v=20400 size=124070 flags=0x2(adhoc) hashes=3871+2 location=embedded",
      ),
    ).toBe(true);
    expect(
      isAdHocCodeSignature(
        "Authority=Developer ID Application: Example Corp (ABCDE12345)\nCodeDirectory v=20500 flags=0x10000(runtime)",
      ),
    ).toBe(false);
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

  test("requires the exact release tag to be annotated", () => {
    const root = mkdtempSync(join(tmpdir(), "wisp-release-tag-"));
    mkdirSync(join(root, "wispd"));
    writeFileSync(join(root, "wispd/package.json"), `${JSON.stringify({ version: VERSION })}\n`);
    writeFileSync(join(root, "tracked"), "release source\n");
    git(root, "init", "-q");
    git(root, "config", "user.name", "Release Test");
    git(root, "config", "user.email", "release-test@example.invalid");
    git(root, "add", "wispd/package.json", "tracked");
    git(root, "commit", "-qm", "release source");
    const identity = { commit: git(root, "rev-parse", "HEAD"), dirty: false as const };

    git(root, "tag", `v${VERSION}`);
    expect(() => assertMacReleaseSource(root, identity, true)).toThrow("must be annotated");
    git(root, "tag", "-d", `v${VERSION}`);
    git(root, "tag", "-a", `v${VERSION}`, "-m", `Wisp ${VERSION}`);
    expect(() => assertMacReleaseSource(root, identity, true)).not.toThrow();
  });

  test("manifest states the ad-hoc and non-notarized security posture", () => {
    const manifest: MacReleaseManifest = {
      schemaVersion: 1,
      product: "wisp",
      version: VERSION,
      apiProtocolVersion: API_PROTOCOL_VERSION,
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
