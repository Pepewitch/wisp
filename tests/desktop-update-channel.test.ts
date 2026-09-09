import { describe, expect, test } from "bun:test";
import { renderDesktopUpdateChannel } from "../scripts/render-desktop-update-channel";
import type { DesktopReleaseManifest } from "../scripts/release-desktop";

function manifest(version = "0.4.0-alpha.9"): DesktopReleaseManifest {
  return {
    schemaVersion: 2,
    product: "wisp-desktop",
    version,
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
      signatureFile: `wisp-desktop-v${version}-darwin-arm64.tar.gz.sig`,
      signature: "synthetic-signature",
      publicKeySha256: "d".repeat(64),
    },
    bundle: { directory: "Wisp.app", identifier: "dev.wisp.desktop" },
    artifact: {
      file: `wisp-desktop-v${version}-darwin-arm64.tar.gz`,
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
  };
}

describe("Desktop update channel", () => {
  test("renders the exact native alpha contract from verified release metadata", () => {
    const channel = JSON.parse(renderDesktopUpdateChannel(manifest(), "Signed update notes."));
    expect(channel).toEqual({
      schemaVersion: 1,
      channel: "alpha",
      version: "0.4.0-alpha.9",
      publishedAt: "2026-09-06T12:00:00.000Z",
      pub_date: "2026-09-06T12:00:00.000Z",
      notes: "Signed update notes.",
      artifactSize: 42,
      platforms: {
        "darwin-aarch64-app": {
          url: "https://github.com/Pepewitch/wisp/releases/download/v0.4.0-alpha.9/wisp-desktop-v0.4.0-alpha.9-darwin-arm64.tar.gz",
          signature: "synthetic-signature",
        },
      },
    });
  });

  test("carries a regular release through the installed alpha clients' wire contract", () => {
    const channel = JSON.parse(renderDesktopUpdateChannel(manifest("0.5.0"), "0.5 release notes."));
    expect(channel.channel).toBe("alpha");
    expect(channel.version).toBe("0.5.0");
    expect(channel.platforms["darwin-aarch64-app"].url).toBe(
      "https://github.com/Pepewitch/wisp/releases/download/v0.5.0/wisp-desktop-v0.5.0-darwin-arm64.tar.gz",
    );
  });

  test("refuses an unnotarized release or oversized notes", () => {
    const unsigned = manifest();
    unsigned.signing.notarized = false;
    expect(() => renderDesktopUpdateChannel(unsigned, "notes")).toThrow("not a signed, notarized");
    const wrongSignature = manifest();
    wrongSignature.updater!.signatureFile = "another.sig";
    expect(() => renderDesktopUpdateChannel(wrongSignature, "notes")).toThrow("invalid updater signature");
    expect(() => renderDesktopUpdateChannel(manifest(), "x".repeat(17 * 1024))).toThrow("too large");
  });
});
