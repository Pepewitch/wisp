import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { collectEntries, notesSummary, notesVersion, publications, renderChangelog } from "../scripts/changelog";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "wisp-changelog-"));
  roots.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const notes = (version: string, summary: string) => `# Wisp ${version}\n\n${summary}\n- **A change.** Detail.\n\n## What changed\n`;
const published = (version: string, date: string) => `## ${version} publication\n\n**Published and promoted on ${date}.**\nMore.\n`;

describe("changelog", () => {
  test("reads the version and the opening paragraph a person wrote", () => {
    const source = "# Wisp 0.6.5\n\nWisp 0.6.5 is a reliability\nrelease.\n- **Bullet.** Not part of it.\n";
    expect(notesVersion(source)).toBe("0.6.5");
    expect(notesSummary(source)).toBe("Wisp 0.6.5 is a reliability release.");
    expect(notesVersion("# Something else\n")).toBeNull();
  });

  test("reads publication dates from a ledger", () => {
    const dates = publications(`${published("0.6.5", "2026-09-29")}\n## 0.6.4 publication\n\nNo date line.\n`);
    expect(dates.get("0.6.5")).toBe("2026-09-29");
    expect(dates.has("0.6.4")).toBe(true);
    expect(dates.get("0.6.4")).toBeNull();
  });

  test("lists published releases newest first, and leaves out one still being prepared", () => {
    const root = fixture({
      "docs/v0.6/RELEASE-NOTES-0.6.9.md": notes("0.6.9", "Wisp 0.6.9 is still being prepared."),
      "docs/v0.6/RELEASE-NOTES-0.6.10.md": notes("0.6.10", "Wisp 0.6.10 is not out yet."),
      "docs/v0.6/RELEASE-NOTES-0.6.2.md": notes("0.6.2", "Wisp 0.6.2 shipped without a ledger entry."),
      "docs/v0.6/RELEASE-NOTES-0.6.8.md": notes("0.6.8", "Wisp 0.6.8 is out."),
      "docs/v0.6/QUALIFICATION.md": published("0.6.8", "2026-10-02"),
      "docs/v0.4/RELEASE-NOTES-alpha.9.md": notes("0.4.0-alpha.9", "A candidate that never shipped."),
    });
    const text = renderChangelog(collectEntries(root));
    expect(text).toContain("## 0.6.8 (2026-10-02)\n\nWisp 0.6.8 is out.\n\n[Release notes](docs/v0.6/RELEASE-NOTES-0.6.8.md)");
    // a regular release older than the newest published one is listed, undated
    expect(text).toContain("## 0.6.2\n\nWisp 0.6.2 shipped without a ledger entry.");
    expect(text.indexOf("## 0.6.8")).toBeLessThan(text.indexOf("## 0.6.2"));
    expect(text).not.toContain("0.6.9");
    expect(text).not.toContain("0.6.10");
    expect(text).not.toContain("alpha.9");
    expect(text).toContain("## Earlier prereleases");
  });

  test("a prerelease the ledger records as published is listed", () => {
    const root = fixture({
      "docs/v0.7/RELEASE-NOTES-0.7.0-alpha.1.md": notes("0.7.0-alpha.1", "The first 0.7 preview."),
      "docs/v0.7/QUALIFICATION.md": published("0.7.0-alpha.1", "2026-11-01"),
    });
    expect(renderChangelog(collectEntries(root))).toContain("## 0.7.0-alpha.1 (2026-11-01)");
  });
});
