import { formatBytes } from "@/lib/attachments"
import type { Turn } from "@/lib/types"

function DiagnosticAvailability({ taskId, turn }: { taskId: string; turn: Turn }) {
  const command = <code>wisp log {taskId} {turn.n} --diagnostic</code>
  switch (turn.diagnostic_state) {
    case "complete":
      return <> The retained diagnostic history can be exported with {command}.</>
    case "partial":
      return (turn.diagnostic_bytes ?? 0) > 0
        ? <> A partial diagnostic archive can be exported with {command}.</>
        : <> No diagnostic records were retained.</>
    case "evicted":
      return <> The diagnostic archive has been evicted.</>
    case "disabled":
      return <> Diagnostic recording was disabled.</>
    case "unavailable":
      return <> Diagnostic recording was unavailable.</>
    default:
      return null
  }
}

export function TurnCaptureNotice({ taskId, turn }: { taskId: string; turn: Turn }) {
  if (turn.capture_state === "evicted") return (
    <div data-capture-state="evicted" className="mt-3.5 text-[12px] text-muted-foreground">
      Transcript evicted by archived-task log retention. Indexed agent prose remains searchable; the final result is kept.
    </div>
  )
  if (turn.capture_state !== "degraded" && turn.capture_state !== "disabled") return null
  return (
    <div data-capture-state={turn.capture_state} className="mt-3.5 rounded-md border border-border bg-card px-3 py-2">
      <div className="text-[10.5px] font-semibold tracking-[0.075em] text-fg-secondary uppercase">
        Activity history incomplete
      </div>
      <div className="mt-1 text-[12px] leading-relaxed text-fg-secondary">
        {turn.capture_state === "degraded"
          ? `${(turn.omitted_records ?? 0).toLocaleString()} records (${formatBytes(turn.omitted_bytes ?? 0)}) were not retained. `
          : "Transcript storage stopped during this turn. "}
        The final outcome was recorded independently.
        <DiagnosticAvailability taskId={taskId} turn={turn} />
      </div>
    </div>
  )
}
