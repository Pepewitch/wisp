import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { DesktopReleaseManifest } from "../scripts/release-desktop";
import type { ReleaseManifest } from "../wispd/scripts/release-linux";
import type { MacReleaseManifest } from "../wispd/scripts/release-macos";
import {
  assertDisposableAuditHost,
  changedTapFiles,
  classifyTapState,
  expectedReleaseAssets,
  parsePromotionArgs,
  releaseNotesPath,
  releaseVersion,
  renderTapFiles,
  TAP_FILES,
  validateReleaseMetadata,
} from "../scripts/release-promotion";
import { API_PROTOCOL_VERSION, VERSION } from "../wispd/src/version";

const tag = `v${VERSION}`;
const commit = "a".repeat(40);

function manifests(): {
  linux: ReleaseManifest;
  macos: MacReleaseManifest;
  desktop: DesktopReleaseManifest;
} {
  return {
    linux: {
      schemaVersion: 1,
      product: "wisp",
      version: VERSION,
      apiProtocolVersion: API_PROTOCOL_VERSION,
      commit,
      dirty: false,
      target: { os: "linux", arch: "x86_64", libc: "glibc" },
      supportedBaseline: "Ubuntu 24.04 LTS (x86_64)",
      artifact: {
        file: `wisp-v${VERSION}-linux-x86_64`,
        sha256: "1".repeat(64),
        size: 40,
      },
    },
    macos: {
      schemaVersion: 1,
      product: "wisp",
      version: VERSION,
      apiProtocolVersion: API_PROTOCOL_VERSION,
      commit,
      dirty: false,
      target: { os: "darwin", arch: "arm64" },
      supportedBaseline: "macOS 26.6.2 (Apple Silicon arm64)",
      signing: { kind: "ad-hoc", developerId: false, notarized: false, timestamp: false },
      artifact: {
        file: `wisp-v${VERSION}-darwin-arm64.tar.gz`,
        format: "tar.gz",
        sha256: "2".repeat(64),
        size: 42,
        binary: { file: "wisp", sha256: "3".repeat(64), size: 40, mode: "0755" },
      },
    },
    desktop: {
      schemaVersion: 2,
      product: "wisp-desktop",
      version: VERSION,
      commit,
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
      publishedAt: "2026-09-08T04:14:26.000Z",
      updater: {
        algorithm: "minisign-ed25519",
        signatureFile: `wisp-desktop-v${VERSION}-darwin-arm64.tar.gz.sig`,
        signature: "synthetic-signature",
        publicKeySha256: "4".repeat(64),
      },
      bundle: { directory: "Wisp.app", identifier: "dev.wisp.desktop" },
      artifact: {
        file: `wisp-desktop-v${VERSION}-darwin-arm64.tar.gz`,
        format: "app-tar.gz",
        sha256: "5".repeat(64),
        size: 44,
        binary: {
          file: "Wisp.app/Contents/MacOS/wisp-desktop",
          sha256: "6".repeat(64),
          size: 40,
          mode: "0755",
        },
      },
    },
  };
}

describe("release promotion", () => {
  test("derives the immutable ten-asset contract and release notes", () => {
    expect(releaseVersion(tag)).toBe(VERSION);
    expect(expectedReleaseAssets(VERSION)).toHaveLength(10);
    expect(new Set(expectedReleaseAssets(VERSION)).size).toBe(10);
    const prerelease = VERSION.split("-").at(-1);
    expect(releaseNotesPath("/source", tag)).toBe(`/source/docs/v0.4/RELEASE-NOTES-${prerelease}.md`);
    expect(() => releaseVersion("main")).toThrow("release tag must match");
  });

  test("requires the exact public prerelease inventory", () => {
    const metadata = {
      tagName: tag,
      isDraft: false,
      isPrerelease: true,
      assets: expectedReleaseAssets(VERSION).map((name) => ({ name })),
    };
    expect(() => validateReleaseMetadata(metadata, tag)).not.toThrow();
    expect(() => validateReleaseMetadata({ ...metadata, isDraft: true }, tag)).toThrow("non-draft prerelease");
    expect(() => validateReleaseMetadata({ ...metadata, assets: metadata.assets.slice(1) }, tag)).toThrow(
      "asset inventory mismatch",
    );
  });

  test("renders exactly three tap files from manifests bound to one tag commit", () => {
    const rendered = renderTapFiles(manifests(), "Release notes.", tag, commit);
    expect(Object.keys(rendered).sort()).toEqual([...TAP_FILES].sort());
    expect(rendered["Formula/wisp.rb"]).toContain(`wisp-v${VERSION}-darwin-arm64.tar.gz`);
    expect(rendered["Casks/wisp-desktop.rb"]).toContain(`version "${VERSION}"`);
    expect(JSON.parse(rendered["updates/wisp-desktop-alpha.json"]).version).toBe(VERSION);

    const mismatched = manifests();
    mismatched.desktop.commit = "b".repeat(40);
    expect(() => renderTapFiles(mismatched, "Release notes.", tag, commit)).toThrow("does not match release");
  });

  test("accepts only a clean or exact three-file tap transition", () => {
    expect(classifyTapState([])).toBe("already-promoted");
    const porcelain = [
      " M Formula/wisp.rb",
      " M Casks/wisp-desktop.rb",
      " M updates/wisp-desktop-alpha.json",
    ].join("\n");
    expect(changedTapFiles(porcelain)).toEqual([...TAP_FILES].sort());
    expect(classifyTapState(changedTapFiles(porcelain))).toBe("prepared");
    expect(changedTapFiles(porcelain.trim())).toEqual([...TAP_FILES].sort());
    expect(() => classifyTapState(["README.md"])).toThrow("outside the three-file tap contract");
  });

  test("refuses to create a colliding audit tap on an operator machine", () => {
    expect(() => assertDisposableAuditHost("", "", "homebrew/core\n")).not.toThrow();
    expect(() => assertDisposableAuditHost("wisp 0.4.0-alpha.16", "", "")).toThrow("disposable Homebrew host");
    expect(() => assertDisposableAuditHost("", "wisp-desktop 0.4.0-alpha.16", "")).toThrow(
      "disposable Homebrew host",
    );
    expect(() => assertDisposableAuditHost("", "", "pepewitch/tap\n")).toThrow("unregistered Pepewitch/tap");
  });

  test("parses dry-run and authorized publication separately", () => {
    expect(parsePromotionArgs(["--tag", tag, "--tap-dir", "tap"])).toMatchObject({
      tag,
      publish: false,
    });
    expect(parsePromotionArgs(["--tag", tag, "--tap-dir", "tap", "--publish", "--receipt", "receipt.json"]))
      .toMatchObject({ tag, publish: true });
    expect(() => parsePromotionArgs(["--tag", tag])).toThrow("usage:");
  });

  test("keeps immutable publication separate from resumable promotion", () => {
    const workflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
    const dryRun = readFileSync(new URL("../.github/workflows/release-promotion.yml", import.meta.url), "utf8");
    const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("group: wisp-release");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).toContain("github.event_name == 'workflow_dispatch'");
    expect(workflow).toContain("bun run release:promote --");
    expect(workflow).toContain("--publish");
    expect(workflow).toContain("promotion-receipt.json");
    expect(workflow).toContain("if: always()");
    expect(workflow).toContain('test "$GITHUB_REF" = refs/heads/main');
    expect(workflow.indexOf("publish the GitHub prerelease")).toBeLessThan(workflow.indexOf("promote:"));
    expect(workflow.indexOf("secrets.HOMEBREW_TAP_TOKEN")).toBeGreaterThan(workflow.indexOf("promote:"));
    expect(dryRun).toContain("public-promotion-dry-run:");
    expect(dryRun).toContain("--release-root");
    expect(dryRun).not.toContain("--publish");
    expect(packageJson.scripts["release:promote"]).toBe("bun run scripts/promote-release.ts");
  });
});
