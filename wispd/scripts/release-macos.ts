#!/usr/bin/env bun
import { gzipSync } from "node:zlib";
import {
  chmodSync,
  existsSync,
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
import { API_PROTOCOL_VERSION, VERSION } from "../src/version";
import { buildBinary, sourceIdentity, type SourceIdentity } from "./build-binary";
import { sha256File } from "./release-linux";

const SCRIPT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const MACOS_TARGET = "darwin-arm64";
export const MACOS_SUPPORTED_BASELINE = "macOS 26.6.2 (Apple Silicon arm64)";
export const MACOS_MANIFEST = "release-manifest-darwin-arm64.json";
export const MACOS_CHECKSUMS = "SHA256SUMS-darwin-arm64";
export const MACOS_CODE_SIGNING_IDENTIFIER = "dev.wisp.daemon";

/**
 * The daemon embeds Bun, and `wispd/src/pty.ts` reaches libc through `bun:ffi`
 * to run the terminal. `bun:ffi`'s dlopen writes executable trampolines at
 * runtime, which the hardened runtime forbids by default: 0.5.15 shipped a
 * hardened, Developer ID signed daemon with NO entitlements, so every attempt
 * to open a terminal trapped in `pthread_jit_write_protect_np` (SIGTRAP) and
 * took the whole daemon down with it. `allow-unsigned-executable-memory` is the
 * one that makes FFI work; `allow-jit` covers JavaScriptCore's own MAP_JIT
 * path. Ad-hoc builds must NOT carry these — the kernel SIGKILLs an ad-hoc
 * binary that claims a restricted entitlement — and they are not hardened, so
 * they do not need them.
 */
export const MACOS_ENTITLEMENTS = [
  "com.apple.security.cs.allow-jit",
  "com.apple.security.cs.allow-unsigned-executable-memory",
] as const;

export function daemonEntitlementsPlist(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${MACOS_ENTITLEMENTS.map((key) => `  <key>${key}</key>\n  <true/>`).join("\n")}
</dict>
</plist>
`;
}
export const MACOS_APP_DIRECTORY = "Wisp Daemon.app";
export const MACOS_APP_EXECUTABLE = `${MACOS_APP_DIRECTORY}/Contents/MacOS/wisp`;
export const MACOS_APP_ICON = `${MACOS_APP_DIRECTORY}/Contents/Resources/icon.icns`;

/**
 * Homebrew stages an archive and, when the result is a lone top-level
 * directory, descends into it before `install` runs. An archive whose only
 * entry is the app bundle therefore leaves the formula standing *inside* the
 * bundle, where its own name no longer resolves: 0.5.14 shipped that layout and
 * could not be installed at all. Nesting the bundle under a versioned directory
 * gives that descent something to land on and restores the conventional shape.
 */
export function macosArchiveRoot(version: string): string {
  return `wisp-v${version}-${MACOS_TARGET}`;
}

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
  schemaVersion: 4;
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
  bundle: {
    directory: typeof MACOS_APP_DIRECTORY;
    identifier: typeof MACOS_CODE_SIGNING_IDENTIFIER;
    executable: "Contents/MacOS/wisp";
    icon: "Contents/Resources/icon.icns";
    backgroundOnly: true;
  };
  artifact: {
    file: string;
    /** The archive's single top-level directory, which Homebrew descends into. */
    root: string;
    format: "app-tar.gz";
    sha256: string;
    size: number;
    binary: {
      file: typeof MACOS_APP_EXECUTABLE;
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

function appEntries(app: string, root: string): AppEntry[] {
  const rootName = `${root}/`;
  const bundleName = `${rootName}${basename(app)}/`;
  const entries: AppEntry[] = [
    { name: rootName, path: dirname(app), directory: true, mode: 0o755 },
    { name: bundleName, path: app, directory: true, mode: 0o755 },
  ];
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const stat = lstatSync(path);
      const archiveName = `${bundleName}${relative(app, path).split("/").join("/")}`;
      if (stat.isSymbolicLink()) throw new Error(`macOS daemon archive refuses symbolic link: ${archiveName}`);
      if (stat.isDirectory()) {
        entries.push({ name: `${archiveName}/`, path, directory: true, mode: 0o755 });
        visit(path);
      } else if (stat.isFile()) {
        entries.push({ name: archiveName, path, directory: false, mode: stat.mode & 0o111 ? 0o755 : 0o644 });
      } else {
        throw new Error(`macOS daemon archive refuses special file: ${archiveName}`);
      }
    }
  };
  visit(app);
  return entries;
}

/**
 * A normalized ustar archive of the daemon app nested under `root`, with a
 * reproducible gzip header.
 */
export function deterministicDaemonAppTarGz(app: string, root: string): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of appEntries(app, root)) {
    const body = entry.directory ? Buffer.alloc(0) : readFileSync(entry.path);
    blocks.push(tarHeader(entry.name, body.length, entry.mode, entry.directory ? "5" : "0"), body);
    if (body.length % 512 !== 0) blocks.push(Buffer.alloc(512 - (body.length % 512)));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks), { level: 9 });
}

export function daemonInfoPlist(version: string): string {
  const bundleVersion = version.split("-", 1)[0];
  if (!/^\d+\.\d+\.\d+$/.test(bundleVersion)) throw new Error(`invalid daemon bundle version: ${version}`);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleDisplayName</key>
  <string>Wisp Daemon</string>
  <key>CFBundleExecutable</key>
  <string>wisp</string>
  <key>CFBundleIconFile</key>
  <string>icon.icns</string>
  <key>CFBundleIdentifier</key>
  <string>${MACOS_CODE_SIGNING_IDENTIFIER}</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>Wisp Daemon</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>${bundleVersion}</string>
  <key>CFBundleVersion</key>
  <string>${bundleVersion}</string>
  <key>LSBackgroundOnly</key>
  <true/>
</dict>
</plist>
`;
}

function buildDaemonIcon(root: string, temp: string, destination: string): void {
  const source = resolve(root, "desktop/src-tauri/icons/icon.png");
  const iconset = join(temp, "daemon.iconset");
  mkdirSync(iconset);
  for (const size of [16, 32, 128, 256, 512]) {
    run([
      "/usr/bin/sips",
      "-z",
      String(size),
      String(size),
      source,
      "--out",
      join(iconset, `icon_${size}x${size}.png`),
    ]);
    const retina = size * 2;
    run([
      "/usr/bin/sips",
      "-z",
      String(retina),
      String(retina),
      source,
      "--out",
      join(iconset, `icon_${size}x${size}@2x.png`),
    ]);
  }
  run(["/usr/bin/iconutil", "-c", "icns", iconset, "-o", destination]);
}

function plist(app: string, key: string): string {
  return run(["/usr/libexec/PlistBuddy", "-c", `Print :${key}`, join(app, "Contents/Info.plist")]);
}

function verifyMacApp(
  app: string,
  identity: SourceIdentity,
  signed: boolean,
  notarized = false,
): MacSigning {
  const binary = join(app, "Contents/MacOS/wisp");
  const fileType = run(["/usr/bin/file", "-b", binary]);
  if (!/Mach-O 64-bit executable arm64/.test(fileType)) {
    throw new Error(`artifact is not a native arm64 Mach-O executable: ${fileType}`);
  }
  const architectures = run(["/usr/bin/lipo", "-archs", binary]);
  if (architectures.trim() !== "arm64") throw new Error(`artifact architectures must be exactly arm64, got ${architectures}`);
  run(["/usr/bin/codesign", "--verify", "--deep", "--strict", "--verbose=2", app]);
  if (plist(app, "CFBundleIdentifier") !== MACOS_CODE_SIGNING_IDENTIFIER) {
    throw new Error("macOS daemon bundle identifier is not stable");
  }
  if (
    plist(app, "CFBundleDisplayName") !== "Wisp Daemon" ||
    plist(app, "CFBundleExecutable") !== "wisp" ||
    plist(app, "CFBundleIconFile") !== "icon.icns"
  ) {
    throw new Error("macOS daemon bundle metadata is incomplete");
  }
  const iconPath = join(app, "Contents/Resources/icon.icns");
  if (!existsSync(iconPath)) throw new Error("macOS daemon bundle icon is missing");
  const icon = statSync(iconPath);
  if (!icon.isFile() || icon.size === 0) throw new Error("macOS daemon bundle icon is missing");
  if (plist(app, "CFBundlePackageType") !== "APPL" || plist(app, "LSBackgroundOnly") !== "true") {
    throw new Error("macOS daemon is not a background application bundle");
  }
  const signature = run(["/usr/bin/codesign", "--display", "--verbose=4", binary]);
  let signing: MacSigning;
  if (signed) {
    const requirement = run(["/usr/bin/codesign", "--display", "--requirements", "-", binary]);
    // The hardened runtime blocks bun:ffi unless the signature grants it. A
    // daemon that cannot dlopen cannot open a terminal, and it crashes rather
    // than degrading, so this is a publication gate and not a warning.
    const entitlements = run(["/usr/bin/codesign", "--display", "--entitlements", ":-", app]);
    for (const key of MACOS_ENTITLEMENTS) {
      if (!entitlements.includes(key)) {
        throw new Error(`macOS daemon signature is missing the ${key} entitlement`);
      }
    }
    signing = developerIdSigningMetadata(signature, requirement, notarized);
    if (notarized) {
      run(["/usr/bin/xcrun", "stapler", "validate", app]);
      run(["/usr/sbin/spctl", "--assess", "--type", "execute", "--verbose=4", app]);
    }
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

function notarizeMacApp(app: string, temp: string): void {
  const archive = join(temp, "wisp-notarization.zip");
  run(["/usr/bin/ditto", "-c", "-k", "--keepParent", app, archive]);
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
  run(["/usr/bin/xcrun", "stapler", "staple", app]);
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
    const app = join(temp, MACOS_APP_DIRECTORY);
    const binary = join(app, "Contents/MacOS/wisp");
    const resources = join(app, "Contents/Resources");
    mkdirSync(dirname(binary), { recursive: true });
    mkdirSync(resources, { recursive: true });
    buildBinary({ target: "darwin-arm64", outfile: binary, root, identity });
    chmodSync(binary, 0o755);
    writeFileSync(join(app, "Contents/Info.plist"), daemonInfoPlist(VERSION), { mode: 0o644 });
    buildDaemonIcon(root, temp, join(resources, "icon.icns"));
    if (signed) {
      const entitlements = join(temp, "wispd.entitlements");
      writeFileSync(entitlements, daemonEntitlementsPlist(), { mode: 0o644 });
      run([
        "/usr/bin/codesign",
        "--force",
        "--sign",
        signingIdentity!,
        "--options",
        "runtime",
        "--entitlements",
        entitlements,
        "--timestamp",
        app,
      ]);
    } else {
      run(["/usr/bin/codesign", "--force", "--sign", "-", "--timestamp=none", app]);
    }
    let signing = verifyMacApp(app, identity, signed);
    if (signed) {
      notarizeMacApp(app, temp);
      signing = verifyMacApp(app, identity, true, true);
    }

    mkdirSync(outDir, { recursive: true });
    const artifactName = `wisp-v${VERSION}-${MACOS_TARGET}.tar.gz`;
    const artifactPath = resolve(outDir, artifactName);
    const archiveRoot = macosArchiveRoot(VERSION);
    writeFileSync(artifactPath, deterministicDaemonAppTarGz(app, archiveRoot), { mode: 0o644 });

    const extracted = join(temp, "extracted");
    mkdirSync(extracted);
    run(["/usr/bin/tar", "-xzf", artifactPath, "-C", extracted]);
    // Homebrew descends into a lone top-level directory before `install` runs.
    // The rendered formula installs `Wisp Daemon.app` by name from there, so the
    // archive must expose exactly that one directory and nothing else.
    const staged = readdirSync(extracted);
    if (staged.length !== 1 || staged[0] !== archiveRoot) {
      throw new Error(
        `macOS daemon archive must contain only ${archiveRoot}, got ${JSON.stringify(staged)}`,
      );
    }
    const extractedSigning = verifyMacApp(
      join(extracted, archiveRoot, MACOS_APP_DIRECTORY),
      identity,
      signed,
      signed,
    );
    if (JSON.stringify(extractedSigning) !== JSON.stringify(signing)) {
      throw new Error("extracted macOS daemon signing identity differs from the staged executable");
    }

    const manifest: MacReleaseManifest = {
      schemaVersion: 4,
      product: "wisp",
      version: VERSION,
      apiProtocolVersion: API_PROTOCOL_VERSION,
      commit: identity.commit,
      dirty: false,
      target: { os: "darwin", arch: "arm64" },
      supportedBaseline: MACOS_SUPPORTED_BASELINE,
      signing,
      bundle: {
        directory: MACOS_APP_DIRECTORY,
        identifier: MACOS_CODE_SIGNING_IDENTIFIER,
        executable: "Contents/MacOS/wisp",
        icon: "Contents/Resources/icon.icns",
        backgroundOnly: true,
      },
      artifact: {
        file: artifactName,
        root: archiveRoot,
        format: "app-tar.gz",
        sha256: sha256File(artifactPath),
        size: statSync(artifactPath).size,
        binary: {
          file: MACOS_APP_EXECUTABLE,
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
