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
import { addedMigrations, isInternalChange, migrationIds, parseMergedChanges, renderReleaseNotes } from "../scripts/release-notes";
import { expectedReleaseAssets, releaseAssetsInReadingOrder } from "../scripts/release-promotion";
import { BUILTIN_ADAPTERS } from "../wispd/src/adapters/builtins";

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

  test("refuses a stale pinned install URL in the front-page README", () =>
    scratch((root) => {
      // The README and install-guide URLs were a prose step before they were
      // sites: the one bump a prep PR could forget without any gate noticing.
      const path = join(root, "README.md");
      const version = sourceVersion(root);
      writeFileSync(path, readFileSync(path, "utf8").replace(`/wisp/v${version}/scripts`, "/wisp/v0.0.1/scripts"));
      expect(() => checkVersionSites(root)).toThrow("README.md");
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
      { subject: "fix: something real", pull: "110", internal: false },
      { subject: "Add a feature", pull: "111", internal: false },
      { subject: "chore: no pull request", pull: null, internal: false },
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

describe("release notes derivation", () => {
  test("derives which migrations a release adds", () => {
    const before = "    id: 5,\n    id: 6,\n";
    const after = "    id: 5,\n    id: 6,\n    id: 7,\n";
    expect(migrationIds(before)).toEqual([5, 6]);
    expect(addedMigrations(before, after)).toEqual([7]);
    expect(addedMigrations(after, after)).toEqual([]);
    // Ids are appended, never renumbered, so two in one release is possible.
    expect(addedMigrations(before, after + "    id: 8,\n")).toEqual([7, 8]);
    expect(migrationIds("no migrations here")).toEqual([]);
  });

  test("states the migration consequence, or says there is none", () => {
    const withMigration = renderReleaseNotes("0.6.0", "v0.5.9", [], [7]);
    expect(withMigration).toContain("adds database migration 7");
    // The warning only matters if it names which older daemon is locked out.
    expect(withMigration).toContain("a 0.5.9 daemon cannot reopen a profile that 0.6.0 has opened");
    expect(renderReleaseNotes("0.6.0", "v0.5.9", [], [])).toContain("adds no database migration");
    expect(renderReleaseNotes("0.6.0", "v0.5.9", [], [])).not.toContain("TODO state any database");
  });

  test("flags a change users cannot observe, without deciding for the author", () => {
    expect(isInternalChange(["docs/INSTALL.md", "skills/wisp/SKILL.md"])).toBe(true);
    expect(isInternalChange([".github/workflows/ci.yml", "tests/a.test.ts"])).toBe(true);
    expect(isInternalChange(["wispd/src/daemon.ts"])).toBe(false);
    expect(isInternalChange(["docs/INSTALL.md", "wispd/src/daemon.ts"])).toBe(false);
    // Unknown paths must not be guessed as internal.
    expect(isInternalChange([])).toBe(false);

    const changes = parseMergedChanges("docs: only docs (#1)\nfeat: real thing (#2)", (subject) =>
      subject.startsWith("docs:") ? ["docs/x.md"] : ["wispd/src/y.ts"],
    );
    expect(changes[0]).toMatchObject({ pull: "1", internal: true });
    expect(changes[1]).toMatchObject({ pull: "2", internal: false });
    const notes = renderReleaseNotes("0.6.0", "v0.5.9", changes);
    expect(notes).toContain("probably internal");
    expect(notes).toContain("TODO describe for users: feat: real thing (#2)");
  });

  test("lists assets in reading order while still matching the promotion inventory", () => {
    const ordered = releaseAssetsInReadingOrder("0.6.0");
    expect(ordered[0]).toBe("wisp-v0.6.0-linux-x86_64");
    expect(ordered).toHaveLength(10);
    // Same release, different order: the gate compares sorted, humans read grouped.
    expect([...ordered].sort()).toEqual(expectedReleaseAssets("0.6.0"));
    expect(renderReleaseNotes("0.6.0", "v0.5.9", []).indexOf("wisp-v0.6.0-linux-x86_64")).toBeLessThan(
      renderReleaseNotes("0.6.0", "v0.5.9", []).indexOf("SHA256SUMS-desktop-darwin-arm64"),
    );
  });
});

describe("public claims stay true as the product grows", () => {
  test("README names every built-in harness", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8").toLowerCase();
    const builtins = Object.keys(BUILTIN_ADAPTERS);
    expect(builtins.length).toBeGreaterThan(1);
    // opencode shipped as a fifth harness while README still advertised four.
    // A harness users can run but never see mentioned is a false public claim.
    const missing = builtins.filter((harness) => !readme.includes(harness));
    expect(missing).toEqual([]);
  });
});
