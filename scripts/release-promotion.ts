import { resolve } from "node:path";
import type { DesktopReleaseManifest } from "./release-desktop";
import type { ReleaseManifest } from "./release-linux";
import type { MacReleaseManifest } from "./release-macos";
import { renderDesktopUpdateChannel } from "./render-desktop-update-channel";
import { renderHomebrewCask } from "./render-homebrew-cask";
import { renderHomebrewFormula } from "./render-homebrew-formula";

const AUDIT_TAP = "Pepewitch/tap";
const RELEASE_TAG = /^v(\d+)\.(\d+)\.(\d+)-(alpha\.\d+)$/;

export const TAP_FILES = [
  "Casks/wisp-desktop.rb",
  "Formula/wisp.rb",
  "updates/wisp-desktop-alpha.json",
] as const;

export interface ReleaseMetadata {
  tagName: string;
  isDraft: boolean;
  isPrerelease: boolean;
  assets: Array<{ name: string }>;
}

export interface PromotionManifests {
  linux: ReleaseManifest;
  macos: MacReleaseManifest;
  desktop: DesktopReleaseManifest;
}

export interface PromotionArgs {
  tag: string;
  tapDir: string;
  releaseRoot?: string;
  publish: boolean;
  receipt?: string;
}

export function releaseVersion(tag: string): string {
  const match = tag.match(RELEASE_TAG);
  if (!match) throw new Error(`release tag must match v<semver>-alpha.<number>, got ${JSON.stringify(tag)}`);
  return tag.slice(1);
}

export function releaseNotesPath(root: string, tag: string): string {
  const match = tag.match(RELEASE_TAG);
  if (!match) releaseVersion(tag);
  return resolve(root, `docs/v${match![1]}.${match![2]}/RELEASE-NOTES-${match![4]}.md`);
}

export function expectedReleaseAssets(version: string): string[] {
  return [
    "SHA256SUMS",
    "SHA256SUMS-darwin-arm64",
    "SHA256SUMS-desktop-darwin-arm64",
    "release-manifest-darwin-arm64.json",
    "release-manifest-desktop-darwin-arm64.json",
    "release-manifest.json",
    `wisp-desktop-v${version}-darwin-arm64.tar.gz`,
    `wisp-desktop-v${version}-darwin-arm64.tar.gz.sig`,
    `wisp-v${version}-darwin-arm64.tar.gz`,
    `wisp-v${version}-linux-x86_64`,
  ].sort();
}

export function validateReleaseMetadata(metadata: ReleaseMetadata, tag: string): void {
  const version = releaseVersion(tag);
  if (metadata.tagName !== tag || metadata.isDraft || !metadata.isPrerelease) {
    throw new Error("public release must be the exact non-draft prerelease requested for promotion");
  }
  const expected = expectedReleaseAssets(version);
  const actual = metadata.assets.map((asset) => asset.name).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`public release asset inventory mismatch: ${JSON.stringify(actual)}`);
  }
}

export function renderTapFiles(
  manifests: PromotionManifests,
  notes: string,
  tag: string,
  releaseCommit: string,
): Record<(typeof TAP_FILES)[number], string> {
  const version = releaseVersion(tag);
  for (const [name, manifest] of Object.entries(manifests)) {
    if (manifest.version !== version || manifest.commit !== releaseCommit || manifest.dirty !== false) {
      throw new Error(`${name} manifest does not match release ${tag} at ${releaseCommit}`);
    }
  }
  if (
    manifests.linux.schemaVersion !== 1 ||
    manifests.linux.product !== "wisp" ||
    manifests.linux.target.os !== "linux" ||
    manifests.linux.target.arch !== "x86_64" ||
    manifests.linux.target.libc !== "glibc" ||
    manifests.linux.artifact.file !== `wisp-v${version}-linux-x86_64`
  ) {
    throw new Error("Linux manifest is not the approved release target");
  }
  return {
    "Casks/wisp-desktop.rb": renderHomebrewCask(manifests.desktop),
    "Formula/wisp.rb": renderHomebrewFormula(manifests.macos),
    "updates/wisp-desktop-alpha.json": renderDesktopUpdateChannel(manifests.desktop, notes),
  };
}

export function changedTapFiles(porcelain: string): string[] {
  return porcelain
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.slice(3))
    .sort();
}

export function classifyTapState(paths: string[]): "prepared" | "already-promoted" {
  if (paths.length === 0) return "already-promoted";
  const expected = [...TAP_FILES].sort();
  if (JSON.stringify([...paths].sort()) !== JSON.stringify(expected)) {
    throw new Error(`promotion changed files outside the three-file tap contract: ${JSON.stringify(paths)}`);
  }
  return "prepared";
}

export function assertDisposableAuditHost(
  installedFormula: string,
  installedCask: string,
  registeredTaps: string,
): void {
  const installed = [installedFormula.trim() && "wisp Formula", installedCask.trim() && "wisp-desktop Cask"].filter(
    Boolean,
  );
  if (installed.length > 0) {
    throw new Error(
      `release promotion requires a disposable Homebrew host; refusing to audit beside installed ${installed.join(" and ")}`,
    );
  }
  if (registeredTaps.split(/\r?\n/).includes(AUDIT_TAP.toLowerCase())) {
    throw new Error(`release promotion requires an unregistered ${AUDIT_TAP} audit tap on a disposable host`);
  }
}

export function parsePromotionArgs(args: string[]): PromotionArgs {
  let tag: string | undefined;
  let tapDir: string | undefined;
  let releaseRoot: string | undefined;
  let receipt: string | undefined;
  let publish = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--publish") {
      publish = true;
      continue;
    }
    const value = args[index + 1];
    if (!value) throw new Error(`missing value for ${arg}`);
    if (arg === "--tag") tag = value;
    else if (arg === "--tap-dir") tapDir = value;
    else if (arg === "--release-root") releaseRoot = value;
    else if (arg === "--receipt") receipt = value;
    else throw new Error(`unknown argument: ${arg}`);
    index++;
  }
  if (!tag || !tapDir) {
    throw new Error(
      "usage: promote-release.ts --tag <v0.0.0-alpha.N> --tap-dir <homebrew-tap> [--release-root <tag-checkout>] [--publish] [--receipt <path>]",
    );
  }
  releaseVersion(tag);
  return {
    tag,
    tapDir: resolve(tapDir),
    releaseRoot: releaseRoot ? resolve(releaseRoot) : undefined,
    publish,
    receipt: receipt ? resolve(receipt) : undefined,
  };
}
