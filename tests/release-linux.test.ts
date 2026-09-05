import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LINUX_TARGET,
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
    writeFileSync(join(root, "package.json"), JSON.stringify({ version: "9.9.9" }));
    expect(() =>
      releaseLinux({
        root,
        identity: { commit: "a".repeat(40), dirty: false },
      }),
    ).toThrow(`version mismatch: package.json="9.9.9", source="${VERSION}"`);
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
