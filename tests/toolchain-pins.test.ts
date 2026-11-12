import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  checkRunningBun,
  checkToolchainPins,
  pinnedBun,
  readToolchainSites,
  TOOLCHAIN_SOURCE,
} from "../scripts/toolchain-pins";

const ROOT = resolve(import.meta.dir, "..");

/** A throwaway tree holding only the files the pin table reads. */
function scratchTree(bun = "1.4.4"): string {
  const root = mkdtempSync(join(tmpdir(), "wisp-toolchain-pins-"));
  writeFileSync(join(root, "package.json"), `{\n  "packageManager": "bun@${bun}"\n}\n`);
  for (const dir of ["wispd", "web"]) {
    mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, dir, "package.json"), `{\n  "packageManager": "bun@${bun}"\n}\n`);
  }
  writeFileSync(join(root, "CONTRIBUTING.md"), `Install Git and **Bun ${bun}**, then run these commands.\n`);
  mkdirSync(join(root, ".github", "workflows"), { recursive: true });
  writeFileSync(join(root, ".github", "workflows", "ci.yml"), `jobs:\n  a:\n    steps:\n      - with:\n          bun-version: ${bun}\n`);
  return root;
}

function scratch<T>(body: (root: string) => T, bun?: string): T {
  const root = scratchTree(bun);
  try {
    return body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("bun pin sites", () => {
  test("the working tree already agrees with the source of truth", () => {
    const result = checkToolchainPins(ROOT);
    expect(result.version).toBe(pinnedBun(ROOT));
    // Workflows repeat the pin per job, so occurrences outnumber sites.
    expect(result.values).toBeGreaterThan(result.sites);
  });

  test("every workflow that installs bun is a site, and the manifests and CONTRIBUTING.md are too", () => {
    const files = readToolchainSites(ROOT).map((reading) => reading.file);
    expect(files).toContain(TOOLCHAIN_SOURCE);
    expect(files).toContain("wispd/package.json");
    expect(files).toContain("web/package.json");
    expect(files).toContain("CONTRIBUTING.md");
    expect(files.some((file) => file.includes("ci.yml"))).toBe(true);
    // Discovered, not listed: the release workflow is covered without this
    // test or the table naming it.
    expect(files.some((file) => file.includes("release.yml"))).toBe(true);
  });

  test("a disagreeing pin names the file and both versions", () => {
    scratch((root) => {
      const workflow = join(root, ".github", "workflows", "ci.yml");
      writeFileSync(workflow, readFileSync(workflow, "utf8").replace("1.4.4", "1.4.2"));
      expect(() => checkToolchainPins(root)).toThrow(/ci\.yml/);
      expect(() => checkToolchainPins(root)).toThrow(/1\.4\.2/);
      expect(() => checkToolchainPins(root)).toThrow(/package\.json \(1\.4\.4\)/);
    });
  });

  test("a renamed pin line fails rather than silently checking nothing", () => {
    scratch((root) => {
      const contributing = join(root, "CONTRIBUTING.md");
      writeFileSync(contributing, "Install Git and Bun 1.4.4 (no emphasis), then run these commands.\n");
      expect(() => checkToolchainPins(root)).toThrow(/no bun pin found in CONTRIBUTING\.md/);
    });
  });

  test("a workflow that installs no bun is not a site", () => {
    scratch((root) => {
      writeFileSync(join(root, ".github", "workflows", "docs.yml"), "jobs:\n  a:\n    steps:\n      - run: echo hi\n");
      expect(() => checkToolchainPins(root)).not.toThrow();
      expect(readToolchainSites(root).map((r) => r.file)).not.toContain(join(".github", "workflows", "docs.yml"));
    });
  });

  test("two packageManager pins in the source is a drifted file, not a pin", () => {
    scratch((root) => {
      writeFileSync(
        join(root, "package.json"),
        `{\n  "packageManager": "bun@1.4.4",\n  "other": { "packageManager": "bun@1.4.4" }\n}\n`,
      );
      expect(() => pinnedBun(root)).toThrow(/exactly one packageManager bun pin, found 2/);
    });
  });
});

describe("the release gate's running-bun check", () => {
  test("the pinned version passes", () => {
    scratch((root) => {
      expect(() => checkRunningBun(root, "1.4.4")).not.toThrow();
    });
  });

  test("a patch difference is refused, and the message names the fix", () => {
    scratch((root) => {
      expect(() => checkRunningBun(root, "1.4.2")).toThrow(/this Bun is 1\.4\.2, the repository pins 1\.4\.4/);
      expect(() => checkRunningBun(root, "1.4.2")).toThrow(/bun upgrade --to 1\.4\.4/);
      // The other direction is a real choice, so the message offers it rather
      // than only telling the operator to go backwards.
      expect(() => checkRunningBun(root, "1.4.6")).toThrow(/bump the pin in its own change first/);
    });
  });

  test("it reads the real repository's pin by default", () => {
    // Bun.version is this process's, so on a correctly pinned checkout the
    // default call is the one `release:check` makes.
    expect(() => checkRunningBun(ROOT, pinnedBun(ROOT))).not.toThrow();
  });
});
