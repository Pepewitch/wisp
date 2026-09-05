#!/usr/bin/env bun
import { gzipSync } from "node:zlib";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { arch, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { API_PROTOCOL_VERSION, VERSION } from "../src/version";
import { buildBinary, sourceIdentity, type SourceIdentity } from "./build-binary";
import { sha256File } from "./release-linux";

const SCRIPT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const MACOS_TARGET = "darwin-arm64";
export const MACOS_SUPPORTED_BASELINE = "macOS 26.6.2 (Apple Silicon arm64)";
export const MACOS_MANIFEST = "release-manifest-darwin-arm64.json";
export const MACOS_CHECKSUMS = "SHA256SUMS-darwin-arm64";

export interface MacReleaseManifest {
  schemaVersion: 1;
  product: "wisp";
  version: string;
  apiProtocolVersion: number;
  commit: string;
  dirty: false;
  target: {
    os: "darwin";
    arch: "arm64";
  };
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
    binary: {
      file: "wisp";
      sha256: string;
      size: number;
      mode: "0755";
    };
  };
}

export interface ReleaseMacOptions {
  root?: string;
  outDir?: string;
  identity?: SourceIdentity;
  requireTag?: boolean;
}

function output(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("utf8").trim();
}

function run(cmd: string[], cwd?: string): string {
  const result = Bun.spawnSync({ cmd, cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    const detail = output(result.stderr) || output(result.stdout);
    throw new Error(`${cmd.join(" ")} failed${detail ? `: ${detail}` : ""}`);
  }
  return [output(result.stdout), output(result.stderr)].filter(Boolean).join("\n");
}

function git(root: string, args: string[]): string {
  return run(["git", "-C", root, ...args]);
}

export function assertMacReleaseSource(root: string, identity: SourceIdentity, requireTag: boolean): void {
  if (identity.dirty) throw new Error("release builds require a clean working tree, including no untracked files");
  const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as { version?: string };
  if (pkg.version !== VERSION) {
    throw new Error(`version mismatch: package.json=${JSON.stringify(pkg.version)}, source=${JSON.stringify(VERSION)}`);
  }
  if (requireTag) {
    const tag = git(root, ["describe", "--tags", "--exact-match", "HEAD"]);
    if (tag !== `v${VERSION}`) throw new Error(`release tag must be v${VERSION}, got ${JSON.stringify(tag)}`);
  }
}

function writeString(header: Buffer, offset: number, length: number, value: string): void {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length > length) throw new Error(`tar field is too long: ${value}`);
  bytes.copy(header, offset);
}

function writeOctal(header: Buffer, offset: number, length: number, value: number): void {
  const encoded = `${value.toString(8).padStart(length - 1, "0")}\0`;
  if (encoded.length !== length) throw new Error(`tar numeric field does not fit: ${value}`);
  writeString(header, offset, length, encoded);
}

/** One-file ustar with normalized owner, timestamp, mode, and gzip header. */
export function deterministicTarGz(binary: Uint8Array): Buffer {
  const body = Buffer.from(binary);
  const header = Buffer.alloc(512);
  writeString(header, 0, 100, "wisp");
  writeOctal(header, 100, 8, 0o755);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, body.length);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  writeString(header, 156, 1, "0");
  writeString(header, 257, 6, "ustar\0");
  writeString(header, 263, 2, "00");
  writeOctal(header, 329, 8, 0);
  writeOctal(header, 337, 8, 0);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  writeString(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
  const padding = Buffer.alloc((512 - (body.length % 512)) % 512);
  const tar = Buffer.concat([header, body, padding, Buffer.alloc(1024)]);
  // Bun's node:zlib compatibility writes the reproducible gzip mtime 0.
  return gzipSync(tar, { level: 9 });
}

function verifyMacBinary(binary: string, identity: SourceIdentity): void {
  const fileType = run(["/usr/bin/file", "-b", binary]);
  if (!/Mach-O 64-bit executable arm64/.test(fileType)) {
    throw new Error(`artifact is not a native arm64 Mach-O executable: ${fileType}`);
  }
  const architectures = run(["/usr/bin/lipo", "-archs", binary]);
  if (architectures.trim() !== "arm64") throw new Error(`artifact architectures must be exactly arm64, got ${architectures}`);
  run(["/usr/bin/codesign", "--verify", "--strict", "--verbose=2", binary]);
  const signature = run(["/usr/bin/codesign", "--display", "--verbose=4", binary]);
  if (!signature.includes("Signature=adhoc")) throw new Error(`artifact does not have an ad-hoc signature: ${signature}`);
  const reported = JSON.parse(run([binary, "version", "--json"])) as {
    version?: unknown;
    commit?: unknown;
    dirty?: unknown;
  };
  if (reported.version !== VERSION || reported.commit !== identity.commit || reported.dirty !== false) {
    throw new Error(`artifact identity mismatch: ${JSON.stringify(reported)}`);
  }
}

export function releaseMac(options: ReleaseMacOptions = {}): MacReleaseManifest {
  if (process.platform !== "darwin" || arch() !== "arm64") {
    throw new Error(`macOS releases require an Apple Silicon build host, got ${process.platform} ${arch()}`);
  }
  const root = options.root ?? SCRIPT_ROOT;
  const identity = options.identity ?? sourceIdentity(root);
  assertMacReleaseSource(root, identity, options.requireTag ?? false);

  const outDir = resolve(root, options.outDir ?? `dist/release/v${VERSION}`);
  const temp = mkdtempSync(join(tmpdir(), "wisp-release-macos-"));
  try {
    const binary = join(temp, "wisp");
    buildBinary({ target: "darwin-arm64", outfile: binary, root, identity });
    chmodSync(binary, 0o755);
    run(["/usr/bin/codesign", "--force", "--sign", "-", "--timestamp=none", binary]);
    verifyMacBinary(binary, identity);

    mkdirSync(outDir, { recursive: true });
    const artifactName = `wisp-v${VERSION}-${MACOS_TARGET}.tar.gz`;
    const artifactPath = resolve(outDir, artifactName);
    const binaryBytes = readFileSync(binary);
    writeFileSync(artifactPath, deterministicTarGz(binaryBytes), { mode: 0o644 });

    const extracted = join(temp, "extracted");
    mkdirSync(extracted);
    run(["/usr/bin/tar", "-xzf", artifactPath, "-C", extracted]);
    verifyMacBinary(join(extracted, "wisp"), identity);

    const manifest: MacReleaseManifest = {
      schemaVersion: 1,
      product: "wisp",
      version: VERSION,
      apiProtocolVersion: API_PROTOCOL_VERSION,
      commit: identity.commit,
      dirty: false,
      target: { os: "darwin", arch: "arm64" },
      supportedBaseline: MACOS_SUPPORTED_BASELINE,
      signing: {
        kind: "ad-hoc",
        developerId: false,
        notarized: false,
        timestamp: false,
      },
      artifact: {
        file: artifactName,
        format: "tar.gz",
        sha256: sha256File(artifactPath),
        size: statSync(artifactPath).size,
        binary: {
          file: "wisp",
          sha256: sha256File(binary),
          size: statSync(binary).size,
          mode: "0755",
        },
      },
    };
    const manifestPath = resolve(outDir, MACOS_MANIFEST);
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
    writeFileSync(
      resolve(outDir, MACOS_CHECKSUMS),
      `${manifest.artifact.sha256}  ${artifactName}\n${sha256File(manifestPath)}  ${MACOS_MANIFEST}\n`,
      { mode: 0o644 },
    );
    return manifest;
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try {
    const requireTag = process.argv.slice(2).includes("--require-tag");
    const unknown = process.argv.slice(2).filter((arg) => arg !== "--require-tag");
    if (unknown.length > 0) throw new Error(`unknown argument: ${unknown[0]}`);
    const manifest = releaseMac({ requireTag });
    console.log(
      `released ${manifest.artifact.file} (${manifest.artifact.sha256}) from ${manifest.commit} for ${MACOS_SUPPORTED_BASELINE}`,
    );
  } catch (error) {
    console.error(`release-macos: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
