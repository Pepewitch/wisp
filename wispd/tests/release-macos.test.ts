import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertMacReleaseSource,
  daemonInfoPlist,
  developerIdSigningMetadata,
  deterministicDaemonAppTarGz,
  isAdHocCodeSignature,
  MACOS_APP_DIRECTORY,
  MACOS_APP_EXECUTABLE,
  MACOS_APP_ICON,
  MACOS_CODE_SIGNING_IDENTIFIER,
  MACOS_CHECKSUMS,
  MACOS_MANIFEST,
  MACOS_SUPPORTED_BASELINE,
  MACOS_TARGET,
  notarizationAccepted,
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
    expect(MACOS_APP_DIRECTORY).toBe("Wisp Daemon.app");
    expect(MACOS_APP_EXECUTABLE).toBe("Wisp Daemon.app/Contents/MacOS/wisp");
    expect(MACOS_APP_ICON).toBe("Wisp Daemon.app/Contents/Resources/icon.icns");
  });

  test("creates byte-identical normalized branded application archives", () => {
    const makeApp = (order: "forward" | "reverse"): string => {
      const root = mkdtempSync(join(tmpdir(), "wisp-mac-app-"));
      const app = join(root, MACOS_APP_DIRECTORY);
      const files = [
        ["Contents/MacOS/wisp", "#!/bin/sh\necho wisp\n"],
        ["Contents/Info.plist", daemonInfoPlist(VERSION)],
        ["Contents/Resources/icon.icns", "synthetic icon"],
        ["Contents/_CodeSignature/CodeResources", "synthetic signature"],
      ] as const;
      for (const [name, body] of order === "forward" ? files : [...files].reverse()) {
        const path = join(app, name);
        mkdirSync(join(path, ".."), { recursive: true });
        writeFileSync(path, body);
      }
      chmodSync(join(app, "Contents/MacOS/wisp"), 0o755);
      return app;
    };
    const first = deterministicDaemonAppTarGz(makeApp("forward"));
    const second = deterministicDaemonAppTarGz(makeApp("reverse"));
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
    expect(readFileSync(join(extracted, MACOS_APP_EXECUTABLE), "utf8")).toBe("#!/bin/sh\necho wisp\n");
    expect(readFileSync(join(extracted, MACOS_APP_ICON), "utf8")).toBe("synthetic icon");
  });

  test("marks the daemon bundle as a branded background application", () => {
    const plist = daemonInfoPlist("1.2.3-alpha.4");
    expect(plist).toContain("<string>dev.wisp.daemon</string>");
    expect(plist).toContain("<key>CFBundleIconFile</key>\n  <string>icon.icns</string>");
    expect(plist).toContain("<key>LSBackgroundOnly</key>\n  <true/>");
    expect(plist.match(/<string>1\.2\.3<\/string>/g)).toHaveLength(2);
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

  test("requires a stable Developer ID identity for the daemon", () => {
    const signature = [
      `Identifier=${MACOS_CODE_SIGNING_IDENTIFIER}`,
      "Authority=Developer ID Application: Example Corp (ABCDE12345)",
      "TeamIdentifier=ABCDE12345",
      "Timestamp=22 Sep 2026 at 10:30:00",
      "CodeDirectory v=20500 flags=0x10000(runtime) hashes=10+2 location=embedded",
    ].join("\n");
    const requirement =
      `designated => identifier "${MACOS_CODE_SIGNING_IDENTIFIER}" and anchor apple generic ` +
      "and certificate leaf[subject.OU] = ABCDE12345";
    expect(developerIdSigningMetadata(signature, requirement, true)).toEqual({
      kind: "developer-id",
      developerId: true,
      notarized: true,
      timestamp: true,
      hardenedRuntime: true,
      identifier: MACOS_CODE_SIGNING_IDENTIFIER,
      identity: "Developer ID Application: Example Corp (ABCDE12345)",
      teamIdentifier: "ABCDE12345",
    });
    expect(() => developerIdSigningMetadata(signature, 'designated => cdhash H"abc"')).toThrow(
      "stable Developer ID designated requirement",
    );
  });

  test("accepts only a successful notarization result", () => {
    expect(notarizationAccepted(JSON.stringify({ id: "submission-id", status: "Accepted" }))).toBe(true);
    expect(notarizationAccepted(JSON.stringify({ id: "submission-id", status: "Invalid" }))).toBe(false);
    expect(notarizationAccepted("not json")).toBe(false);
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

  test("manifest records the reproducible build's ad-hoc security posture", () => {
    const manifest: MacReleaseManifest = {
      schemaVersion: 3,
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
        hardenedRuntime: false,
        identifier: null,
        identity: null,
        teamIdentifier: null,
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
    };
    expect(manifest.signing).toEqual({
      kind: "ad-hoc",
      developerId: false,
      notarized: false,
      timestamp: false,
      hardenedRuntime: false,
      identifier: null,
      identity: null,
      teamIdentifier: null,
    });
  });
});
