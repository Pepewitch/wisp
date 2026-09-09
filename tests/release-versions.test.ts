import { describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  checkVersionSites,
  EXPECTED_SITE_COUNT,
  readVersionSites,
  SOURCE_SITE,
  sourceVersion,
  VERSION_SITES,
  writeVersionSites,
} from "../scripts/release-versions";
import { parseMergedChanges, renderReleaseNotes } from "../scripts/release-notes";

const ROOT = resolve(import.meta.dir, "..");

/** A throwaway copy of just the files the version table touches. */
function scratchTree(): string {
  const root = mkdtempSync(join(tmpdir(), "wisp-version-sites-"));
  for (const site of VERSION_SITES) {
    const destination = join(root, site.file);
    cpSync(join(ROOT, site.file), destination, { recursive: false, errorOnExist: false, force: true });
  }
  return root;
}

function scratch<T>(body: (root: string) => T): T {
  const root = scratchTree();
  try {
    return body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("release version sites", () => {
  test("the working tree already agrees with the source of truth", () => {
    const result = checkVersionSites(ROOT);
    expect(result.version).toBe(sourceVersion(ROOT));
    expect(result.sites).toBe(EXPECTED_SITE_COUNT);
    // More occurrences than sites, because some files repeat the version.
    expect(result.values).toBeGreaterThan(result.sites);
  });

  test("the table is the only enumeration, and its size is pinned", () => {
    expect(VERSION_SITES).toHaveLength(EXPECTED_SITE_COUNT);
    expect(new Set(VERSION_SITES.map((site) => site.file)).size).toBe(EXPECTED_SITE_COUNT);
    expect(VERSION_SITES[0]!.file).toBe(SOURCE_SITE);
    // Every site records why it repeats the version, so a future reader does
    // not have to infer whether it still matters.
    for (const site of VERSION_SITES) expect(site.why.length).toBeGreaterThan(10);
  });

  test("refuses a single drifted site", () =>
    scratch((root) => {
      const path = join(root, "wispd/src/version.ts");
      writeFileSync(path, readFileSync(path, "utf8").replace(/VERSION = "[^"]+"/, 'VERSION = "0.0.1"'));
      expect(() => checkVersionSites(root)).toThrow("wispd/src/version.ts");
      expect(() => checkVersionSites(root)).toThrow("disagree");
    }));

  test("refuses a half-updated site", () =>
    scratch((root) => {
      // install.sh repeats the version in its default and its help text; the
      // 0.5.0 release process made exactly this class of mistake possible.
      const path = join(root, "scripts/install.sh");
      const version = sourceVersion(root);
      writeFileSync(
        path,
        readFileSync(path, "utf8").replace(`release version (default: ${version})`, "release version (default: 0.0.1)"),
      );
      expect(() => checkVersionSites(root)).toThrow("scripts/install.sh");
    }));

  test("fails closed when a site changes shape instead of checking nothing", () =>
    scratch((root) => {
      const path = join(root, "wispd/scripts/evaluator/run.sh");
      writeFileSync(path, readFileSync(path, "utf8").replace(/^VERSION="[^"]+"$/m, "# version moved"));
      expect(() => readVersionSites(root)).toThrow("changed shape");
    }));

  test("writes every site and reads back clean, losslessly", () =>
    scratch((root) => {
      const original = sourceVersion(root);
      const before = VERSION_SITES.map((site) => readFileSync(join(root, site.file), "utf8"));

      const changed = writeVersionSites(root, "9.9.9");
      expect(changed).toHaveLength(EXPECTED_SITE_COUNT);
      expect(checkVersionSites(root).version).toBe("9.9.9");

      // Round-tripping restores the exact bytes, so the writer cannot smuggle
      // an unrelated edit into a release commit.
      writeVersionSites(root, original);
      expect(VERSION_SITES.map((site) => readFileSync(join(root, site.file), "utf8"))).toEqual(before);
      expect(writeVersionSites(root, original)).toEqual([]);
    }));

  test("writes only the Wisp crate version, not third-party crates at the same number", () =>
    scratch((root) => {
      const path = join(root, "desktop/src-tauri/Cargo.lock");
      const before = readFileSync(path, "utf8");
      const version = sourceVersion(root);
      const sharedBefore = (before.match(new RegExp(`^version = "${version}"$`, "gm")) ?? []).length;

      writeVersionSites(root, "9.9.9");
      const after = readFileSync(path, "utf8");
      expect((after.match(/^version = "9\.9\.9"$/gm) ?? []).length).toBe(1);
      // Any other crate that happened to sit at the old version is untouched.
      expect((after.match(new RegExp(`^version = "${version}"$`, "gm")) ?? []).length).toBe(sharedBefore - 1);
      expect(after).toContain('name = "wisp-desktop"\nversion = "9.9.9"');
    }));

  test("refuses a version that is not a release version", () =>
    scratch((root) => {
      for (const invalid of ["", "v0.5.2", "0.5", "0.5.2-beta", "latest", "../main"]) {
        expect(() => writeVersionSites(root, invalid)).toThrow("not a release version");
      }
    }));
});

describe("release notes scaffold", () => {
  test("reads pull request numbers out of merged subjects", () => {
    const changes = parseMergedChanges(
      ["fix: something real (#110)", "Add a feature (#111)", "chore: no pull request"].join("\n"),
    );
    expect(changes).toEqual([
      { subject: "fix: something real", pull: "110" },
      { subject: "Add a feature", pull: "111" },
      { subject: "chore: no pull request", pull: null },
    ]);
  });

  test("scaffolds the required sections with the right version everywhere", () => {
    const notes = renderReleaseNotes("0.9.0", "v0.8.3", [{ subject: "fix: a thing", pull: "42" }]);
    expect(notes).toStartWith("# Wisp 0.9.0\n");
    for (const heading of ["## What changed since 0.8.3", "## Install or upgrade", "## Scope and known limits", "## Release assets"]) {
      expect(notes).toContain(heading);
    }
    expect(notes).toContain("fix: a thing (#42)");
    // The ten-asset list and the install commands are generated, so they can
    // never carry a copied-over version number.
    expect(notes).toContain("`wisp-v0.9.0-linux-x86_64`");
    expect(notes).toContain("`wisp-desktop-v0.9.0-darwin-arm64.tar.gz.sig`");
    expect(notes).toContain("/wisp/v0.9.0/scripts/install.sh");
    expect(notes).not.toContain("0.8.3/scripts");
    expect(notes.match(/^- `/gm)).toHaveLength(10);
    // The judgment-bearing prose is marked, not invented.
    expect(notes).toContain("TODO");
  });

  test("still scaffolds when nothing merged since the previous tag", () => {
    const notes = renderReleaseNotes("0.9.0", "v0.9.0-alpha.1", []);
    expect(notes).toContain("TODO no merged changes were found");
  });
});
