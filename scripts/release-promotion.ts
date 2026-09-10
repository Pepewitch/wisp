import { resolve } from "node:path";
import type { DesktopReleaseManifest } from "./release-desktop";
import type { ReleaseManifest } from "../wispd/scripts/release-linux";
import type { MacReleaseManifest } from "../wispd/scripts/release-macos";
import { renderDaemonUpdateChannel } from "./render-daemon-update-channel";
import { renderDesktopUpdateChannel } from "./render-desktop-update-channel";
import { renderHomebrewCask } from "./render-homebrew-cask";
import { renderHomebrewFormula } from "./render-homebrew-formula";

const AUDIT_TAP = "Pepewitch/tap";
const RELEASE_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(alpha\.(?:0|[1-9]\d*)))?$/;

export const TAP_FILES = [
  "Casks/wisp-desktop.rb",
  "Formula/wisp.rb",
  "updates/wisp-daemon.json",
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
  if (!match) throw new Error(`release tag must match v<semver> or v<semver>-alpha.<number>, got ${JSON.stringify(tag)}`);
  return tag.slice(1);
}

export function releaseNotesPath(root: string, tag: string): string {
  const match = tag.match(RELEASE_TAG);
  if (!match) releaseVersion(tag);
  return resolve(root, `docs/v${match![1]}.${match![2]}/RELEASE-NOTES-${match![4] ?? releaseVersion(tag)}.md`);
}

// Reading order for humans: each platform's payload, then its manifest, then
// its checksums. expectedReleaseAssets() sorts instead, because it is compared
// against a sorted GitHub inventory; using that order in the release notes put
// SHA256SUMS above the binaries it describes.
export function releaseAssetsInReadingOrder(version: string): string[] {
  const ordered = [
    `wisp-v${version}-linux-x86_64`,
    "release-manifest.json",
    "SHA256SUMS",
    `wisp-v${version}-darwin-arm64.tar.gz`,
    "release-manifest-darwin-arm64.json",
    "SHA256SUMS-darwin-arm64",
    `wisp-desktop-v${version}-darwin-arm64.tar.gz`,
    `wisp-desktop-v${version}-darwin-arm64.tar.gz.sig`,
    "release-manifest-desktop-darwin-arm64.json",
    "SHA256SUMS-desktop-darwin-arm64",
  ];
  // The two lists must describe the same release, or the notes would advertise
  // assets the promotion gate does not require.
  const expected = expectedReleaseAssets(version);
  if (JSON.stringify([...ordered].sort()) !== JSON.stringify(expected)) {
    throw new Error("the reading order and the expected asset inventory disagree");
  }
  return ordered;
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
  if (metadata.tagName !== tag || metadata.isDraft || metadata.isPrerelease !== version.includes("-")) {
    throw new Error("public release must be the exact non-draft release with the tag-matching prerelease status");
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
    "updates/wisp-daemon.json": renderDaemonUpdateChannel(
      manifests.linux,
      manifests.desktop.publishedAt,
    ),
    "updates/wisp-desktop-alpha.json": renderDesktopUpdateChannel(manifests.desktop, notes),
  };
}

export function changedTapFiles(porcelain: string): string[] {
  return porcelain
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      // Porcelain v1 normally starts with two status columns and a space.
      // The shared command wrapper trims its complete stdout, however, so an
      // unstaged first entry can arrive with its leading status-space removed.
      if (/^[ MTADRCU?!]{2} /.test(line)) return line.slice(3);
      if (/^[MTADRCU?!] /.test(line)) return line.slice(2);
      throw new Error(`invalid git status --porcelain=v1 entry: ${JSON.stringify(line)}`);
    })
    .sort();
}

export function classifyTapState(paths: string[]): "prepared" | "already-promoted" {
  if (paths.length === 0) return "already-promoted";
  const expected = [...TAP_FILES].sort();
  if (JSON.stringify([...paths].sort()) !== JSON.stringify(expected)) {
    throw new Error(`promotion changed files outside the tap contract: ${JSON.stringify(paths)}`);
  }
  return "prepared";
}

// The dry run replays whichever release the tap currently serves, so the
// fixture is derived rather than pinned. A pinned tag silently stops agreeing
// with the tap the moment a later release is promoted, which turns the strong
// reproducibility assertion into an unexplained red build.
export function promotionFixtureTag(desktopChannel: string): string {
  let version: unknown;
  try {
    ({ version } = JSON.parse(desktopChannel) as { version?: unknown });
  } catch (error) {
    throw new Error(
      `tap desktop channel is not readable JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (typeof version !== "string" || version.length === 0) {
    throw new Error("tap desktop channel does not record the promoted version");
  }
  const tag = `v${version}`;
  releaseVersion(tag);
  return tag;
}

// A contract file the tap has never served cannot be reproduced from a public
// release, so the dry run has nothing to replay it against. That state means a
// channel clients are told to poll is still unpublished, so it fails loudly
// here instead of reaching users as a 404.
export function unpublishedTapFiles(presentTapFiles: string[]): string[] {
  const present = new Set(presentTapFiles);
  return TAP_FILES.filter((file) => !present.has(file));
}

export function assertPromotableFixture(tag: string, presentTapFiles: string[]): void {
  const unpublished = unpublishedTapFiles(presentTapFiles);
  if (unpublished.length > 0) {
    throw new Error(
      `tap serving ${tag} does not publish ${JSON.stringify(unpublished)} yet; promote a release with the ` +
        "current tap contract before the dry run can replay it",
    );
  }
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
      "usage: promote-release.ts --tag <v0.0.0[-alpha.N]> --tap-dir <homebrew-tap> [--release-root <tag-checkout>] [--publish] [--receipt <path>]",
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
