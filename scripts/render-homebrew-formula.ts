#!/usr/bin/env bun
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { compareVersions } from "../shared/release-version";
import {
  macosArchiveRoot,
  MACOS_APP_DIRECTORY,
  MACOS_APP_EXECUTABLE,
  MACOS_CODE_SIGNING_IDENTIFIER,
  type MacReleaseManifest,
} from "../wispd/scripts/release-macos";

const SHA256 = /^[0-9a-f]{64}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const LAST_AD_HOC_MACOS_RELEASE = "0.5.13";

/** Read-only compatibility for replaying already-published release receipts. */
export interface LegacyMacReleaseManifest {
  schemaVersion: 1;
  product: "wisp";
  version: string;
  apiProtocolVersion: number;
  commit: string;
  dirty: false;
  target: { os: "darwin"; arch: "arm64" };
  supportedBaseline: string;
  signing: {
    kind: "ad-hoc";
    developerId: false;
    notarized: false;
    timestamp: false;
  };
  artifact: {
    file: string;
    format: "tar.gz";
    sha256: string;
    size: number;
    binary: { file: "wisp"; sha256: string; size: number; mode: "0755" };
  };
}

/**
 * Schema 3 (0.5.14 only) put the app bundle at the archive root, so Homebrew
 * descended into the bundle and the rendered formula could not find it. That
 * layout is unbuildable and unrenderable on purpose: it must never come back
 * through a replayed promotion.
 */
function approvedSignedManifest(
  manifest: MacReleaseManifest | LegacyMacReleaseManifest,
): manifest is MacReleaseManifest {
  return Boolean(
    manifest.schemaVersion === 4 &&
      manifest.signing.kind === "developer-id" &&
      manifest.signing.developerId &&
      manifest.signing.notarized &&
      manifest.signing.timestamp &&
      manifest.signing.hardenedRuntime &&
      manifest.signing.identifier === MACOS_CODE_SIGNING_IDENTIFIER &&
      manifest.signing.identity?.startsWith("Developer ID Application:") &&
      manifest.signing.teamIdentifier,
  );
}

function approvedHistoricalManifest(manifest: MacReleaseManifest | LegacyMacReleaseManifest): boolean {
  return (
    manifest.schemaVersion === 1 &&
    compareVersions(manifest.version, LAST_AD_HOC_MACOS_RELEASE) <= 0 &&
    manifest.signing.kind === "ad-hoc" &&
    !manifest.signing.developerId &&
    !manifest.signing.notarized &&
    !manifest.signing.timestamp
  );
}

export function renderHomebrewFormula(manifest: MacReleaseManifest | LegacyMacReleaseManifest): string {
  if (!VERSION.test(manifest.version)) throw new Error(`invalid release version: ${JSON.stringify(manifest.version)}`);
  if (!Number.isSafeInteger(manifest.apiProtocolVersion) || manifest.apiProtocolVersion < 1) {
    throw new Error(`invalid API protocol version: ${JSON.stringify(manifest.apiProtocolVersion)}`);
  }
  if (!SHA256.test(manifest.artifact.sha256)) {
    throw new Error(`invalid artifact SHA-256: ${JSON.stringify(manifest.artifact.sha256)}`);
  }
  const expectedArtifact = `wisp-v${manifest.version}-darwin-arm64.tar.gz`;
  if (manifest.artifact.file !== expectedArtifact) {
    throw new Error(
      `unexpected Apple Silicon artifact filename: expected ${expectedArtifact}, got ${JSON.stringify(manifest.artifact.file)}`,
    );
  }
  const signed = approvedSignedManifest(manifest);
  const historicalAdHoc = approvedHistoricalManifest(manifest);
  if (
    manifest.product !== "wisp" ||
    manifest.dirty !== false ||
    manifest.target.os !== "darwin" ||
    manifest.target.arch !== "arm64" ||
    (!signed && !historicalAdHoc) ||
    (signed &&
      (manifest.artifact.format !== "app-tar.gz" ||
        manifest.artifact.root !== macosArchiveRoot(manifest.version) ||
        manifest.artifact.binary.file !== MACOS_APP_EXECUTABLE ||
        manifest.bundle.directory !== MACOS_APP_DIRECTORY ||
        manifest.bundle.identifier !== MACOS_CODE_SIGNING_IDENTIFIER ||
        manifest.bundle.executable !== "Contents/MacOS/wisp" ||
        manifest.bundle.icon !== "Contents/Resources/icon.icns" ||
        manifest.bundle.backgroundOnly !== true)) ||
    (historicalAdHoc &&
      (manifest.artifact.format !== "tar.gz" || manifest.artifact.binary.file !== "wisp"))
  ) {
    throw new Error("manifest is not an approved Apple Silicon daemon release");
  }
  const url =
    `https://github.com/Pepewitch/wisp/releases/download/v${manifest.version}/` +
    manifest.artifact.file;
  return `# typed: strict
# frozen_string_literal: true

# Wisp installs the native Apple Silicon CLI and its launchd service.
class Wisp < Formula
  desc "Harness-independent coding-agent task manager"
  homepage "https://github.com/Pepewitch/wisp"
  url "${url}"
  sha256 "${manifest.artifact.sha256}"
  license "MIT"

  depends_on arch: :arm64
  depends_on :macos

  def install
${signed
  ? `    libexec.install "${MACOS_APP_DIRECTORY}"
    bin.install_symlink libexec/"${MACOS_APP_DIRECTORY}/Contents/MacOS/wisp"`
  : `    bin.install "wisp"`}
  end

  def caveats
    <<~EOS
${signed
  ? `      This ${manifest.version.includes("-") ? "experimental Apple Silicon alpha" : "Apple Silicon daemon"} is Developer ID signed and
      notarized. Its branded background app and stable code identity preserve
      the App Management icon and privacy permission across upgrades.`
  : `      This ${manifest.version.includes("-") ? "experimental Apple Silicon alpha" : "Apple Silicon daemon"} is ad-hoc signed, not Developer ID
      signed or notarized. Gatekeeper may require explicit approval. Do not
      disable Gatekeeper globally.`}

      Initialize and start Wisp:
        wisp init
        brew services start wisp
    EOS
  end

  service do
    run [${signed ? `opt_libexec/"${MACOS_APP_DIRECTORY}/Contents/MacOS/wisp"` : `opt_bin/"wisp"`}, "serve"]
    keep_alive true
    working_dir Dir.home
    environment_variables PATH: "#{std_service_path_env}:#{Dir.home}/.local/bin:#{Dir.home}/.bun/bin"
    log_path var/"log/wisp.log"
    error_log_path var/"log/wisp.log"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/wisp version")
  end
end
`;
}

interface Args {
  manifest: string;
  output: string;
}

function parseArgs(args: string[]): Args {
  let manifest: string | undefined;
  let output: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    const value = args[index + 1];
    if (arg === "--manifest" && value) {
      manifest = value;
      index++;
    } else if (arg === "--output" && value) {
      output = value;
      index++;
    } else {
      throw new Error(`unknown or incomplete argument: ${arg}`);
    }
  }
  if (!manifest || !output) {
    throw new Error("usage: render-homebrew-formula.ts --manifest <release-manifest> --output <Formula/wisp.rb>");
  }
  return { manifest, output };
}

if (import.meta.main) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const manifest = JSON.parse(readFileSync(resolve(args.manifest), "utf8")) as
      | MacReleaseManifest
      | LegacyMacReleaseManifest;
    const output = resolve(args.output);
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, renderHomebrewFormula(manifest), { mode: 0o644 });
    console.log(`wrote ${output}`);
  } catch (error) {
    console.error(`render-homebrew-formula: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
