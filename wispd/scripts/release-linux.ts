#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { API_PROTOCOL_VERSION, VERSION } from "../src/version";
import { buildBinary, sourceIdentity, type SourceIdentity } from "./build-binary";
import { glibcFloor } from "./glibc-floor";

const SCRIPT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const LINUX_TARGET = "linux-x86_64";
export const SUPPORTED_BASELINE = "Ubuntu 24.04 LTS (x86_64)";
/**
 * Oldest glibc the artifact links against, quoted by README.md and
 * docs/INSTALL.md as the difference between "runs" and "supported". It comes
 * from the pinned Bun runtime, not from Wisp's source, so the release build
 * re-derives it and fails rather than let a toolchain upgrade quietly raise
 * the floor under a published install guide.
 */
export const MINIMUM_GLIBC = "2.17";

export interface ReleaseManifest {
  schemaVersion: 1;
  product: "wisp";
  version: string;
  apiProtocolVersion: number;
  commit: string;
  dirty: false;
  target: {
    os: "linux";
    arch: "x86_64";
    libc: "glibc";
  };
  supportedBaseline: string;
  artifact: {
    file: string;
    sha256: string;
    size: number;
  };
}

export interface ReleaseLinuxOptions {
  root?: string;
  outDir?: string;
  identity?: SourceIdentity;
  requireTag?: boolean;
}

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function git(root: string, args: string[]): string {
  const result = Bun.spawnSync({
    cmd: ["git", "-C", root, ...args],
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    const detail = Buffer.from(result.stderr).toString("utf8").trim();
    throw new Error(`git ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`);
  }
  return Buffer.from(result.stdout).toString("utf8").trim();
}

function assertReleaseSource(root: string, identity: SourceIdentity, requireTag: boolean): void {
  if (identity.dirty) {
    throw new Error("release builds require a clean working tree, including no untracked files");
  }
  const pkg = JSON.parse(readFileSync(resolve(root, "wispd/package.json"), "utf8")) as { version?: string };
  if (pkg.version !== VERSION) {
    throw new Error(
      `version mismatch: wispd/package.json=${JSON.stringify(pkg.version)}, source=${JSON.stringify(VERSION)}`,
    );
  }
  if (requireTag) {
    const tag = git(root, ["describe", "--tags", "--exact-match", "HEAD"]);
    if (tag !== `v${VERSION}`) throw new Error(`release tag must be v${VERSION}, got ${JSON.stringify(tag)}`);
  }
}

export function assertGlibcFloor(artifactPath: string): void {
  const floor = glibcFloor(artifactPath);
  if (floor !== MINIMUM_GLIBC) {
    throw new Error(
      `artifact requires glibc ${floor}, not the documented floor ${MINIMUM_GLIBC}; ` +
        "update MINIMUM_GLIBC and the floor stated in README.md and docs/INSTALL.md",
    );
  }
}

export function releaseLinux(options: ReleaseLinuxOptions = {}): ReleaseManifest {
  const root = options.root ?? SCRIPT_ROOT;
  const identity = options.identity ?? sourceIdentity(root);
  assertReleaseSource(root, identity, options.requireTag ?? false);

  const outDir = resolve(root, options.outDir ?? `dist/release/v${VERSION}`);
  mkdirSync(outDir, { recursive: true });
  const artifactName = `wisp-v${VERSION}-${LINUX_TARGET}`;
  const artifactPath = resolve(outDir, artifactName);
  buildBinary({ target: "linux-x64", outfile: artifactPath, root, identity });
  chmodSync(artifactPath, 0o755);
  assertGlibcFloor(artifactPath);

  const manifest: ReleaseManifest = {
    schemaVersion: 1,
    product: "wisp",
    version: VERSION,
    apiProtocolVersion: API_PROTOCOL_VERSION,
    commit: identity.commit,
    dirty: false,
    target: { os: "linux", arch: "x86_64", libc: "glibc" },
    supportedBaseline: SUPPORTED_BASELINE,
    artifact: {
      file: artifactName,
      sha256: sha256File(artifactPath),
      size: statSync(artifactPath).size,
    },
  };
  const manifestPath = resolve(outDir, "release-manifest.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
  writeFileSync(
    resolve(outDir, "SHA256SUMS"),
    `${manifest.artifact.sha256}  ${artifactName}\n${sha256File(manifestPath)}  release-manifest.json\n`,
    { mode: 0o644 },
  );
  return manifest;
}

if (import.meta.main) {
  try {
    const requireTag = process.argv.slice(2).includes("--require-tag");
    const unknown = process.argv.slice(2).filter((arg) => arg !== "--require-tag");
    if (unknown.length > 0) throw new Error(`unknown argument: ${unknown[0]}`);
    const manifest = releaseLinux({ requireTag });
    console.log(
      `released ${manifest.artifact.file} (${manifest.artifact.sha256}) from ${manifest.commit} for ${SUPPORTED_BASELINE}`,
    );
  } catch (error) {
    console.error(`release-linux: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
