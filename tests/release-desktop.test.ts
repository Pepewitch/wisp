import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
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
  releaseCertificateSource,
  verifyDesktopInventory,
  verifyNoBuilderPaths,
} from "../scripts/release-desktop";
import { VERSION } from "../wispd/src/version";

const tempRoots: string[] = [];

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

afterAll(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

function syntheticApp(order: "forward" | "reverse"): string {
  const root = tempRoot("wisp-desktop-archive-");
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

  test("uses an installed signing identity locally or a complete CI certificate pair", () => {
    expect(releaseCertificateSource({})).toBe("keychain");
    expect(
      releaseCertificateSource({
        APPLE_CERTIFICATE: "encoded-certificate",
        APPLE_CERTIFICATE_PASSWORD: "secret",
      }),
    ).toBe("environment");
    expect(() => releaseCertificateSource({ APPLE_CERTIFICATE: "encoded-certificate" })).toThrow(
      "must be provided together",
    );
    expect(() => releaseCertificateSource({ APPLE_CERTIFICATE_PASSWORD: "secret" })).toThrow(
      "must be provided together",
    );
  });

  test("resolves isolated Cargo targets from the repository root", () => {
    const root = join(tmpdir(), "synthetic-wisp-root");
    expect(desktopTargetDir(root, undefined)).toBe(resolve(root, "desktop/src-tauri/target"));
    expect(desktopTargetDir(root, "dist/cargo-target")).toBe(resolve(root, "dist/cargo-target"));
    expect(desktopTargetDir(root, resolve(root, "outside-target"))).toBe(resolve(root, "outside-target"));
  });

  test("reproduces the macOS payload on two independent clean runners", () => {
    const workflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
    expect(workflow).toContain("macos-repro:");
    expect(workflow).toContain("copy: [a, b]");
    expect(workflow).toContain("name: release-macos-repro-${{ matrix.copy }}");
    expect(workflow).toContain("require independent byte-identical macOS payloads");
    expect(workflow).not.toContain("cargo clean --manifest-path desktop/src-tauri/Cargo.toml");
    expect(workflow).toContain("cache-targets: false");
  });

  test("hands one reproducible UI bundle from Linux to every macOS release pass", () => {
    const workflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
    expect(workflow.match(/name: canonical-ui-bundle/g)).toHaveLength(4);
    expect(workflow).toContain("sha256sum index.html > SHA256SUMS");
    expect(workflow).toContain("shasum -a 256 -c SHA256SUMS");
    expect(workflow.match(/WISP_PREBUILT_UI=1/g)).toHaveLength(2);
    expect(workflow).not.toContain("committed web bundle is current");

    const pullRequestWorkflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
    expect(pullRequestWorkflow).not.toContain("git diff --exit-code -- web/ui-dist");
  });

  test("uses ad-hoc signing only when neither release credential source is present", () => {
    const buildScript = readFileSync(new URL("../scripts/desktop/build-macos.sh", import.meta.url), "utf8");
    expect(buildScript).not.toContain("signing_config[@]");
    expect(buildScript).toContain('tauri_args=(\n  build');
    expect(buildScript).toContain(
      'if [ -z "${APPLE_CERTIFICATE:-}" ] && [ -z "${APPLE_SIGNING_IDENTITY:-}" ]; then',
    );
    expect(buildScript).toContain('tauri_args+=(--config');
    expect(buildScript).toContain('"${tauri[@]}" "${tauri_args[@]}" -- --locked');
  });

  test("only skips UI generation when a canonical bundle is present", () => {
    const buildScript = readFileSync(new URL("../scripts/desktop/build-macos.sh", import.meta.url), "utf8");
    expect(buildScript).toContain('case "${WISP_PREBUILT_UI:-0}" in');
    expect(buildScript).toContain("0) bun run build:ui");
    expect(buildScript).toContain("test -f web/ui-dist/index.html");
    expect(buildScript).toContain("WISP_PREBUILT_UI must be 0 or 1");
  });

  test("builds the transferred updater verifier once in the trusted target", () => {
    const releaseScript = readFileSync(new URL("../scripts/release-desktop.ts", import.meta.url), "utf8");
    const desktopCargo = readFileSync(new URL("../desktop/src-tauri/Cargo.toml", import.meta.url), "utf8");
    const verifierCargo = readFileSync(new URL("../scripts/update-verifier/Cargo.toml", import.meta.url), "utf8");
    const workflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
    expect(releaseScript).toContain('"scripts/update-verifier/Cargo.toml"');
    expect(releaseScript).toContain('"--release",\n      "--target",\n      "aarch64-apple-darwin"');
    expect(desktopCargo).not.toContain("release-verifier");
    expect(desktopCargo).not.toContain("minisign-verify");
    expect(verifierCargo).toContain('name = "verify-update-signature"');
    expect(verifierCargo).toContain('base64 = "0.22"');
    expect(verifierCargo).toContain('minisign-verify = "0.2.5"');
    expect(workflow).toContain("name: release-update-verifier");
    expect(workflow).toContain("shasum -a 256 verify-update-signature > SHA256SUMS");
    expect(workflow).toContain('WISP_UPDATE_VERIFIER=$RUNNER_TEMP/release-verifier/verify-update-signature');
  });

  test("signs both Mac artifacts in the trusted job and keeps publication build-free", () => {
    const workflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
    const trusted = workflow.slice(workflow.indexOf("  macos-trusted:"), workflow.indexOf("  publish:"));
    const publish = workflow.slice(workflow.indexOf("  publish:"), workflow.indexOf("  promote:"));

    expect(trusted).toContain("secrets.APPLE_CERTIFICATE");
    expect(trusted).toContain("secrets.TAURI_SIGNING_PRIVATE_KEY");
    expect(trusted).toContain("wispd/scripts/release-macos.ts --require-tag --signed");
    expect(trusted).toContain("scripts/release-desktop.ts --require-tag --signed");
    expect(trusted).toContain("name: release-trusted-macos-assets");
    expect(publish).toContain("needs: [release-linux, macos-repro, macos-trusted]");
    expect(publish).not.toContain("secrets.APPLE_");
    expect(publish).not.toContain("scripts/release-desktop.ts");
    expect(publish).not.toContain("wispd/scripts/release-macos.ts");
    expect(publish).not.toContain("cargo run");
  });

  test("binds cached native outputs to the UI generated before Tauri compiles", () => {
    const checkScript = readFileSync(new URL("../scripts/desktop/check.sh", import.meta.url), "utf8");
    expect(checkScript.indexOf("bun run build:ui")).toBeGreaterThan(-1);
    expect(checkScript.indexOf("bun run build:ui")).toBeLessThan(checkScript.indexOf("cargo fmt"));

    const workflow = readFileSync(new URL("../.github/workflows/desktop.yml", import.meta.url), "utf8");
    const buildUi = workflow.indexOf("name: build shared UI bundle");
    const cacheRestore = workflow.indexOf("uses: Swatinem/rust-cache");
    const bundleKey = workflow.indexOf("key: ${{ hashFiles('web/ui-dist/index.html') }}");
    expect(buildUi).toBeGreaterThan(-1);
    expect(cacheRestore).toBeGreaterThan(buildUi);
    expect(bundleKey).toBeGreaterThan(cacheRestore);
    expect(buildUi).toBeLessThan(workflow.indexOf("name: formatting"));
    expect(workflow).not.toContain("cargo clean --package wisp-desktop");
    expect(workflow).not.toContain("cache-targets: false");
    expect(workflow.match(/CARGO_BUILD_JOBS: "1"/g)).toHaveLength(2);
    expect(checkScript).toContain("cargo clippy --jobs 1");
    expect(checkScript).toContain("cargo test --jobs 1");
    expect(workflow).toContain('WISP_PREBUILT_UI: "1"');
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

    const root = tempRoot("wisp-desktop-extract-");
    const archive = join(root, "desktop.tar.gz");
    writeFileSync(archive, first);
    const result = Bun.spawnSync({ cmd: ["/usr/bin/tar", "-xzf", archive, "-C", root] });
    expect(result.exitCode).toBe(0);
    expect(readFileSync(join(root, "Wisp.app/Contents/Info.plist"), "utf8")).toBe("synthetic plist");
    expect(statSync(join(root, "Wisp.app/Contents/MacOS/wisp-desktop")).mode & 0o777).toBe(0o755);
    expect(statSync(join(root, "Wisp.app/Contents/Info.plist")).mode & 0o777).toBe(0o644);
  });

  test("accepts Apple's stapled ticket only for trusted release applications", () => {
    const app = syntheticApp("forward");
    expect(() => verifyDesktopInventory(app, false)).not.toThrow();
    expect(() => verifyDesktopInventory(app, true)).toThrow("member inventory mismatch");

    writeFileSync(join(app, "Contents/CodeResources"), "synthetic notarization ticket");
    expect(() => verifyDesktopInventory(app, true)).not.toThrow();
    expect(() => verifyDesktopInventory(app, false)).toThrow("member inventory mismatch");
  });

  test("refuses a member that leaks a build host path", () => {
    expect(() => verifyNoBuilderPaths(syntheticApp("forward"))).not.toThrow();
    const leaking = syntheticApp("forward");
    writeFileSync(join(leaking, "Contents/Info.plist"), "built from /Users/builder/wisp");
    expect(() => verifyNoBuilderPaths(leaking)).toThrow("builder path");
  });

  test("refuses links instead of creating an ambiguous application archive", () => {
    const app = syntheticApp("forward");
    symlinkSync("Info.plist", join(app, "Contents/Alias.plist"));
    expect(() => deterministicAppTarGz(app)).toThrow("refuses symbolic link");
  });
});
