import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { DesktopReleaseManifest } from "../scripts/release-desktop";
import type { ReleaseManifest } from "../wispd/scripts/release-linux";
import type { MacReleaseManifest } from "../wispd/scripts/release-macos";
import {
  assertDisposableAuditHost,
  assertPromotableFixture,
  changedTapFiles,
  classifyTapState,
  expectedReleaseAssets,
  parsePromotionArgs,
  promotionFixtureTag,
  releaseNotesPath,
  releaseVersion,
  renderTapFiles,
  TAP_FILES,
  unpublishedTapFiles,
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
    expect(releaseNotesPath("/source", "v0.5.0")).toBe("/source/docs/v0.5/RELEASE-NOTES-0.5.0.md");
    expect(releaseNotesPath("/source", "v0.5.1")).toBe("/source/docs/v0.5/RELEASE-NOTES-0.5.1.md");
    expect(releaseNotesPath("/source", "v0.4.0-alpha.17")).toBe("/source/docs/v0.4/RELEASE-NOTES-alpha.17.md");
    for (const invalid of ["v00.5.0", "v0.5.0-alpha.01", "v0.5.0/../main", "v0.5.0-beta.1"]) {
      expect(() => releaseVersion(invalid)).toThrow("release tag must match");
    }
    expect(() => releaseVersion("main")).toThrow("release tag must match");
  });

  test("requires the exact public release inventory", () => {
    const metadata = {
      tagName: tag,
      isDraft: false,
      isPrerelease: VERSION.includes("-"),
      assets: expectedReleaseAssets(VERSION).map((name) => ({ name })),
    };
    expect(() => validateReleaseMetadata(metadata, tag)).not.toThrow();
    expect(() => validateReleaseMetadata({ ...metadata, isDraft: true }, tag)).toThrow("non-draft release");
    expect(() => validateReleaseMetadata({ ...metadata, assets: metadata.assets.slice(1) }, tag)).toThrow(
      "asset inventory mismatch",
    );
  });

  test("promotes stable and historical alpha releases only with matching GitHub status", () => {
    for (const version of ["0.5.0", "0.4.0-alpha.17"]) {
      const metadata = {
        tagName: `v${version}`, isDraft: false, isPrerelease: version.includes("-"),
        assets: expectedReleaseAssets(version).map((name) => ({ name })),
      };
      expect(() => validateReleaseMetadata(metadata, metadata.tagName)).not.toThrow();
      expect(() => validateReleaseMetadata({ ...metadata, isPrerelease: !metadata.isPrerelease }, metadata.tagName))
        .toThrow("tag-matching prerelease status");
    }
  });

  test("renders every tap file from manifests bound to one tag commit", () => {
    const rendered = renderTapFiles(manifests(), "Release notes.", tag, commit);
    expect(Object.keys(rendered).sort()).toEqual([...TAP_FILES].sort());
    expect(rendered["Formula/wisp.rb"]).toContain(`wisp-v${VERSION}-darwin-arm64.tar.gz`);
    expect(rendered["Casks/wisp-desktop.rb"]).toContain(`version "${VERSION}"`);
    expect(JSON.parse(rendered["updates/wisp-daemon.json"])).toEqual({
      schemaVersion: 1,
      product: "wisp",
      version: VERSION,
      apiProtocolVersion: API_PROTOCOL_VERSION,
      publishedAt: "2026-09-08T04:14:26.000Z",
    });
    expect(JSON.parse(rendered["updates/wisp-desktop-alpha.json"]).version).toBe(VERSION);

    const mismatched = manifests();
    mismatched.desktop.commit = "b".repeat(40);
    expect(() => renderTapFiles(mismatched, "Release notes.", tag, commit)).toThrow("does not match release");
  });

  test("accepts only a clean or exact release-file tap transition", () => {
    expect(classifyTapState([])).toBe("already-promoted");
    const porcelain = [
      " M Formula/wisp.rb",
      " M Casks/wisp-desktop.rb",
      " M updates/wisp-daemon.json",
      " M updates/wisp-desktop-alpha.json",
    ].join("\n");
    expect(changedTapFiles(porcelain)).toEqual([...TAP_FILES].sort());
    expect(classifyTapState(changedTapFiles(porcelain))).toBe("prepared");
    expect(changedTapFiles(porcelain.trim())).toEqual([...TAP_FILES].sort());
    expect(() => classifyTapState(["README.md"])).toThrow("outside the tap contract");
  });

  test("derives the dry-run fixture from the release the tap serves", () => {
    expect(promotionFixtureTag(JSON.stringify({ version: VERSION }))).toBe(tag);
    expect(promotionFixtureTag(JSON.stringify({ version: "0.4.0-alpha.17" }))).toBe("v0.4.0-alpha.17");
    expect(() => promotionFixtureTag("{")).toThrow("not readable JSON");
    expect(() => promotionFixtureTag(JSON.stringify({}))).toThrow("does not record the promoted version");
    expect(() => promotionFixtureTag(JSON.stringify({ version: 5 }))).toThrow("does not record the promoted version");
    expect(() => promotionFixtureTag(JSON.stringify({ version: "0.5" }))).toThrow("release tag must match");
  });

  test("refuses a fixture whose tap does not publish the whole contract yet", () => {
    expect(unpublishedTapFiles([...TAP_FILES])).toEqual([]);
    expect(() => assertPromotableFixture(tag, [...TAP_FILES])).not.toThrow();
    const withoutDaemonChannel = TAP_FILES.filter((file) => file !== "updates/wisp-daemon.json");
    expect(unpublishedTapFiles(withoutDaemonChannel)).toEqual(["updates/wisp-daemon.json"]);
    expect(() => assertPromotableFixture(tag, withoutDaemonChannel)).toThrow("updates/wisp-daemon.json");
    expect(() => assertPromotableFixture(tag, withoutDaemonChannel)).toThrow("current tap contract");
    expect(() => assertPromotableFixture(tag, [])).toThrow("does not publish");
  });

  test("names no release version in the promotion dry run, so it cannot go stale", () => {
    const dryRun = readFileSync(new URL("../.github/workflows/release-promotion.yml", import.meta.url), "utf8");
    // A pinned tag stops agreeing with the tap as soon as a later release is
    // promoted, which is why the fixture is read out of the tap instead. Only
    // the promotion script itself is checked, so pinned action versions and
    // toolchain versions stay outside this rule.
    const script = dryRun.split("run: |").at(-1)?.split("\n      - name:")[0] ?? "";
    expect(script).toContain("release:promote");
    expect(script).not.toMatch(/v\d+\.\d+\.\d+/);
    expect(dryRun).toContain("scripts/promotion-fixture.ts");
    expect(dryRun).toContain('--tag "$tag"');
    for (const path of [
      "scripts/promotion-fixture.ts",
      "scripts/render-daemon-update-channel.ts",
      "tests/daemon-update-channel.test.ts",
    ]) {
      // Both the push and the pull_request filter must list every input, or a
      // change to one of them never reaches this job.
      expect(dryRun.split(`- "${path}"`).length - 1).toBe(2);
    }
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
    expect(workflow).toContain("render-daemon-update-channel.ts");
    expect(workflow).toContain("if: always()");
    expect(workflow).toContain('test "$GITHUB_REF" = refs/heads/main');
    expect(workflow.indexOf("publish the GitHub release")).toBeLessThan(workflow.indexOf("promote:"));
    expect(workflow.indexOf("secrets.HOMEBREW_TAP_TOKEN")).toBeGreaterThan(workflow.indexOf("promote:"));
    expect(dryRun).toContain("public-promotion-dry-run:");
    expect(dryRun).toContain("--release-root");
    expect(dryRun).not.toContain("--publish");
    expect(packageJson.scripts["release:promote"]).toBe("bun run scripts/promote-release.ts");
  });
});
