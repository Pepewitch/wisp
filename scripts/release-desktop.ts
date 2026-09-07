#!/usr/bin/env bun
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { arch, tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION } from "../src/version";
import { sourceIdentity, type SourceIdentity } from "./build-binary";
import { sha256File } from "./release-linux";
import { assertMacReleaseSource } from "./release-macos";

const SCRIPT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DESKTOP_TARGET = "darwin-arm64";
export const DESKTOP_MINIMUM_SYSTEM_VERSION = "macOS 12.3 (Apple Silicon arm64)";
export const DESKTOP_MANIFEST = "release-manifest-desktop-darwin-arm64.json";
export const DESKTOP_CHECKSUMS = "SHA256SUMS-desktop-darwin-arm64";
export const DESKTOP_BUNDLE_ID = "dev.wisp.desktop";

export interface DesktopReleaseManifest {
  schemaVersion: 2;
  product: "wisp-desktop";
  version: string;
  commit: string;
  dirty: false;
  target: { os: "darwin"; arch: "arm64"; minimumVersion: "12.3" };
  minimumSystemVersion: string;
  signing: {
    kind: "ad-hoc" | "developer-id";
    developerId: boolean;
    notarized: boolean;
    timestamp: boolean;
    hardenedRuntime: boolean;
    identity: string | null;
    teamIdentifier: string | null;
  };
  publishedAt: string | null;
  updater: null | {
    algorithm: "minisign-ed25519";
    signatureFile: string;
    signature: string;
    publicKeySha256: string;
  };
  bundle: { directory: "Wisp.app"; identifier: typeof DESKTOP_BUNDLE_ID };
  artifact: {
    file: string;
    format: "app-tar.gz";
    sha256: string;
    size: number;
    binary: { file: "Wisp.app/Contents/MacOS/wisp-desktop"; sha256: string; size: number; mode: "0755" };
  };
}

export interface ReleaseDesktopOptions {
  root?: string;
  outDir?: string;
  identity?: SourceIdentity;
  requireTag?: boolean;
  /** Production-only Developer ID, notarization, and updater signing path. */
  signed?: boolean;
}

interface VerifiedSigning {
  kind: "ad-hoc" | "developer-id";
  developerId: boolean;
  notarized: boolean;
  timestamp: boolean;
  hardenedRuntime: boolean;
  identity: string | null;
  teamIdentifier: string | null;
}

export function desktopTargetDir(root: string, configured = process.env.CARGO_TARGET_DIR): string {
  return configured
    ? resolve(root, configured)
    : resolve(root, "desktop/src-tauri/target");
}

function output(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("utf8").trim();
}

function run(cmd: string[], cwd?: string, env?: Record<string, string | undefined>): string {
  const result = Bun.spawnSync({ cmd, cwd, env, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    const detail = output(result.stderr) || output(result.stdout);
    throw new Error(`${cmd.join(" ")} failed${detail ? `: ${detail}` : ""}`);
  }
  return [output(result.stdout), output(result.stderr)].filter(Boolean).join("\n");
}

export function cargoPackageVersion(manifest: string): string {
  let inPackage = false;
  for (const line of manifest.split(/\r?\n/)) {
    const section = line.match(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/)?.[1];
    if (section) {
      inPackage = section === "package";
      continue;
    }
    if (!inPackage) continue;
    const version = line.match(/^\s*version\s*=\s*"([^"]+)"\s*(?:#.*)?$/)?.[1];
    if (version) return version;
  }
  throw new Error("Cargo.toml does not declare package.version");
}

export function desktopPackageVersion(root: string): string {
  return cargoPackageVersion(readFileSync(resolve(root, "desktop/src-tauri/Cargo.toml"), "utf8"));
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

function tarHeader(name: string, size: number, mode: number, type: "0" | "5"): Buffer {
  const header = Buffer.alloc(512);
  writeString(header, 0, 100, name);
  writeOctal(header, 100, 8, mode);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  writeString(header, 156, 1, type);
  writeString(header, 257, 6, "ustar\0");
  writeString(header, 263, 2, "00");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  writeString(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
  return header;
}

interface AppEntry {
  name: string;
  path: string;
  directory: boolean;
  mode: number;
}

function appEntries(app: string): AppEntry[] {
  const rootName = `${basename(app)}/`;
  const entries: AppEntry[] = [{ name: rootName, path: app, directory: true, mode: 0o755 }];
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const stat = lstatSync(path);
      const archiveName = `${rootName}${relative(app, path).split("/").join("/")}`;
      if (stat.isSymbolicLink()) throw new Error(`desktop archive refuses symbolic link: ${archiveName}`);
      if (stat.isDirectory()) {
        entries.push({ name: `${archiveName}/`, path, directory: true, mode: 0o755 });
        visit(path);
      } else if (stat.isFile()) {
        entries.push({ name: archiveName, path, directory: false, mode: stat.mode & 0o111 ? 0o755 : 0o644 });
      } else {
        throw new Error(`desktop archive refuses special file: ${archiveName}`);
      }
    }
  };
  visit(app);
  return entries;
}

const EXPECTED_APP_MEMBERS = [
  "",
  "Contents/",
  "Contents/Info.plist",
  "Contents/MacOS/",
  "Contents/MacOS/wisp-desktop",
  "Contents/Resources/",
  "Contents/Resources/icon.icns",
  "Contents/_CodeSignature/",
  "Contents/_CodeSignature/CodeResources",
] as const;

function verifyDesktopInventory(app: string): void {
  const prefix = `${basename(app)}/`;
  const entries = appEntries(app);
  const members = entries.map((entry) => entry.name.slice(prefix.length));
  if (JSON.stringify(members) !== JSON.stringify(EXPECTED_APP_MEMBERS)) {
    throw new Error(`desktop application member inventory mismatch: ${JSON.stringify(members)}`);
  }
  for (const entry of entries) {
    if (entry.directory) continue;
    const strings = run(["/usr/bin/strings", entry.path]);
    if (/\/Users\/|\.cargo\/registry|\.rustup\/toolchains/.test(strings)) {
      throw new Error(`desktop application member contains a builder path: ${entry.name}`);
    }
  }
}

/** A normalized ustar archive of one .app, with a reproducible gzip header. */
export function deterministicAppTarGz(app: string): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of appEntries(app)) {
    const body = entry.directory ? Buffer.alloc(0) : readFileSync(entry.path);
    blocks.push(tarHeader(entry.name, body.length, entry.mode, entry.directory ? "5" : "0"), body);
    if (body.length % 512 !== 0) blocks.push(Buffer.alloc(512 - (body.length % 512)));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks), { level: 9 });
}

function plist(app: string, key: string): string {
  return run(["/usr/libexec/PlistBuddy", "-c", `Print :${key}`, join(app, "Contents/Info.plist")]);
}

export function machOHasUuid(loadCommands: string): boolean {
  return /^\s*cmd LC_UUID\s*$/m.test(loadCommands);
}

function signatureField(output: string, name: string): string | null {
  return output.match(new RegExp(`^${name}=(.+)$`, "m"))?.[1]?.trim() ?? null;
}

function verifyDesktopApp(app: string, signed: boolean): VerifiedSigning {
  verifyDesktopInventory(app);
  const binary = join(app, "Contents/MacOS/wisp-desktop");
  const fileType = run(["/usr/bin/file", "-b", binary]);
  if (!/Mach-O 64-bit executable arm64/.test(fileType)) throw new Error(`desktop binary is not arm64: ${fileType}`);
  if (run(["/usr/bin/lipo", "-archs", binary]) !== "arm64") throw new Error("desktop binary is not arm64-only");
  run(["/usr/bin/codesign", "--verify", "--deep", "--strict", "--verbose=2", app]);
  const signature = run(["/usr/bin/codesign", "--display", "--verbose=4", app]);
  let signing: VerifiedSigning;
  if (signed) {
    const identity = signatureField(signature, "Authority");
    const teamIdentifier = signatureField(signature, "TeamIdentifier");
    if (!identity?.startsWith("Developer ID Application:")) {
      throw new Error("desktop application is not Developer ID Application signed");
    }
    if (!teamIdentifier || teamIdentifier === "not set") {
      throw new Error("desktop application has no Developer ID team identifier");
    }
    if (!/^Timestamp=.+$/m.test(signature)) {
      throw new Error("desktop application has no trusted signing timestamp");
    }
    if (!/^CodeDirectory .*flags=.*\(runtime\)/m.test(signature)) {
      throw new Error("desktop application does not enable the hardened runtime");
    }
    run(["/usr/bin/xcrun", "stapler", "validate", app]);
    run(["/usr/sbin/spctl", "--assess", "--type", "execute", "--verbose=4", app]);
    signing = {
      kind: "developer-id",
      developerId: true,
      notarized: true,
      timestamp: true,
      hardenedRuntime: true,
      identity,
      teamIdentifier,
    };
  } else {
    if (!signature.includes("Signature=adhoc")) {
      throw new Error("desktop development application is not ad-hoc signed");
    }
    signing = {
      kind: "ad-hoc",
      developerId: false,
      notarized: false,
      timestamp: false,
      hardenedRuntime: signature.includes("(runtime)"),
      identity: null,
      teamIdentifier: null,
    };
  }
  const buildVersion = run(["/usr/bin/vtool", "-show-build", binary]);
  if (!/^\s*minos\s+12\.3(?:\.0)?\s*$/m.test(buildVersion)) {
    throw new Error(`desktop Mach-O minimum macOS version mismatch: ${buildVersion}`);
  }
  if (!machOHasUuid(run(["/usr/bin/otool", "-l", binary]))) {
    throw new Error("desktop Mach-O has no LC_UUID and will not launch on current macOS");
  }
  if (plist(app, "CFBundleIdentifier") !== DESKTOP_BUNDLE_ID) throw new Error("desktop bundle identifier mismatch");
  if (plist(app, "CFBundleShortVersionString") !== VERSION) throw new Error("desktop bundle version mismatch");
  if (plist(app, "CFBundleVersion") !== VERSION) throw new Error("desktop bundle build version mismatch");
  if (plist(app, "LSMinimumSystemVersion") !== "12.3") throw new Error("desktop minimum macOS version mismatch");
  const strings = run(["/usr/bin/strings", binary]);
  if (!strings.includes(`wisp-desktop/${VERSION}`)) throw new Error("desktop binary package version mismatch");
  return signing;
}

export function releaseCertificateSource(
  environment: Record<string, string | undefined>,
): "environment" | "keychain" {
  const hasCertificate = Boolean(environment.APPLE_CERTIFICATE);
  const hasPassword = Boolean(environment.APPLE_CERTIFICATE_PASSWORD);
  if (hasCertificate !== hasPassword) {
    throw new Error("APPLE_CERTIFICATE and APPLE_CERTIFICATE_PASSWORD must be provided together");
  }
  return hasCertificate ? "environment" : "keychain";
}

function requireReleaseEnvironment(root: string): string {
  for (const name of [
    "APPLE_SIGNING_IDENTITY",
    "APPLE_API_ISSUER",
    "APPLE_API_KEY",
    "APPLE_API_KEY_PATH",
    "TAURI_SIGNING_PRIVATE_KEY",
    "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
  ]) {
    if (!process.env[name]) throw new Error(`signed desktop release requires ${name}`);
  }
  if (releaseCertificateSource(process.env) === "keychain") {
    const identities = run(["/usr/bin/security", "find-identity", "-v", "-p", "codesigning"]);
    if (!identities.includes(process.env.APPLE_SIGNING_IDENTITY!)) {
      throw new Error("signed desktop release requires APPLE_SIGNING_IDENTITY in the login Keychain");
    }
  }
  const publicKey = readFileSync(resolve(root, "desktop/src-tauri/updater-public.key"), "utf8").trim();
  if (!publicKey || publicKey === "UNCONFIGURED") {
    throw new Error("signed desktop release requires a committed updater public key");
  }
  return publicKey;
}

function annotatedTagDate(root: string): string {
  const tag = `v${VERSION}`;
  const raw = run(["git", "-C", root, "for-each-ref", `refs/tags/${tag}`, "--format=%(taggerdate:iso-strict)"]);
  const parsed = new Date(raw);
  if (!raw || Number.isNaN(parsed.valueOf())) throw new Error(`annotated tag ${tag} has no valid tagger date`);
  return parsed.toISOString();
}

function signUpdaterArtifact(root: string, artifactPath: string, publicKey: string): DesktopReleaseManifest["updater"] {
  run(["bun", "run", "tauri", "signer", "sign", artifactPath], root, process.env);
  const signaturePath = `${artifactPath}.sig`;
  const signature = readFileSync(signaturePath, "utf8").trim();
  if (!signature) throw new Error("Tauri signer produced an empty updater signature");
  run(
    [
      "cargo",
      "run",
      "--quiet",
      "--locked",
      "--manifest-path",
      "desktop/src-tauri/Cargo.toml",
      "--bin",
      "verify-update-signature",
      "--features",
      "release-verifier",
      "--",
      artifactPath,
      signaturePath,
      "desktop/src-tauri/updater-public.key",
    ],
    root,
  );
  return {
    algorithm: "minisign-ed25519",
    signatureFile: basename(signaturePath),
    signature,
    publicKeySha256: createHash("sha256").update(publicKey).digest("hex"),
  };
}

export function releaseDesktop(options: ReleaseDesktopOptions = {}): DesktopReleaseManifest {
  if (process.platform !== "darwin" || arch() !== "arm64") {
    throw new Error(`desktop releases require an Apple Silicon build host, got ${process.platform} ${arch()}`);
  }
  const root = options.root ?? SCRIPT_ROOT;
  const signed = options.signed ?? false;
  if (signed && !(options.requireTag ?? false)) {
    throw new Error("a signed desktop release requires --require-tag");
  }
  const updaterPublicKey = signed ? requireReleaseEnvironment(root) : null;
  const identity = options.identity ?? sourceIdentity(root);
  assertMacReleaseSource(root, identity, options.requireTag ?? false);
  const cargoVersion = desktopPackageVersion(root);
  if (cargoVersion !== VERSION) {
    throw new Error(`desktop Cargo version mismatch: Cargo.toml=${JSON.stringify(cargoVersion)}, source=${VERSION}`);
  }
  const targetDir = desktopTargetDir(root);
  run(["/bin/bash", "scripts/desktop/build-macos.sh", "--app-only"], root, {
    ...process.env,
    CARGO_TARGET_DIR: targetDir,
  });
  const afterBuild = sourceIdentity(root);
  if (afterBuild.dirty || afterBuild.commit !== identity.commit) {
    throw new Error("desktop build changed the clean release source");
  }
  const app = resolve(targetDir, "aarch64-apple-darwin/release/bundle/macos/Wisp.app");
  const signing = verifyDesktopApp(app, signed);

  const outDir = resolve(root, options.outDir ?? `dist/release/v${VERSION}`);
  mkdirSync(outDir, { recursive: true });
  const artifactName = `wisp-desktop-v${VERSION}-${DESKTOP_TARGET}.tar.gz`;
  const artifactPath = resolve(outDir, artifactName);
  writeFileSync(artifactPath, deterministicAppTarGz(app), { mode: 0o644 });
  const updater = signed ? signUpdaterArtifact(root, artifactPath, updaterPublicKey!) : null;

  const temp = mkdtempSync(join(tmpdir(), "wisp-desktop-release-"));
  try {
    run(["/usr/bin/tar", "-xzf", artifactPath, "-C", temp]);
    const extractedSigning = verifyDesktopApp(join(temp, "Wisp.app"), signed);
    if (JSON.stringify(extractedSigning) !== JSON.stringify(signing)) {
      throw new Error("extracted desktop signing identity differs from the staged application");
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }

  const binary = join(app, "Contents/MacOS/wisp-desktop");
  const manifest: DesktopReleaseManifest = {
    schemaVersion: 2,
    product: "wisp-desktop",
    version: VERSION,
    commit: identity.commit,
    dirty: false,
    target: { os: "darwin", arch: "arm64", minimumVersion: "12.3" },
    minimumSystemVersion: DESKTOP_MINIMUM_SYSTEM_VERSION,
    signing,
    publishedAt: signed ? annotatedTagDate(root) : null,
    updater,
    bundle: { directory: "Wisp.app", identifier: DESKTOP_BUNDLE_ID },
    artifact: {
      file: artifactName,
      format: "app-tar.gz",
      sha256: sha256File(artifactPath),
      size: statSync(artifactPath).size,
      binary: {
        file: "Wisp.app/Contents/MacOS/wisp-desktop",
        sha256: sha256File(binary),
        size: statSync(binary).size,
        mode: "0755",
      },
    },
  };
  const manifestPath = resolve(outDir, DESKTOP_MANIFEST);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
  writeFileSync(
    resolve(outDir, DESKTOP_CHECKSUMS),
    `${manifest.artifact.sha256}  ${artifactName}\n${updater ? `${sha256File(resolve(outDir, updater.signatureFile))}  ${updater.signatureFile}\n` : ""}${sha256File(manifestPath)}  ${DESKTOP_MANIFEST}\n`,
    { mode: 0o644 },
  );
  return manifest;
}

if (import.meta.main) {
  try {
    const requireTag = process.argv.slice(2).includes("--require-tag");
    const signed = process.argv.slice(2).includes("--signed");
    const unknown = process.argv.slice(2).filter((arg) => arg !== "--require-tag" && arg !== "--signed");
    if (unknown.length > 0) throw new Error(`unknown argument: ${unknown[0]}`);
    const manifest = releaseDesktop({ requireTag, signed });
    console.log(`released ${manifest.artifact.file} (${manifest.artifact.sha256}) from ${manifest.commit}`);
  } catch (error) {
    console.error(`release-desktop: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
