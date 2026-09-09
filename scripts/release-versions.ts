// The release version lives in wispd/package.json. Every other place that
// repeats it is listed here once, and both the check and the writer work from
// this one table.
//
// This table exists because the alternative — a prose list of files an operator
// edits by hand — drifts. Each site declares how many times its pattern must
// match, so a renamed key or a deleted line fails the gate instead of silently
// checking nothing.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { releaseVersion } from "./release-promotion";

export const SOURCE_SITE = "wispd/package.json";

export interface VersionMatcher {
  /** Every capture group of every match must hold the release version. */
  pattern: RegExp;
  /** Exact number of matches required; a different count fails the gate. */
  count: number;
}

export interface VersionSite {
  file: string;
  why: string;
  matchers: VersionMatcher[];
}

// Keep `pattern` anchored enough that it cannot drift onto an unrelated
// version: Cargo.lock holds seven third-party crates at some of these numbers.
export const VERSION_SITES: readonly VersionSite[] = [
  {
    file: SOURCE_SITE,
    why: "the release identity every other site is derived from",
    matchers: [{ pattern: /"version": "([^"]+)"/g, count: 1 }],
  },
  {
    file: "wispd/src/version.ts",
    why: "the constant compiled into the daemon and reported by `wisp version`",
    matchers: [{ pattern: /export const VERSION = "([^"]+)";/g, count: 1 }],
  },
  {
    file: "desktop/src-tauri/Cargo.toml",
    why: "the Desktop crate version Tauri packages",
    matchers: [{ pattern: /name = "wisp-desktop"\nversion = "([^"]+)"/g, count: 1 }],
  },
  {
    file: "desktop/src-tauri/Cargo.lock",
    why: "the locked Desktop crate version; --locked rejects a mismatch",
    matchers: [{ pattern: /name = "wisp-desktop"\nversion = "([^"]+)"/g, count: 1 }],
  },
  {
    file: "desktop/src-tauri/tauri.conf.json",
    why: "the version in the built app bundle and its updater metadata",
    matchers: [{ pattern: /"version": "([^"]+)"/g, count: 1 }],
  },
  {
    file: "scripts/install.sh",
    why: "the version the public Linux installer downloads by default",
    matchers: [
      { pattern: /VERSION="\$\{WISP_VERSION:-([^}]+)\}"/g, count: 1 },
      { pattern: /release version \(default: ([^)]+)\)/g, count: 1 },
    ],
  },
  {
    file: "wispd/scripts/test-install.sh",
    why: "the release artifact the installer contract test defaults to",
    matchers: [{ pattern: /dist\/release\/v([^/]+)\/wisp-v([^-]+)-linux-x86_64/g, count: 1 }],
  },
  {
    file: "wispd/scripts/test-activation.sh",
    why: "the release artifact the activation contract test defaults to",
    matchers: [{ pattern: /dist\/release\/v([^/]+)\/wisp-v([^-]+)-linux-x86_64/g, count: 1 }],
  },
  {
    file: "wispd/scripts/evaluator/run.sh",
    why: "the release artifact the evaluator harness runs against",
    matchers: [{ pattern: /^VERSION="([^"]+)"$/gm, count: 1 }],
  },
] as const;

// Pinned so that deleting a site is a failure rather than a smaller check.
export const EXPECTED_SITE_COUNT = 9;

export interface SiteReading {
  file: string;
  versions: string[];
}

function matchAll(contents: string, matcher: VersionMatcher, file: string): string[] {
  const found: string[] = [];
  let matches = 0;
  for (const match of contents.matchAll(matcher.pattern)) {
    matches++;
    const groups = match.slice(1);
    if (groups.length === 0) throw new Error(`${file}: matcher captures no version group`);
    for (const group of groups) found.push(group);
  }
  if (matches !== matcher.count) {
    throw new Error(
      `${file}: expected ${matcher.count} match(es) of ${matcher.pattern.source}, found ${matches}; ` +
        "the file changed shape, so scripts/release-versions.ts must be updated with it",
    );
  }
  return found;
}

/** Reads each site from disk without consulting the writer or the source. */
export function readVersionSites(root: string): SiteReading[] {
  if (VERSION_SITES.length !== EXPECTED_SITE_COUNT) {
    throw new Error(
      `expected ${EXPECTED_SITE_COUNT} version sites, found ${VERSION_SITES.length}; ` +
        "update EXPECTED_SITE_COUNT deliberately when the release surface changes",
    );
  }
  return VERSION_SITES.map((site) => {
    const contents = readFileSync(join(root, site.file), "utf8");
    return {
      file: site.file,
      versions: site.matchers.flatMap((matcher) => matchAll(contents, matcher, site.file)),
    };
  });
}

export function sourceVersion(root: string): string {
  const { version } = JSON.parse(readFileSync(join(root, SOURCE_SITE), "utf8")) as { version?: unknown };
  if (typeof version !== "string") {
    throw new Error(`${SOURCE_SITE} does not carry a release version: ${JSON.stringify(version)}`);
  }
  assertTaggableVersion(version);
  return version;
}

// The pipeline can only tag v<semver> or v<semver>-alpha.N, so refuse anything
// else here rather than at `git tag`, after nine files have been rewritten.
export function assertTaggableVersion(version: string): void {
  try {
    releaseVersion(`v${version}`);
  } catch {
    throw new Error(
      `not a release version: ${JSON.stringify(version)}; expected <major>.<minor>.<patch> or ` +
        "<major>.<minor>.<patch>-alpha.<number>",
    );
  }
}

export interface VersionCheck {
  version: string;
  sites: number;
  values: number;
}

/** Throws unless every site already agrees with wispd/package.json. */
export function checkVersionSites(root: string): VersionCheck {
  const version = sourceVersion(root);
  const readings = readVersionSites(root);
  const disagreeing = readings.filter((reading) => reading.versions.some((value) => value !== version));
  if (disagreeing.length > 0) {
    const detail = disagreeing
      .map((reading) => `${reading.file} -> ${JSON.stringify([...new Set(reading.versions)])}`)
      .join("; ");
    throw new Error(
      `release version sites disagree with ${SOURCE_SITE} (${version}): ${detail}. ` +
        "Run `bun run version:set <version>` rather than editing them by hand.",
    );
  }
  return {
    version,
    sites: readings.length,
    values: readings.reduce((total, reading) => total + reading.versions.length, 0),
  };
}

/** Rewrites every site to `next`, returning the files whose bytes changed. */
export function writeVersionSites(root: string, next: string): string[] {
  assertTaggableVersion(next);
  const changed: string[] = [];
  for (const site of VERSION_SITES) {
    const path = join(root, site.file);
    const before = readFileSync(path, "utf8");
    let after = before;
    for (const matcher of site.matchers) {
      // Validate shape before writing, so a drifted file is never rewritten.
      matchAll(before, matcher, site.file);
      after = after.replace(matcher.pattern, (match, ...rest) => {
        const groups = rest.slice(0, rest.length - 2).filter((value) => typeof value === "string") as string[];
        let replaced = match;
        for (const group of groups) replaced = replaced.split(group).join(next);
        return replaced;
      });
    }
    if (after !== before) {
      writeFileSync(path, after);
      changed.push(site.file);
    }
  }
  return changed;
}
