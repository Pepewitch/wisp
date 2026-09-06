import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  DESKTOP_BUNDLE_ID,
  DESKTOP_CHECKSUMS,
  DESKTOP_MANIFEST,
  DESKTOP_MINIMUM_SYSTEM_VERSION,
  DESKTOP_TARGET,
  cargoPackageVersion,
  desktopPackageVersion,
  desktopTargetDir,
  deterministicAppTarGz,
  machOHasUuid,
} from "../scripts/release-desktop";
import { VERSION } from "../src/version";

function syntheticApp(order: "forward" | "reverse"): string {
  const root = mkdtempSync(join(tmpdir(), "wisp-desktop-archive-"));
  const app = join(root, "Wisp.app");
  const files = [
    ["Contents/MacOS/wisp-desktop", "synthetic executable"],
    ["Contents/Info.plist", "synthetic plist"],
    ["Contents/Resources/icon.icns", "synthetic icon"],
    ["Contents/_CodeSignature/CodeResources", "synthetic signature"],
  ] as const;
  for (const [name, body] of order === "forward" ? files : [...files].reverse()) {
    const path = join(app, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
  }
  chmodSync(join(app, "Contents/MacOS/wisp-desktop"), 0o755);
  return app;
}

describe("Wisp Desktop release metadata", () => {
  test("uses stable Apple Silicon artifact identities", () => {
    expect(DESKTOP_TARGET).toBe("darwin-arm64");
    expect(DESKTOP_MINIMUM_SYSTEM_VERSION).toBe("macOS 12.3 (Apple Silicon arm64)");
    expect(DESKTOP_MANIFEST).toBe("release-manifest-desktop-darwin-arm64.json");
    expect(DESKTOP_CHECKSUMS).toBe("SHA256SUMS-desktop-darwin-arm64");
    expect(DESKTOP_BUNDLE_ID).toBe("dev.wisp.desktop");
  });

  test("keeps the Rust package version synchronized", () => {
    expect(desktopPackageVersion(resolve(import.meta.dir, ".."))).toBe(VERSION);
    expect(cargoPackageVersion(`[workspace]\nversion = "wrong"\n\n[package]\nname = "wisp-desktop"\nversion = "${VERSION}"\n`)).toBe(
      VERSION,
    );
    expect(() => cargoPackageVersion("[package]\nname = \"wisp-desktop\"\n")).toThrow("package.version");
  });

  test("resolves isolated Cargo targets from the repository root", () => {
    const root = join(tmpdir(), "synthetic-wisp-root");
    expect(desktopTargetDir(root, undefined)).toBe(resolve(root, "desktop/src-tauri/target"));
    expect(desktopTargetDir(root, "dist/cargo-target")).toBe(resolve(root, "dist/cargo-target"));
    expect(desktopTargetDir(root, resolve(root, "outside-target"))).toBe(resolve(root, "outside-target"));
  });

  test("detects the Mach-O UUID required by current macOS", () => {
    expect(machOHasUuid("Load command 8\n      cmd LC_UUID\n  cmdsize 24\n")).toBe(true);
    expect(machOHasUuid("Load command 8\n      cmd LC_BUILD_VERSION\n  cmdsize 32\n")).toBe(false);
  });

  test("creates byte-identical normalized application archives", () => {
    const first = deterministicAppTarGz(syntheticApp("forward"));
    const second = deterministicAppTarGz(syntheticApp("reverse"));
    expect(first.equals(second)).toBe(true);
    expect([...first.subarray(4, 8)]).toEqual([0, 0, 0, 0]);

    const root = mkdtempSync(join(tmpdir(), "wisp-desktop-extract-"));
    const archive = join(root, "desktop.tar.gz");
    writeFileSync(archive, first);
    const result = Bun.spawnSync({ cmd: ["/usr/bin/tar", "-xzf", archive, "-C", root] });
    expect(result.exitCode).toBe(0);
    expect(readFileSync(join(root, "Wisp.app/Contents/Info.plist"), "utf8")).toBe("synthetic plist");
    expect(statSync(join(root, "Wisp.app/Contents/MacOS/wisp-desktop")).mode & 0o777).toBe(0o755);
    expect(statSync(join(root, "Wisp.app/Contents/Info.plist")).mode & 0o777).toBe(0o644);
  });

  test("refuses links instead of creating an ambiguous application archive", () => {
    const app = syntheticApp("forward");
    symlinkSync("Info.plist", join(app, "Contents/Alias.plist"));
    expect(() => deterministicAppTarGz(app)).toThrow("refuses symbolic link");
  });
});
