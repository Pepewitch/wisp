import { describe, expect, it } from "vitest"

import { resolveAgainst, worktreeFilePath } from "./worktree-files"

describe("worktreeFilePath", () => {
  it("keeps the plain paths an agent actually writes", () => {
    expect(worktreeFilePath(".context/PLAN.md")).toBe(".context/PLAN.md")
    expect(worktreeFilePath("docs/ARCHITECTURE.md")).toBe("docs/ARCHITECTURE.md")
    expect(worktreeFilePath("README")).toBe("README")
    expect(worktreeFilePath("  src/a.ts  ")).toBe("src/a.ts")
    // absolute is still a path; whether it is inside the worktree is the daemon's answer
    expect(worktreeFilePath("/Users/x/w/PLAN.md")).toBe("/Users/x/w/PLAN.md")
  })

  it("drops the fragment and query a markdown link may carry", () => {
    expect(worktreeFilePath("docs/PLAN.md#step-two")).toBe("docs/PLAN.md")
    expect(worktreeFilePath("docs/PLAN.md?raw=1")).toBe("docs/PLAN.md")
  })

  /** A web address belongs to the browser; every other scheme to a program we are not. */
  it("is not a web address, an in-document anchor, or any other scheme", () => {
    for (const href of [
      "https://example.test/pull/1",
      "http://example.test/",
      "//example.test/x",
      "#section-two",
      "mailto:someone@example.test",
      "vscode://file/x",
      "javascript:alert(1)",
      "file:///etc/passwd",
      "",
      "   ",
      null,
      undefined,
    ]) {
      expect(worktreeFilePath(href)).toBeNull()
    }
  })
})

describe("resolveAgainst", () => {
  it("reads a document's own relative link as next to it, not at the worktree root", () => {
    expect(resolveAgainst(".context/PLAN.md", "NOTES.md")).toBe(".context/NOTES.md")
    expect(resolveAgainst("docs/a/b.md", "c.md")).toBe("docs/a/c.md")
    // a file at the root has no directory to resolve against
    expect(resolveAgainst("PLAN.md", "NOTES.md")).toBe("NOTES.md")
  })

  /** The daemon resolves and refuses; doing the arithmetic twice is how the copies disagree. */
  it("hands `..` and absolute paths through untouched", () => {
    expect(resolveAgainst("docs/a/b.md", "../top.md")).toBe("docs/a/../top.md")
    expect(resolveAgainst("docs/a/b.md", "/etc/passwd")).toBe("/etc/passwd")
  })
})
