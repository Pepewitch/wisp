import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findBrokenMarkdownLinks } from "../scripts/check-doc-links";

const workspaces: string[] = [];

afterEach(() => {
  for (const workspace of workspaces.splice(0)) {
    rmSync(workspace, { force: true, recursive: true });
  }
});

describe("documentation link checker", () => {
  test("accepts valid files and anchors while reporting missing and outside targets", () => {
    const workspace = mkdtempSync(join(tmpdir(), "wisp-doc-links-"));
    workspaces.push(workspace);
    const root = join(workspace, "repo");
    mkdirSync(root);
    writeFileSync(join(workspace, "outside.md"), "# Outside\n");
    writeFileSync(join(root, "target.md"), "# Target\n\n## Section name\n\n## Section name\n");
    writeFileSync(
      join(root, "README.md"),
      [
        "[file](target.md)",
        "[heading](target.md#section-name-1)",
        "[same document](#links)",
        "[external](https://example.com/missing.md)",
        "[missing file](missing.md)",
        "[missing heading](target.md#absent)",
        "[outside](../outside.md)",
        "",
        "## Links",
      ].join("\n"),
    );
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    execFileSync("git", ["add", "README.md", "target.md"], { cwd: root });

    expect(findBrokenMarkdownLinks(root)).toEqual([
      {
        destination: "missing.md",
        file: "README.md",
        line: 5,
        reason: "target does not exist",
      },
      {
        destination: "target.md#absent",
        file: "README.md",
        line: 6,
        reason: "heading anchor does not exist",
      },
      {
        destination: "../outside.md",
        file: "README.md",
        line: 7,
        reason: "target is outside the repository",
      },
    ]);
  });
});
