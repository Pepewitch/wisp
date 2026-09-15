import { COMPACTED_TEXT, COMPACTING_TEXT } from "@/lib/compaction"
import type { Turn } from "@/lib/types"

export function TurnProgress({
  turn,
  hasLiveItems,
}: {
  turn: Turn
  hasLiveItems: boolean
}) {
  const compact = turn.operation === "compact"
  if (!compact && (turn.status !== "running" || hasLiveItems)) return null
  if (compact && turn.status !== "running" && turn.status !== "done")
    return null

  return (
    <div
      data-testid={compact ? "turn-operation-status" : undefined}
      className="mt-3.5 flex items-center gap-2 text-[11.5px] text-faint"
    >
      {turn.status === "running" && (
        <span className="size-1.5 animate-pulse rounded-full bg-state-running" />
      )}
      {compact
        ? turn.status === "running"
          ? COMPACTING_TEXT
          : COMPACTED_TEXT
        : "Working…"}
    </div>
  )
}
