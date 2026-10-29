import { describe, expect, it } from "vitest"

import type { AutoReviewReview, AutoReviewRound } from "../../../shared/api/auto-review"
import type { AutopilotStatus } from "../../../shared/autopilot"
import {
  REVIEW_DOT,
  REVIEW_WORD,
  TIER_WORD,
  findingLine,
  reviewAgentWords,
  reviewTitle,
  reviewVerdict,
  signalsWords,
  tierTitle,
  verificationTitle,
  verificationTone,
} from "./auto-review-words"
import { autopilotAction, autopilotArchiveWords, autopilotChoiceLabel, autopilotRail, autopilotSpeaker, autopilotSwitches, reviewRoundsWords } from "./autopilot-words"

const OFF: AutopilotStatus = {
  autoMerge: false, autoFix: false, pr: 7, state: "waiting", reason: "Reviewing", about: "pr", by: "auto-merge",
  mergedByWisp: false, lastMerged: null, pendingFix: null, fixRounds: 0, done: false, updatedAt: null,
}

describe("auto-review in autopilot's words", () => {
  it("counts as a switch: the rail, the speaker, the label and the archive warning", () => {
    const review = { ...OFF, autoReview: true, by: "auto-review" as const }
    expect(autopilotRail(review)).toBe("on")
    expect(autopilotSpeaker(review)).toBe("auto-review")
    expect(autopilotSpeaker({ ...review, autoMerge: true, by: "auto-merge" })).toBe("auto-merge")
    expect(autopilotSwitches({ ...review, autoMerge: true })).toBe("Auto-merge + auto-review")
    expect(autopilotArchiveWords({ ...review, autoMerge: true, autoFix: true }))
      .toBe("Auto-merge, auto-fix and auto-review are on for PR #7 — archiving switches them off.")
    expect(autopilotArchiveWords(review)).toBe("Auto-review is on for PR #7 — archiving switches it off.")
  })

  it("labels the composer picker short", () => {
    expect(autopilotChoiceLabel({ autoMerge: true, autoFix: true, autoReview: true })).toBe("Auto-merge + fix + review")
    expect(autopilotChoiceLabel({ autoMerge: false, autoFix: false, autoReview: true })).toBe("Auto-review")
    expect(autopilotChoiceLabel({ autoMerge: false, autoFix: false })).toBe("Manual PR")
  })

  it("says a round against the daemon's budget, or threes from an older daemon", () => {
    expect(reviewRoundsWords(0)).toBe("no review rounds yet")
    expect(reviewRoundsWords(2)).toBe("round 2 of 3")
    expect(reviewRoundsWords(4)).toBe("round 4 of 6")
    // switched off and on after two rounds: the next budget ends at 5
    expect(reviewRoundsWords(2, 5)).toBe("round 2 of 5")
    expect(reviewRoundsWords(3, 5)).toBe("round 3 of 5")
  })
})

describe("a project's verification, in one line", () => {
  const quiet = { state: "active" as const, areas: 1, draft: false, attention: false, busy: false }
  it("names the state, and the loudest thing to say outranks the rest", () => {
    expect(verificationTitle({ ...quiet, state: "none", areas: 0 })).toBe("Verification: not set up")
    expect(verificationTitle(quiet)).toBe("Verification: 1 area")
    expect(verificationTone(quiet)).toBeNull()
    expect(verificationTitle({ ...quiet, draft: true })).toBe("Verification: draft ready to activate")
    expect(verificationTone({ ...quiet, draft: true, busy: true })).toBe("busy")
    expect(verificationTitle({ ...quiet, draft: true, busy: true, attention: true })).toBe("Verification needs attention")
  })
})

describe("the one action auto-review asks for", () => {
  it("offers Resume when the reviewer needs you: no verdict, or a rejection to look at again", () => {
    const needsYou = { ...OFF, autoReview: true, state: "needs-you" as const, by: "auto-review" as const }
    expect(autopilotAction(needsYou)).toBe("resume")
    // another switch's needs-you has its own fix, not a Resume
    expect(autopilotAction({ ...needsYou, autoMerge: true, by: "auto-merge" })).toBeNull()
  })
})

describe("the review panel, in words", () => {
  const review = (over: Partial<AutoReviewReview> = {}): AutoReviewReview => ({
    id: "r1", role: "primary", agent: { harness: "claude", model: "opus-5" }, state: "pass", summary: null, rationale: null,
    findings: [], reviewed: [], evidence: [], escalated: null, carried: false, reviewerTaskId: "t1", createdAt: "2026-10-01T09:00:00Z", finishedAt: null,
    ...over,
  })

  it("names the new states and the tiers", () => {
    expect(REVIEW_WORD.pending).toBe("Waiting for a slot")
    expect(REVIEW_WORD.fail).toBe("Rejected")
    expect(REVIEW_DOT.pending).toBe("bg-border-strong")
    expect(TIER_WORD).toEqual({ light: "light review", standard: "standard review", deep: "deep review" })
  })

  it("says a reviewer's state, then why it escalated or what it said", () => {
    expect(reviewVerdict(review({ state: "pending" }))).toBe("Waiting for a slot")
    expect(reviewVerdict(review({ summary: "One PUT per save" }))).toBe("Passed — One PUT per save")
    expect(reviewVerdict(review({ carried: true, summary: "One PUT per save" }))).toBe("Kept — One PUT per save")
    expect(reviewVerdict(review({ escalated: "touches the token refresh", summary: "Looks fine" }))).toBe("Passed · escalated: touches the token refresh")
    expect(reviewAgentWords({ harness: "codex", model: null })).toBe("codex")
    expect(reviewAgentWords({ harness: "codex", model: "gpt-5.6-luna" })).toBe("codex · gpt-5.6-luna")
  })

  it("titles a row with what it truncates, what kept means, and the findings blocking first", () => {
    const title = reviewTitle(review({
      state: "fail", carried: false, summary: "Shortcut bypasses the guard",
      findings: [
        { title: "Rename guardSave()", severity: "note" },
        { title: "The shortcut calls api.save()", file: "web/src/keys.ts", line: 41, severity: "blocking" },
      ],
    }))
    expect(title.split("\n")).toEqual([
      "Rejected — Shortcut bypasses the guard",
      "• Blocking: The shortcut calls api.save() (web/src/keys.ts:41)",
      "• Note: Rename guardSave()",
    ])
    expect(reviewTitle(review({ carried: true }))).toContain("not run again")
    expect(findingLine({ title: "A phase-1 finding" })).toBe("A phase-1 finding")
  })

  it("titles the tier with what Wisp measured", () => {
    expect(signalsWords({ lines: 412, files: 9, areas: 2, unmapped: 0, sensitive: ["db/migrations/0042.sql"], testsTouched: false, docsOnly: false }))
      .toBe("412 changed lines · 9 files · 2 areas · sensitive: db/migrations/0042.sql")
    expect(signalsWords({ lines: 1, files: 1, areas: 1, unmapped: 1, sensitive: [], testsTouched: true, docsOnly: true }))
      .toBe("1 changed line · 1 file · 1 area · 1 file in no area · docs only")
    const round = { tier: "deep", signals: { lines: 3, files: 1, areas: 0, unmapped: 0, sensitive: [], testsTouched: true, docsOnly: false } } as Partial<AutoReviewRound>
    expect(tierTitle(round as AutoReviewRound)).toBe("Deep review, chosen by Wisp from the diff\n3 changed lines · 1 file · 0 areas · tests touched")
    expect(tierTitle({ tier: null } as AutoReviewRound)).toBeUndefined()
  })
})
