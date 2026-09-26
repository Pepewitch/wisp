import { describe, expect, test } from "bun:test";
import { isReleaseDocument, todoLines } from "../scripts/check-release-docs";

describe("todoLines", () => {
  test("reports 1-based lines that carry a TODO marker", () => {
    expect(todoLines("fine\nTODO finish this\n- TODO: also this\nTODOS are not markers\ntodo is lowercase\n")).toEqual([
      { line: 2, text: "TODO finish this" },
      { line: 3, text: "- TODO: also this" },
    ]);
  });
});

describe("isReleaseDocument", () => {
  test("matches release notes and qualification ledgers only", () => {
    expect(isReleaseDocument("docs/v0.6/RELEASE-NOTES-0.6.2.md")).toBe(true);
    expect(isReleaseDocument("docs/v0.6/RELEASE-NOTES-alpha.17.md")).toBe(true);
    expect(isReleaseDocument("docs/v0.6/QUALIFICATION.md")).toBe(true);
    expect(isReleaseDocument("docs/v0.6/OTHER.md")).toBe(false);
    expect(isReleaseDocument("docs/INSTALL.md")).toBe(false);
    expect(isReleaseDocument("README.md")).toBe(false);
  });
});
