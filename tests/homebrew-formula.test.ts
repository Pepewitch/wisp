import { describe, expect, test } from "bun:test";
import {
  MACOS_APP_DIRECTORY,
  MACOS_APP_EXECUTABLE,
  MACOS_CODE_SIGNING_IDENTIFIER,
  type MacReleaseManifest,
} from "../wispd/scripts/release-macos";
import {
  renderHomebrewFormula,
  type LegacyMacReleaseManifest,
} from "../scripts/render-homebrew-formula";
import { API_PROTOCOL_VERSION, VERSION } from "../wispd/src/version";

function manifest(overrides: Partial<MacReleaseManifest> = {}): MacReleaseManifest {
  return {
    schemaVersion: 3,
    product: "wisp",
    version: VERSION,
    apiProtocolVersion: API_PROTOCOL_VERSION,
    commit: "a".repeat(40),
    dirty: false,
    target: { os: "darwin", arch: "arm64" },
    supportedBaseline: "macOS 26.6.2 (Apple Silicon arm64)",
    signing: {
      kind: "developer-id",
      developerId: true,
      notarized: true,
      timestamp: true,
      hardenedRuntime: true,
      identifier: MACOS_CODE_SIGNING_IDENTIFIER,
      identity: "Developer ID Application: Example Corp (ABCDEFGHIJ)",
      teamIdentifier: "ABCDEFGHIJ",
    },
    bundle: {
      directory: MACOS_APP_DIRECTORY,
      identifier: MACOS_CODE_SIGNING_IDENTIFIER,
      executable: "Contents/MacOS/wisp",
      icon: "Contents/Resources/icon.icns",
      backgroundOnly: true,
    },
    artifact: {
      file: `wisp-v${VERSION}-darwin-arm64.tar.gz`,
      format: "app-tar.gz",
      sha256: "b".repeat(64),
      size: 42,
      binary: {
        file: MACOS_APP_EXECUTABLE,
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
    expect(formula).toContain(`libexec.install "${MACOS_APP_DIRECTORY}"`);
    expect(formula).toContain(`bin.install_symlink libexec/"${MACOS_APP_DIRECTORY}/Contents/MacOS/wisp"`);
    expect(formula).toContain(`run [opt_libexec/"${MACOS_APP_DIRECTORY}/Contents/MacOS/wisp", "serve"]`);
    expect(formula).toContain("brew services start wisp");
    expect(formula).toContain("Developer ID signed");
    expect(formula).toContain("branded background app");
    expect(formula).toContain("privacy permission across upgrades");
    expect(formula).toContain("#{Dir.home}/.local/bin");
    expect(formula).not.toMatch(/API_KEY|TOKEN|PASSWORD|credential/i);
  });

  test("rejects a manifest outside the approved signing posture", () => {
    expect(() => renderHomebrewFormula(manifest({ apiProtocolVersion: 0 }))).toThrow(
      "invalid API protocol version",
    );
    expect(() =>
      renderHomebrewFormula(
        manifest({
          target: { os: "darwin", arch: "x86_64" as "arm64" },
        }),
      ),
    ).toThrow("not an approved Apple Silicon daemon release");
    expect(() => renderHomebrewFormula(manifest({ artifact: { ...manifest().artifact, sha256: "bad" } }))).toThrow(
      "invalid artifact SHA-256",
    );
    expect(() =>
      renderHomebrewFormula(
        manifest({ artifact: { ...manifest().artifact, file: 'wisp.tar.gz"\\n  system "bad"' } }),
      ),
    ).toThrow("unexpected Apple Silicon artifact filename");
    expect(() =>
      renderHomebrewFormula(
        manifest({
          bundle: {
            ...manifest().bundle,
            icon: "Contents/Resources/missing.icns" as "Contents/Resources/icon.icns",
          },
        }),
      ),
    ).toThrow("not an approved Apple Silicon daemon release");
  });

  test("replays historical ad-hoc manifests but rejects new unsigned output", () => {
    const current = manifest();
    const legacy: LegacyMacReleaseManifest = {
      schemaVersion: 1,
      product: current.product,
      version: current.version,
      apiProtocolVersion: current.apiProtocolVersion,
      commit: current.commit,
      dirty: false,
      target: current.target,
      supportedBaseline: current.supportedBaseline,
      signing: { kind: "ad-hoc", developerId: false, notarized: false, timestamp: false },
      artifact: {
        ...current.artifact,
        format: "tar.gz",
        binary: { ...current.artifact.binary, file: "wisp" },
      },
    };
    const historical = renderHomebrewFormula(legacy);
    expect(historical).toContain("ad-hoc signed, not Developer ID");
    expect(historical).toContain('bin.install "wisp"');
    expect(historical).toContain('run [opt_bin/"wisp", "serve"]');

    expect(() =>
      renderHomebrewFormula({
        ...current,
        signing: {
          kind: "ad-hoc",
          developerId: false,
          notarized: false,
          timestamp: false,
          hardenedRuntime: false,
          identifier: null,
          identity: null,
          teamIdentifier: null,
        },
      }),
    ).toThrow("not an approved Apple Silicon daemon release");
  });
});
