#!/usr/bin/env bun
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { MacReleaseManifest } from "./release-macos";

const SHA256 = /^[0-9a-f]{64}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export function renderHomebrewFormula(manifest: MacReleaseManifest): string {
  if (!VERSION.test(manifest.version)) throw new Error(`invalid release version: ${JSON.stringify(manifest.version)}`);
  if (!SHA256.test(manifest.artifact.sha256)) {
    throw new Error(`invalid artifact SHA-256: ${JSON.stringify(manifest.artifact.sha256)}`);
  }
  const expectedArtifact = `wisp-v${manifest.version}-darwin-arm64.tar.gz`;
  if (manifest.artifact.file !== expectedArtifact) {
    throw new Error(
      `unexpected Apple Silicon artifact filename: expected ${expectedArtifact}, got ${JSON.stringify(manifest.artifact.file)}`,
    );
  }
  if (
    manifest.schemaVersion !== 1 ||
    manifest.product !== "wisp" ||
    manifest.dirty !== false ||
    manifest.target.os !== "darwin" ||
    manifest.target.arch !== "arm64" ||
    manifest.signing.kind !== "ad-hoc" ||
    manifest.signing.developerId ||
    manifest.signing.notarized ||
    manifest.signing.timestamp ||
    manifest.artifact.format !== "tar.gz" ||
    manifest.artifact.binary.file !== "wisp"
  ) {
    throw new Error("manifest is not the approved ad-hoc Apple Silicon alpha");
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
    bin.install "wisp"
  end

  def caveats
    <<~EOS
      This experimental Apple Silicon alpha is ad-hoc signed, not Developer ID
      signed or notarized. Gatekeeper may require explicit approval. Do not
      disable Gatekeeper globally.

      Initialize and start Wisp:
        wisp init
        brew services start wisp
    EOS
  end

  service do
    run [opt_bin/"wisp", "serve"]
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
    const manifest = JSON.parse(readFileSync(resolve(args.manifest), "utf8")) as MacReleaseManifest;
    const output = resolve(args.output);
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, renderHomebrewFormula(manifest), { mode: 0o644 });
    console.log(`wrote ${output}`);
  } catch (error) {
    console.error(`render-homebrew-formula: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
