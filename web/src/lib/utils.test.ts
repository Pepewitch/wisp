import { describe, expect, it } from "vitest"

import { NOTE_CAP, oneLine } from "./utils"

/**
 * The pane's own ceiling on daemon text. The reported bug (D1) was ~40 lines of
 * `git diff` usage rendered verbatim in the Changes pane; the daemon now sends
 * one line, and this is why it stays one line even if some future daemon does
 * not.
 */
describe("oneLine", () => {
  it("keeps a normal sentence exactly as written", () => {
    const reason = "Git no longer tracks this worktree (/tmp/wt) — archive this task to clear the row."
    expect(oneLine(reason)).toBe(reason)
  })

  it("takes the first NON-EMPTY line and drops everything after it", () => {
    const gitUsage = [
      "",
      "warning: Not a git repository. Use --no-index to compare two paths outside a working tree",
      "usage: git diff [<options>] [<commit>] [--] [<path>...]",
      "    -p, --patch           generate patch",
      "    --stat[=<width>[,<name-width>[,<count>]]]",
    ].join("\n")
    expect(oneLine(gitUsage)).toBe(
      "warning: Not a git repository. Use --no-index to compare two paths outside a working tree",
    )
  })

  it("caps a single very long line with an ellipsis", () => {
    const capped = oneLine("x".repeat(NOTE_CAP + 200))
    expect(capped).toHaveLength(NOTE_CAP + 1)
    expect(capped.endsWith("…")).toBe(true)
  })

  it("answers with an empty string for whitespace, never undefined", () => {
    expect(oneLine("\n \n\t\n")).toBe("")
  })
})
