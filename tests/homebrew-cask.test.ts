import { describe, expect, test } from "bun:test";
import type { DesktopReleaseManifest } from "../scripts/release-desktop";
import { renderHomebrewCask } from "../scripts/render-homebrew-cask";
import { VERSION } from "../src/version";

function manifest(overrides: Partial<DesktopReleaseManifest> = {}): DesktopReleaseManifest {
  return {
    schemaVersion: 1,
    product: "wisp-desktop",
    version: VERSION,
    commit: "a".repeat(40),
    dirty: false,
    target: { os: "darwin", arch: "arm64", minimumVersion: "12.3" },
    minimumSystemVersion: "macOS 12.3 (Apple Silicon arm64)",
    signing: { kind: "ad-hoc", developerId: false, notarized: false, timestamp: false },
    bundle: { directory: "Wisp.app", identifier: "dev.wisp.desktop" },
    artifact: {
      file: `wisp-desktop-v${VERSION}-darwin-arm64.tar.gz`,
      format: "app-tar.gz",
      sha256: "b".repeat(64),
      size: 42,
      binary: {
        file: "Wisp.app/Contents/MacOS/wisp-desktop",
        sha256: "c".repeat(64),
        size: 40,
        mode: "0755",
      },
    },
    ...overrides,
  };
}

describe("Homebrew Cask rendering", () => {
  test("installs the application and requires the daemon Formula", () => {
    const cask = renderHomebrewCask(manifest());
    expect(cask).toContain(`version "${VERSION}"`);
    expect(cask).toContain(`sha256 "${"b".repeat(64)}"`);
    expect(cask).toContain("wisp-desktop-v#{version}-darwin-arm64.tar.gz");
    expect(cask).toContain('depends_on formula: "pepewitch/tap/wisp"');
    expect(cask).toContain("depends_on arch: :arm64");
    expect(cask).toContain("depends_on macos: :monterey");
    expect(cask).toContain('app "Wisp.app"');
    expect(cask).toContain('uninstall quit: "dev.wisp.desktop"');
    expect(cask).toContain("macOS 12.3 or newer");
    expect(cask).toContain("not Developer ID signed or notarized");
    expect(cask).toContain("Reset Desktop Data before uninstalling");
    expect(cask).not.toMatch(/API_KEY|PASSWORD|access.token|bearer/i);
  });

  test("rejects manifests outside the approved desktop posture", () => {
    expect(() => renderHomebrewCask(manifest({ version: 'bad"\n  system "bad' }))).toThrow(
      "invalid desktop release version",
    );
    expect(() =>
      renderHomebrewCask(manifest({ artifact: { ...manifest().artifact, sha256: "bad" } })),
    ).toThrow("invalid desktop artifact SHA-256");
    expect(() => renderHomebrewCask(manifest({ target: { ...manifest().target, arch: "x86_64" as "arm64" } }))).toThrow(
      "not the approved ad-hoc Apple Silicon desktop alpha",
    );
  });
});
