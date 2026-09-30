import { describe, expect, it } from "vitest"

import type { AutopilotHistoryEntry } from "../../../shared/autopilot"
import {
  groupHistory,
  historyDetail,
  historyTitle,
  historyTone,
  historyWord,
  logDetail,
  recentHistory,
  repositoryUrl,
  runLabel,
} from "./autopilot-history"

let minute = 1000
/** Newest first, as the route serves them: each call is one minute OLDER than the last. */
const at = () => new Date(Date.UTC(2026, 8, 30, 10) - minute++ * 60_000).toISOString()
const entry = (kind: string, detail: string, pr: number | null, extra: Partial<AutopilotHistoryEntry> = {}): AutopilotHistoryEntry =>
  ({ at: at(), kind, detail, pr, sha: null, messageId: null, ...extra })

describe("the history's words", () => {
  it("scans by an event word and drops what the row says elsewhere", () => {
    expect(historyWord(entry("merged", "Merged #318 into main", 318))).toBe("Merged by Wisp")
    expect(historyWord(entry("merged", "#318 was merged into main", 318))).toBe("Merged")
    expect(historyDetail(entry("merged", "#318 was merged into main", 318))).toBe("into main")
    expect(historyDetail(entry("merging", "Merging #318 at 5d2b8aa into main (squash) · checks green", 318))).toBe("into main (squash) · checks green")
    expect(historyDetail(entry("merge-failed", "Merge of #318 at 5d2b8aa failed: the base branch was modified", 318))).toBe("the base branch was modified")
    expect(historyDetail(entry("rerun", "Rerunning e2e (chromium)", 318))).toBe("e2e (chromium)")
    expect(historyTitle(entry("bound", "Watching PR #318", 318))).toBe("Watching #318")
    expect(historyDetail(entry("bound", "Watching PR #318", 318))).toBeNull()
    expect(logDetail(entry("bound", "Watching PR #318", 318))).toBe("#318")
    expect(historyTitle(entry("wake", "lint failed", 318), 2)).toBe("Fix round 2 sent")
    expect(historyWord(entry("wake", "lint failed", 318), 2)).toBe("Fix round 2")
    // a kind this client has never heard of still reads as words
    expect(historyWord(entry("rate-limited", "GitHub asked us to slow down", 318))).toBe("Rate limited")
  })

  it("carries tone on the dot: violet merges, red trouble, faint routine", () => {
    expect(["merged", "merging", "merge-failed", "paused", "blocked", "wait", "wake", "unknown"].map(historyTone))
      .toEqual(["merge", "merging", "alert", "alert", "alert", "routine", "event", "event"])
  })
})

describe("grouping by PR", () => {
  it("puts what came before a PR in its group, numbers rounds per PR, and folds consecutive waits", () => {
    minute = 1000
    const entries = [
      entry("wait", "Waiting for a PR", null),
      entry("merged", "Merged #318 into main", 318, { sha: "9c41e07" }),
      entry("wait", "Waiting for checks (2 running)", 318),
      entry("wait", "Waiting for checks to start", 318),
      entry("wait", "Waiting for checks (1 running)", 318),
      entry("wake", "Review asks for a null check", 318, { messageId: "m2" }),
      entry("wake", "lint failed", 318, { messageId: "m1" }),
      entry("bound", "Watching PR #318", 318),
      entry("merged", "Merged #305 into main", 305),
      entry("wake", "unit failed", 305),
      entry("bound", "Watching PR #305", 305),
      entry("armed", "Auto-merge on, Auto-fix on", null),
    ]
    const groups = groupHistory(entries)
    expect(groups.map((group) => [group.pr, group.rounds, group.events])).toEqual([[null, 0, 1], [318, 2, 7], [305, 1, 4]])
    const [, pr318, pr305] = groups
    expect(pr318!.items.map((item) => (item.kind === "run" ? `run×${item.entries.length}` : historyWord(item.entry, item.round))))
      .toEqual(["Merged by Wisp", "run×3", "Fix round 2", "Fix round 1", "Watching"])
    // "Switched on" is the first line of the first PR
    expect(pr305!.items.at(-1)).toMatchObject({ kind: "one", entry: { kind: "armed" } })
    const run = pr318!.items[1]!
    expect(run.kind === "run" && runLabel(run.entries)).toBe("for checks")
  })

  it("keeps the three latest meaningful entries, newest first, with their round numbers", () => {
    minute = 1000
    const entries = [
      entry("wait", "Waiting for checks (1 running)", 318),
      entry("wake", "lint failed", 318, { messageId: "m1" }),
      entry("wait", "Waiting for checks (2 running)", 318),
      entry("rerun", "Rerunning e2e", 318),
      entry("judged", "@reviewer's review: needs changes (0.9)", 318),
      entry("bound", "Watching PR #318", 318),
    ]
    expect(recentHistory(entries).map(({ entry: e, round }) => historyTitle(e, round))).toEqual(["Fix round 1 sent", "Reran a check", "Review judged"])
  })
})

it("links only a GitHub pull request's own repository", () => {
  expect(repositoryUrl("https://github.com/example/editor/pull/318")).toBe("https://github.com/example/editor")
  expect(repositoryUrl("https://gitlab.example/example/editor/-/merge_requests/3")).toBeNull()
  expect(repositoryUrl("javascript:alert(1)//github.com/a/b/pull/1")).toBeNull()
  expect(repositoryUrl(undefined)).toBeNull()
})
