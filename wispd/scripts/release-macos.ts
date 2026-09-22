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

const SCRIPT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const MACOS_TARGET = "darwin-arm64";
export const MACOS_SUPPORTED_BASELINE = "macOS 26.6.2 (Apple Silicon arm64)";
export const MACOS_MANIFEST = "release-manifest-darwin-arm64.json";
export const MACOS_CHECKSUMS = "SHA256SUMS-darwin-arm64";
export const MACOS_CODE_SIGNING_IDENTIFIER = "dev.wisp.daemon";

export interface MacSigning {
  kind: "ad-hoc" | "developer-id";
  developerId: boolean;
  notarized: boolean;
  timestamp: boolean;
  hardenedRuntime: boolean;
  identifier: typeof MACOS_CODE_SIGNING_IDENTIFIER | null;
  identity: string | null;
  teamIdentifier: string | null;
}

export interface MacReleaseManifest {
  schemaVersion: 2;
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
  signing: MacSigning;
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
  /** Production-only Developer ID and notarization path. */
  signed?: boolean;
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

export function isAdHocCodeSignature(output: string): boolean {
  return output.split("\n").some((line) => {
    const trimmed = line.trim();
    return trimmed === "Signature=adhoc" || /^CodeDirectory\b.*\bflags=\S*\([^)]*\badhoc\b[^)]*\)/.test(trimmed);
  });
}

function signatureField(output: string, name: string): string | null {
  return output.match(new RegExp(`^${name}=(.+)$`, "m"))?.[1]?.trim() ?? null;
}

export function developerIdSigningMetadata(
  output: string,
  requirement: string,
  notarized = false,
): MacSigning {
  const identity = signatureField(output, "Authority");
  const teamIdentifier = signatureField(output, "TeamIdentifier");
  if (signatureField(output, "Identifier") !== MACOS_CODE_SIGNING_IDENTIFIER) {
    throw new Error("macOS daemon code-signing identifier is not stable");
  }
  if (!identity?.startsWith("Developer ID Application:")) {
    throw new Error("macOS daemon is not Developer ID Application signed");
  }
  if (!teamIdentifier || teamIdentifier === "not set") {
    throw new Error("macOS daemon has no Developer ID team identifier");
  }
  if (!/^Timestamp=.+$/m.test(output)) {
    throw new Error("macOS daemon has no trusted signing timestamp");
  }
  if (!/^CodeDirectory .*flags=.*\(runtime\)/m.test(output)) {
    throw new Error("macOS daemon does not enable the hardened runtime");
  }
  if (
    requirement.includes("cdhash") ||
    !requirement.includes(`identifier "${MACOS_CODE_SIGNING_IDENTIFIER}"`) ||
    !requirement.includes("anchor apple generic")
  ) {
    throw new Error("macOS daemon does not have a stable Developer ID designated requirement");
  }
  return {
    kind: "developer-id",
    developerId: true,
    notarized,
    timestamp: true,
    hardenedRuntime: true,
    identifier: MACOS_CODE_SIGNING_IDENTIFIER,
    identity,
    teamIdentifier,
  };
}

export function notarizationAccepted(output: string): boolean {
  try {
    const value = JSON.parse(output) as { id?: unknown; status?: unknown };
    return typeof value.id === "string" && value.id.length > 0 && value.status === "Accepted";
  } catch {
    return false;
  }
}

function git(root: string, args: string[]): string {
  return run(["git", "-C", root, ...args]);
}

export function assertMacReleaseSource(root: string, identity: SourceIdentity, requireTag: boolean): void {
  if (identity.dirty) throw new Error("release builds require a clean working tree, including no untracked files");
  const pkg = JSON.parse(readFileSync(resolve(root, "wispd/package.json"), "utf8")) as { version?: string };
  if (pkg.version !== VERSION) {
    throw new Error(
      `version mismatch: wispd/package.json=${JSON.stringify(pkg.version)}, source=${JSON.stringify(VERSION)}`,
    );
  }
  if (requireTag) {
    const expectedTag = `v${VERSION}`;
    const exactTag = git(root, ["tag", "--points-at", "HEAD", "--list", expectedTag]);
    if (exactTag !== expectedTag) throw new Error(`release tag must be ${expectedTag}, got ${JSON.stringify(exactTag)}`);
    const tagType = git(root, ["cat-file", "-t", `refs/tags/${expectedTag}`]);
    if (tagType !== "tag") throw new Error(`release tag ${expectedTag} must be annotated, got ${JSON.stringify(tagType)}`);
    const taggedCommit = git(root, ["rev-list", "-n", "1", expectedTag]);
    if (taggedCommit !== identity.commit) {
      throw new Error(`release tag ${expectedTag} points at ${taggedCommit}, expected ${identity.commit}`);
    }
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

function verifyMacBinary(
  binary: string,
  identity: SourceIdentity,
  signed: boolean,
  notarized = false,
): MacSigning {
  const fileType = run(["/usr/bin/file", "-b", binary]);
  if (!/Mach-O 64-bit executable arm64/.test(fileType)) {
    throw new Error(`artifact is not a native arm64 Mach-O executable: ${fileType}`);
  }
  const architectures = run(["/usr/bin/lipo", "-archs", binary]);
  if (architectures.trim() !== "arm64") throw new Error(`artifact architectures must be exactly arm64, got ${architectures}`);
  run(["/usr/bin/codesign", "--verify", "--strict", "--verbose=2", binary]);
  const signature = run(["/usr/bin/codesign", "--display", "--verbose=4", binary]);
  let signing: MacSigning;
  if (signed) {
    const requirement = run(["/usr/bin/codesign", "--display", "--requirements", "-", binary]);
    signing = developerIdSigningMetadata(signature, requirement, notarized);
  } else {
    if (!isAdHocCodeSignature(signature)) throw new Error(`artifact does not have an ad-hoc signature: ${signature}`);
    signing = {
      kind: "ad-hoc",
      developerId: false,
      notarized: false,
      timestamp: false,
      hardenedRuntime: signature.includes("(runtime)"),
      identifier: null,
      identity: null,
      teamIdentifier: null,
    };
  }
  const reported = JSON.parse(run([binary, "version", "--json"])) as {
    version?: unknown;
    commit?: unknown;
    dirty?: unknown;
  };
  if (reported.version !== VERSION || reported.commit !== identity.commit || reported.dirty !== false) {
    throw new Error(`artifact identity mismatch: ${JSON.stringify(reported)}`);
  }
  return signing;
}

function requireSignedEnvironment(): string {
  for (const name of ["APPLE_SIGNING_IDENTITY", "APPLE_API_ISSUER", "APPLE_API_KEY", "APPLE_API_KEY_PATH"]) {
    if (!process.env[name]) throw new Error(`signed macOS daemon release requires ${name}`);
  }
  const identities = run(["/usr/bin/security", "find-identity", "-v", "-p", "codesigning"]);
  if (!identities.includes(process.env.APPLE_SIGNING_IDENTITY!)) {
    throw new Error("signed macOS daemon release requires APPLE_SIGNING_IDENTITY in an unlocked Keychain");
  }
  return process.env.APPLE_SIGNING_IDENTITY!;
}

function notarizeMacBinary(binary: string, temp: string): void {
  const archive = join(temp, "wisp-notarization.zip");
  run(["/usr/bin/ditto", "-c", "-k", "--keepParent", binary, archive]);
  const cmd = [
    "/usr/bin/xcrun",
    "notarytool",
    "submit",
    archive,
    "--key",
    process.env.APPLE_API_KEY_PATH!,
    "--key-id",
    process.env.APPLE_API_KEY!,
    "--issuer",
    process.env.APPLE_API_ISSUER!,
    "--wait",
    "--output-format",
    "json",
  ];
  const result = Bun.spawnSync({ cmd, stdout: "pipe", stderr: "pipe" });
  const stdout = output(result.stdout);
  if (result.exitCode !== 0 || !notarizationAccepted(stdout)) {
    const detail = output(result.stderr) || stdout;
    throw new Error(`macOS daemon notarization failed${detail ? `: ${detail}` : ""}`);
  }
}

export function releaseMac(options: ReleaseMacOptions = {}): MacReleaseManifest {
  if (process.platform !== "darwin" || arch() !== "arm64") {
    throw new Error(`macOS releases require an Apple Silicon build host, got ${process.platform} ${arch()}`);
  }
  const root = options.root ?? SCRIPT_ROOT;
  const signed = options.signed ?? false;
  if (signed && !(options.requireTag ?? false)) {
    throw new Error("a signed macOS daemon release requires --require-tag");
  }
  const signingIdentity = signed ? requireSignedEnvironment() : null;
  const identity = options.identity ?? sourceIdentity(root);
  assertMacReleaseSource(root, identity, options.requireTag ?? false);

  const outDir = resolve(root, options.outDir ?? `dist/release/v${VERSION}`);
  const temp = mkdtempSync(join(tmpdir(), "wisp-release-macos-"));
  try {
    const binary = join(temp, "wisp");
    buildBinary({ target: "darwin-arm64", outfile: binary, root, identity });
    chmodSync(binary, 0o755);
    if (signed) {
      run([
        "/usr/bin/codesign",
        "--force",
        "--sign",
        signingIdentity!,
        "--identifier",
        MACOS_CODE_SIGNING_IDENTIFIER,
        "--options",
        "runtime",
        "--timestamp",
        binary,
      ]);
    } else {
      run(["/usr/bin/codesign", "--force", "--sign", "-", "--timestamp=none", binary]);
    }
    let signing = verifyMacBinary(binary, identity, signed);
    if (signed) {
      notarizeMacBinary(binary, temp);
      signing = { ...signing, notarized: true };
    }

    mkdirSync(outDir, { recursive: true });
    const artifactName = `wisp-v${VERSION}-${MACOS_TARGET}.tar.gz`;
    const artifactPath = resolve(outDir, artifactName);
    const binaryBytes = readFileSync(binary);
    writeFileSync(artifactPath, deterministicTarGz(binaryBytes), { mode: 0o644 });

    const extracted = join(temp, "extracted");
    mkdirSync(extracted);
    run(["/usr/bin/tar", "-xzf", artifactPath, "-C", extracted]);
    const extractedSigning = verifyMacBinary(join(extracted, "wisp"), identity, signed, signed);
    if (JSON.stringify(extractedSigning) !== JSON.stringify(signing)) {
      throw new Error("extracted macOS daemon signing identity differs from the staged executable");
    }

    const manifest: MacReleaseManifest = {
      schemaVersion: 2,
      product: "wisp",
      version: VERSION,
      apiProtocolVersion: API_PROTOCOL_VERSION,
      commit: identity.commit,
      dirty: false,
      target: { os: "darwin", arch: "arm64" },
      supportedBaseline: MACOS_SUPPORTED_BASELINE,
      signing,
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
    const signed = process.argv.slice(2).includes("--signed");
    const unknown = process.argv.slice(2).filter((arg) => arg !== "--require-tag" && arg !== "--signed");
    if (unknown.length > 0) throw new Error(`unknown argument: ${unknown[0]}`);
    const manifest = releaseMac({ requireTag, signed });
    console.log(
      `released ${manifest.artifact.file} (${manifest.artifact.sha256}) from ${manifest.commit} for ${MACOS_SUPPORTED_BASELINE}`,
    );
  } catch (error) {
    console.error(`release-macos: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
