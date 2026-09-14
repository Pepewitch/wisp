import type { RefObject } from "react"

import { CopyButton } from "@/components/copy-button"
import { AttachButton } from "@/components/pending-attachments"
import { Meta, StateDot } from "@/components/primitives"
import { ProbePanel } from "@/components/probe-panel"
import { SlashPalette } from "@/components/slash-palette"
import { TokensPanel } from "@/components/tokens-panel"
import { useTaskUsage } from "@/hooks/queries"
import type { ReportState, SteerNote } from "@/hooks/useSteerCommands"
import { useTick } from "@/hooks/useTick"
import { ApiError } from "@/lib/api"
import type { PendingAttachments } from "@/lib/attachments"
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
  composerStatus,
  attachments,
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
  composerStatus: string | null
  attachments: PendingAttachments
  note: SteerNote | null
}) {
  const tokensOpen = shownReport?.kind === "tokens" && task !== null
  const taskUsage = useTaskUsage(task?.id ?? null, tokensOpen)
  const legacyUsage = taskUsage.error instanceof ApiError && taskUsage.error.status === 404
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
          turns={taskUsage.data?.turns ?? (legacyUsage ? turns : undefined)}
          total={taskUsage.data?.total}
          reportingTurns={taskUsage.data?.reporting_turns}
          hasOlderTurns={taskUsage.data?.has_older_turns}
          loading={taskUsage.isPending}
          error={legacyUsage ? null : taskUsage.error}
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
      <ComposerUtilityRow
        task={task}
        startedAt={runningSince}
        status={composerStatus}
        attachments={attachments}
        touch={touch}
      />
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
        // one unbreakable item: "xhigh effort" wrapping mid-phrase was how a
        // squeezed bar announced itself before the bar learned its own width
        task.effort ? (
          <span key="effort" className="shrink-0 whitespace-nowrap">
            {task.effort} effort
          </span>
        ) : null,
      ]}
    />
  )
}

function ComposerUtilityRow({
  task,
  startedAt,
  status,
  attachments,
  touch,
}: {
  task: ApiTask | null
  startedAt: string | null
  status: string | null
  attachments: PendingAttachments
  touch: boolean
}) {
  const now = useTick(Boolean(startedAt))
  const text = startedAt ? elapsed(startedAt, now) : null
  if (!task && !text && !status) return null
  return (
    <div data-testid="composer-utility-row" className="mb-1.5 flex min-h-6 items-center gap-2 pl-1.5">
      {text && (
        <span className="flex min-w-0 items-center gap-2" aria-live="off">
          <StateDot state="running" className="animate-breathe" />
          <span className="font-mono text-[11px] text-muted-foreground tabular-nums">{text}</span>
        </span>
      )}
      <span className="flex-1" />
      {status && <span className="min-w-0 truncate text-right text-[11px] text-faint">{status}</span>}
      {task && <AttachButton pending={attachments} touch={touch} className={touch ? "-my-2" : undefined} />}
    </div>
  )
}
