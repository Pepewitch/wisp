import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import type { HarnessUsageReport, ProbeAnswer } from "@/lib/types"

import { ProbePanel } from "./probe-panel"

/**
 * The daemon normalizes codex's account read with every number copied as a
 * number (shared/api/harness.ts); the panel renders those, never a zero or a
 * string the daemon did not send.
 */
function usageAnswer(usage: HarnessUsageReport): ProbeAnswer {
  return { command: "usage", probedAt: "2026-09-04T12:00:00Z", cached: false, report: { format: "usage", usage } }
}

const BASE: HarnessUsageReport = {
  planType: "pro",
  primary: { usedPercent: 41, windowMins: 300, resetsAt: null },
  secondary: null,
  credits: { hasCredits: true, unlimited: false, balance: 12.5 },
  lifetimeTokens: null,
}

describe("ProbePanel usage report", () => {
  it("renders the credits balance the daemon sends as a number", () => {
    render(<ProbePanel harness="codex" command="usage" answer={usageAnswer(BASE)} onClose={() => {}} />)
    const report = screen.getByTestId("probe-usage")
    expect(report).toHaveTextContent("credits12.5")
    expect(report).toHaveTextContent("41% used")
  })

  it("says credits are available when the harness reports no balance", () => {
    const usage = { ...BASE, credits: { hasCredits: true, unlimited: false, balance: null } }
    render(<ProbePanel harness="codex" command="usage" answer={usageAnswer(usage)} onClose={() => {}} />)
    expect(screen.getByTestId("probe-usage")).toHaveTextContent("creditsavailable")
  })
})
