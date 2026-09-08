import { describe, expect, it } from "vitest"

import type { Turn } from "@/lib/types"
import { reportedUsageTurns, totalUsage, usageParts } from "@/lib/usage"

describe("task usage formatting", () => {
  it("skips turns without reports instead of inventing zeros", () => {
    const turns = [{ usage: null }, { usage: { inputTokens: 0 } }] as Turn[]
    expect(reportedUsageTurns(undefined)).toEqual([])
    expect(reportedUsageTurns(turns)).toEqual([turns[1]])
  })

  it("formats reported fields in one stable order", () => {
    expect(
      usageParts({
        reasoningTokens: 0,
        cacheWriteTokens: 7,
        cachedInputTokens: 24_800_000,
        outputTokens: 2_100,
        inputTokens: 41_200,
      }),
    ).toEqual(["41.2k in", "2.1k out", "24.8m cached", "7 cache write"])
  })

  it("sums partial reports without adding absent fields", () => {
    expect(totalUsage([{ inputTokens: 10 }, { inputTokens: 5, outputTokens: 2 }])).toEqual({
      inputTokens: 15,
      outputTokens: 2,
    })
  })
})
