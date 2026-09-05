import { describe, expect, test } from "bun:test";
import type { MacReleaseManifest } from "../scripts/release-macos";
import { renderHomebrewFormula } from "../scripts/render-homebrew-formula";
import { VERSION } from "../src/version";

function manifest(overrides: Partial<MacReleaseManifest> = {}): MacReleaseManifest {
  return {
    schemaVersion: 1,
    product: "wisp",
    version: VERSION,
    commit: "a".repeat(40),
    dirty: false,
    target: { os: "darwin", arch: "arm64" },
    supportedBaseline: "macOS 26.6.2 (Apple Silicon arm64)",
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
    ...overrides,
  };
}

describe("Homebrew Formula rendering", () => {
  test("pins the immutable asset and exposes the launchd service without secrets", () => {
    const formula = renderHomebrewFormula(manifest());
    expect(formula).toContain(
      `url "https://github.com/Pepewitch/wisp/releases/download/v${VERSION}/wisp-v${VERSION}-darwin-arm64.tar.gz"`,
    );
    expect(formula).not.toContain(`version "${VERSION}"`);
    expect(formula).toContain(`sha256 "${"b".repeat(64)}"`);
    expect(formula).toContain("depends_on arch: :arm64");
    expect(formula).toContain('run [opt_bin/"wisp", "serve"]');
    expect(formula).toContain("brew services start wisp");
    expect(formula).toContain("not Developer ID");
    expect(formula).toContain("#{Dir.home}/.local/bin");
    expect(formula).not.toMatch(/API_KEY|TOKEN|PASSWORD|credential/i);
  });

  test("rejects a manifest outside the approved alpha posture", () => {
    expect(() =>
      renderHomebrewFormula(
        manifest({
          target: { os: "darwin", arch: "x86_64" as "arm64" },
        }),
      ),
    ).toThrow("not the approved ad-hoc Apple Silicon alpha");
    expect(() => renderHomebrewFormula(manifest({ artifact: { ...manifest().artifact, sha256: "bad" } }))).toThrow(
      "invalid artifact SHA-256",
    );
    expect(() =>
      renderHomebrewFormula(
        manifest({ artifact: { ...manifest().artifact, file: 'wisp.tar.gz"\\n  system "bad"' } }),
      ),
    ).toThrow("unexpected Apple Silicon artifact filename");
  });
});
