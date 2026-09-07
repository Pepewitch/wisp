import type { RefObject } from "react"

import { CopyButton } from "@/components/copy-button"
import { Meta, StateDot } from "@/components/primitives"
import { ProbePanel } from "@/components/probe-panel"
import { SlashPalette } from "@/components/slash-palette"
import { TokensPanel } from "@/components/tokens-panel"
import type { ReportState, SteerNote } from "@/hooks/useSteerCommands"
import { useTick } from "@/hooks/useTick"
import { elapsed } from "@/lib/state"
import type { ApiTask, Turn } from "@/lib/types"
import type { SlashEntry, SlashGroup, SlashToken } from "@/lib/slash"
import { cn } from "@/lib/utils"

export function SteerOverlays({
  shownReport,
  task,
  turns,
  onDismissReport,
  palette,
  groups,
  onPick,
  commandRef,
  touch,
  runningSince,
  note,
}: {
  shownReport: ReportState
  task: ApiTask | null
  turns?: Turn[]
  onDismissReport: () => void
  palette: SlashToken | null
  groups: SlashGroup[]
  onPick: (entry: SlashEntry) => void
  commandRef: RefObject<HTMLDivElement | null>
  touch: boolean
  runningSince: string | null
  note: SteerNote | null
}) {
  return (
    <>
      {shownReport?.kind === "probe" && task && (
        <ProbePanel
          harness={task.harness}
          command={shownReport.command}
          answer={shownReport.answer}
          onClose={onDismissReport}
          className="absolute inset-x-0 bottom-full z-(--z-menu) mb-1.5"
        />
      )}
      {shownReport?.kind === "tokens" && task && (
        <TokensPanel
          harness={task.harness}
          turns={turns}
          onClose={onDismissReport}
          className="absolute inset-x-0 bottom-full z-(--z-menu) mb-1.5"
        />
      )}
      {palette && task && (
        <SlashPalette
          groups={groups}
          query={palette.query}
          onPick={onPick}
          commandRef={commandRef}
          touch={touch}
        />
      )}
      {runningSince && <RunningFor startedAt={runningSince} />}
      {note && <SteerNoteRow note={note} />}
    </>
  )
}

function SteerNoteRow({ note }: { note: SteerNote }) {
  return (
    <div className="mb-1.5 flex items-center gap-2 pl-1.5">
      <span
        data-testid="steer-note"
        title={note.title ?? note.text}
        className={cn(
          "min-w-0 flex-1 truncate text-[11.5px]",
          note.tone === "muted" ? "text-muted-foreground" : "text-destructive",
          note.copyable && "font-mono"
        )}
      >
        {note.text}
      </span>
      {note.copyable && (
        <CopyButton text={note.copyable} className="shrink-0" />
      )}
    </div>
  )
}

export function TaskIdentity({ task }: { task: ApiTask }) {
  return (
    <Meta
      className="gap-1.5"
      items={[
        task.harness,
        task.model ? (
          <span key="model" className="min-w-0 truncate font-mono">
            {task.model}
          </span>
        ) : null,
        task.effort ? `${task.effort} effort` : null,
      ]}
    />
  )
}

function RunningFor({ startedAt }: { startedAt: string }) {
  const now = useTick(true)
  const text = elapsed(startedAt, now)
  if (!text) return null
  return (
    <div className="mb-1.5 flex items-center gap-2 pl-1.5" aria-live="off">
      <StateDot state="running" className="animate-breathe" />
      <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
        {text}
      </span>
    </div>
  )
}
