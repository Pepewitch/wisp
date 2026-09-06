#!/usr/bin/env bun
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { DesktopReleaseManifest } from "./release-desktop";

const SHA256 = /^[0-9a-f]{64}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export function renderHomebrewCask(manifest: DesktopReleaseManifest): string {
  if (!VERSION.test(manifest.version)) throw new Error(`invalid desktop release version: ${JSON.stringify(manifest.version)}`);
  if (!SHA256.test(manifest.artifact.sha256)) {
    throw new Error(`invalid desktop artifact SHA-256: ${JSON.stringify(manifest.artifact.sha256)}`);
  }
  const expectedArtifact = `wisp-desktop-v${manifest.version}-darwin-arm64.tar.gz`;
  if (manifest.artifact.file !== expectedArtifact) {
    throw new Error(`unexpected desktop artifact filename: expected ${expectedArtifact}, got ${JSON.stringify(manifest.artifact.file)}`);
  }
  if (
    manifest.schemaVersion !== 1 ||
    manifest.product !== "wisp-desktop" ||
    manifest.dirty !== false ||
    manifest.target.os !== "darwin" ||
    manifest.target.arch !== "arm64" ||
    manifest.target.minimumVersion !== "12.3" ||
    manifest.minimumSystemVersion !== "macOS 12.3 (Apple Silicon arm64)" ||
    manifest.signing.kind !== "ad-hoc" ||
    manifest.signing.developerId ||
    manifest.signing.notarized ||
    manifest.signing.timestamp ||
    manifest.bundle.directory !== "Wisp.app" ||
    manifest.bundle.identifier !== "dev.wisp.desktop" ||
    manifest.artifact.format !== "app-tar.gz" ||
    manifest.artifact.binary.file !== "Wisp.app/Contents/MacOS/wisp-desktop"
  ) {
    throw new Error("manifest is not the approved ad-hoc Apple Silicon desktop alpha");
  }

  return `cask "wisp-desktop" do
  version "${manifest.version}"
  sha256 "${manifest.artifact.sha256}"

  url "https://github.com/Pepewitch/wisp/releases/download/v#{version}/wisp-desktop-v#{version}-darwin-arm64.tar.gz"
  name "Wisp Desktop"
  desc "Manage local and remote Wisp daemons from one native workspace"
  homepage "https://github.com/Pepewitch/wisp"

  depends_on arch: :arm64
  depends_on macos: :monterey
  depends_on formula: "pepewitch/tap/wisp"

  app "Wisp.app"

  uninstall quit: "dev.wisp.desktop"

  caveats <<~EOS
    This experimental Apple Silicon alpha requires macOS 12.3 or newer. It is
    ad-hoc signed, not Developer ID signed or notarized. On first launch,
    macOS may require explicit approval in Privacy & Security or Finder's Open
    command. Do not disable Gatekeeper globally.

    The required Wisp daemon Formula is installed as a dependency. Wisp Desktop
    asks for confirmation before initializing its profile or starting its
    Homebrew service.

    Uninstalling the Cask quits and removes the app but preserves desktop
    metadata and remote Keychain credentials. Remove remote connections or use
    Reset Desktop Data before uninstalling if you want those credentials
    removed.
  EOS
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
    throw new Error("usage: render-homebrew-cask.ts --manifest <desktop-manifest> --output <Casks/wisp-desktop.rb>");
  }
  return { manifest, output };
}

if (import.meta.main) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const manifest = JSON.parse(readFileSync(resolve(args.manifest), "utf8")) as DesktopReleaseManifest;
    const output = resolve(args.output);
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, renderHomebrewCask(manifest), { mode: 0o644 });
    console.log(`wrote ${output}`);
  } catch (error) {
    console.error(`render-homebrew-cask: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
