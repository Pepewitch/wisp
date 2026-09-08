import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { DesktopReleaseManifest } from "../scripts/release-desktop";
import { renderHomebrewCask } from "../scripts/render-homebrew-cask";
import { VERSION } from "../src/version";

function manifest(overrides: Partial<DesktopReleaseManifest> = {}): DesktopReleaseManifest {
  return {
    schemaVersion: 2,
    product: "wisp-desktop",
    version: VERSION,
    commit: "a".repeat(40),
    dirty: false,
    target: { os: "darwin", arch: "arm64", minimumVersion: "12.3" },
    minimumSystemVersion: "macOS 12.3 (Apple Silicon arm64)",
    signing: {
      kind: "developer-id",
      developerId: true,
      notarized: true,
      timestamp: true,
      hardenedRuntime: true,
      identity: "Developer ID Application: Example (ABCDEFGHIJ)",
      teamIdentifier: "ABCDEFGHIJ",
    },
    publishedAt: "2026-09-06T12:00:00.000Z",
    updater: {
      algorithm: "minisign-ed25519",
      signatureFile: `wisp-desktop-v${VERSION}-darwin-arm64.tar.gz.sig`,
      signature: "synthetic-signature",
      publicKeySha256: "d".repeat(64),
    },
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
    expect(cask).toContain('json["version"]');
    expect(cask).toContain("auto_updates true");
    expect(cask).toContain("macOS 12.3 or newer");
    expect(cask).toContain("Developer ID signed and notarized");
    expect(cask).toContain("Reset desktop data before uninstalling");
    expect(cask).toStartWith("# frozen_string_literal: true\n\n");
    expect(cask.indexOf("auto_updates true")).toBeLessThan(cask.indexOf("depends_on arch:"));
    expect(cask).not.toMatch(/API_KEY|PASSWORD|access.token|bearer/i);
  });

  test("rejects manifests outside the approved desktop posture", () => {
    expect(() => renderHomebrewCask(manifest({ version: 'bad"\n  system "bad' }))).toThrow(
      "invalid desktop release version",
    );
    expect(() =>
      renderHomebrewCask(manifest({ artifact: { ...manifest().artifact, sha256: "bad" } })),
    ).toThrow("invalid desktop artifact SHA-256");
    expect(() =>
      renderHomebrewCask(manifest({
        updater: { ...manifest().updater!, signatureFile: "another.sig" },
      })),
    ).toThrow("not the approved signed Apple Silicon desktop release");
    expect(() => renderHomebrewCask(manifest({ target: { ...manifest().target, arch: "x86_64" as "arm64" } }))).toThrow(
      "not the approved signed Apple Silicon desktop release",
    );
  });

  test("authenticates online audits without a signing exception", () => {
    const workflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
    expect(workflow).toContain("HOMEBREW_GITHUB_API_TOKEN: ${{ github.token }}");
    expect(workflow).not.toContain("--except signing,github_prerelease_version");
    const deferredLivecheckAudits =
      "--except github_prerelease_version,livecheck_version,livecheck_https_availability";
    expect(workflow).toContain(deferredLivecheckAudits);
    expect(workflow).toContain("public Desktop update channel did not converge");
    expect(workflow).toContain(
      "--except github_prerelease_version \\\n            Pepewitch/tap/wisp-desktop",
    );
    expect(workflow.indexOf(deferredLivecheckAudits)).toBeLessThan(
      workflow.indexOf('git -C "$tap" push origin HEAD:main'),
    );
    expect(workflow.indexOf("public Desktop update channel did not converge")).toBeGreaterThan(
      workflow.indexOf('git -C "$tap" push origin HEAD:main'),
    );
  });
});
