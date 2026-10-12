import { describe, expect, it } from "vitest"

import type { AutopilotStatus } from "../../../shared/autopilot"
import { verificationTitle, verificationTone } from "./auto-review-words"
import { autopilotArchiveWords, autopilotChoiceLabel, autopilotRail, autopilotSpeaker, autopilotSwitches, reviewRoundsWords } from "./autopilot-words"

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

  it("says a round against its budget of three", () => {
    expect(reviewRoundsWords(0)).toBe("no review rounds yet")
    expect(reviewRoundsWords(2)).toBe("round 2 of 3")
    expect(reviewRoundsWords(4)).toBe("round 4 of 6")
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
