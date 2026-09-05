import { useRef, useState } from "react"

import { Bot, ChevronRight } from "@/components/icons"
import { Prose } from "@/components/prose"
import { Meta, StateDot } from "@/components/primitives"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { summarizeStep, toolDetails } from "@/lib/activity"
import { duration, formatDuration } from "@/lib/state"
import type { TaskState } from "@/lib/types"
import { cn } from "@/lib/utils"
import type {
  ActivityItem,
  SubagentActivityItem,
  ThinkingActivityItem,
  ToolActivityItem,
} from "@/stream/reducer"

type Compensate = (node: HTMLElement | null, before: number) => void

export function ActivityList({
  items,
  onBeforeToggle,
  depth = 0,
}: {
  items: ActivityItem[]
  onBeforeToggle: Compensate
  depth?: number
}) {
  return (
    <div className={cn("flex flex-col gap-0.5", depth > 0 && "mt-1")}>
      {items.map((item) => {
        if (item.kind === "text") return <Prose key={item.id} text={item.text.trimEnd()} className="my-2" />
        if (item.kind === "thinking") {
          return <ThinkingRow key={item.id} item={item} onBeforeToggle={onBeforeToggle} />
        }
        if (item.kind === "tool") return <ToolRow key={item.id} item={item} onBeforeToggle={onBeforeToggle} />
        return (
          <SubagentRow
            key={item.id}
            item={item}
            depth={depth}
            onBeforeToggle={onBeforeToggle}
          />
        )
      })}
    </div>
  )
}

function withCompensation(
  node: React.RefObject<HTMLDivElement | null>,
  onBeforeToggle: Compensate,
  update: () => void,
) {
  const before = node.current?.closest("[data-testid=conversation-viewport]")?.scrollHeight ?? 0
  update()
  requestAnimationFrame(() => onBeforeToggle(node.current, before))
}

function ThinkingRow({ item, onBeforeToggle }: { item: ThinkingActivityItem; onBeforeToggle: Compensate }) {
  const [open, setOpen] = useState(false)
  const node = useRef<HTMLDivElement>(null)
  const expandable = Boolean(item.text)
  const preview = item.text?.split("\n")[0] ?? "no reasoning text from this harness"

  return (
    <Collapsible
      ref={node}
      open={open}
      disabled={!expandable}
      onOpenChange={(next) => withCompensation(node, onBeforeToggle, () => setOpen(next))}
      className="py-0.5"
    >
      <CollapsibleTrigger
        className={cn(
          "group flex min-h-[30px] w-full items-center gap-2 text-left",
          expandable ? "cursor-pointer" : "cursor-default",
        )}
      >
        <ChevronRight
          aria-hidden
          className={cn(
            "size-3 shrink-0 transition-transform group-data-panel-open:rotate-90",
            expandable ? "text-muted-foreground" : "text-faint/40",
          )}
        />
        <span className="shrink-0 text-[11.5px] font-medium text-fg-secondary italic">Thinking</span>
        {!open && <span className="min-w-0 flex-1 truncate text-[11.5px] text-fg-secondary italic">{preview}</span>}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-1.5 mb-1 ml-1 border-l border-border-strong pl-3.5 text-[11.5px] leading-relaxed whitespace-pre-wrap text-fg-secondary italic">
          {item.text}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

function ToolRow({ item, onBeforeToggle }: { item: ToolActivityItem; onBeforeToggle: Compensate }) {
  const [open, setOpen] = useState(false)
  const node = useRef<HTMLDivElement>(null)
  const summary = summarizeStep(item)
  const expandable = item.input !== null || Boolean(item.output || item.error)
  const details = open ? toolDetails(item) : ""

  return (
    <Collapsible
      ref={node}
      open={open}
      disabled={!expandable}
      onOpenChange={(next) => withCompensation(node, onBeforeToggle, () => setOpen(next))}
      className="py-0.5"
    >
      <CollapsibleTrigger
        className={cn(
          "group flex min-h-[30px] w-full items-center gap-2 text-left",
          expandable ? "cursor-pointer" : "cursor-default",
        )}
      >
        <ChevronRight
          aria-hidden
          className={cn(
            "size-3 shrink-0 transition-transform group-data-panel-open:rotate-90",
            expandable ? "text-muted-foreground" : "text-faint/40",
          )}
        />
        <span className="shrink-0 font-mono text-[11.5px] font-medium text-fg-secondary">{summary.verb}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-fg-secondary">{summary.arg}</span>
        {summary.note && !open && (
          <span className={cn("shrink-0 font-mono text-[10.5px]", item.error ? "text-state-failed" : "text-fg-secondary")}>
            {summary.note}
          </span>
        )}
        {!summary.note && item.status === "running" && (
          <span className="shrink-0 text-[10.5px] text-fg-secondary">Running</span>
        )}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div
          className={cn(
            "mt-1.5 mb-1 ml-1 border-l border-border-strong pl-3.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap",
            item.error ? "text-state-failed" : "text-fg-secondary",
          )}
        >
          {details}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

const SUBAGENT_LABEL: Record<SubagentActivityItem["status"], string> = {
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  stopped: "Stopped",
  unknown: "Status unavailable",
}

const SUBAGENT_DOT: Record<SubagentActivityItem["status"], TaskState> = {
  running: "running",
  completed: "done",
  failed: "failed",
  stopped: "stuck",
  unknown: "creating",
}

function SubagentRow({
  item,
  depth,
  onBeforeToggle,
}: {
  item: SubagentActivityItem
  depth: number
  onBeforeToggle: Compensate
}) {
  const [open, setOpen] = useState(false)
  const node = useRef<HTMLDivElement>(null)
  const meta = subagentMeta(item)
  const elapsed = subagentDuration(item)
  const qualifiers = [item.background ? "Background" : null, elapsed].filter(Boolean).join(" · ")
  const hasDetails = item.items.length > 0 || Boolean(item.prompt || item.result || item.error)

  return (
    <Collapsible
      ref={node}
      open={open}
      disabled={!hasDetails}
      onOpenChange={(next) => withCompensation(node, onBeforeToggle, () => setOpen(next))}
      data-subagent={item.id}
      data-status={item.status}
      className={cn(
        "my-1",
        depth === 0 ? "rounded-lg border border-border-strong bg-card" : "border-l border-border-strong pl-2",
      )}
    >
      <CollapsibleTrigger
        className={cn(
          "group flex min-h-11 w-full items-center gap-2.5 px-3 py-1.5 text-left",
          hasDetails ? "cursor-pointer" : "cursor-default",
        )}
      >
        <span aria-hidden className="flex size-5 shrink-0 items-center justify-center text-faint [&>svg]:size-4">
          <Bot />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12.5px] font-medium text-foreground/90">{item.title}</span>
          <Meta
            className="mt-0.5 overflow-hidden whitespace-nowrap text-fg-secondary [&_.text-faint]:text-fg-secondary [&>span:last-child]:min-w-0 [&>span:last-child]:truncate"
            items={meta}
          />
        </span>
        <span className="flex shrink-0 flex-col items-end gap-0.5">
          <span className="flex items-center gap-1.5 text-[11px]">
            <StateDot state={SUBAGENT_DOT[item.status]} />
            <span
              aria-live="polite"
              className={item.status === "failed" ? "text-state-failed" : "text-fg-secondary"}
            >
              {SUBAGENT_LABEL[item.status]}
            </span>
          </span>
          {qualifiers && <span className="text-[10px] whitespace-nowrap text-fg-secondary">{qualifiers}</span>}
        </span>
        <ChevronRight
          aria-hidden
          className={cn(
            "size-3 shrink-0 transition-transform group-data-panel-open:rotate-90",
            hasDetails ? "text-muted-foreground" : "text-faint/40",
          )}
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className={cn("border-t border-border px-3 pt-2 pb-2.5", depth > 0 && "border-t-0 pt-1")}>
          {item.prompt && (
            <div className="mb-2.5">
              <div className="mb-1 text-[10.5px] font-medium text-fg-secondary">Assignment</div>
              <Prose text={item.prompt} className="text-[12px] text-fg-secondary" />
            </div>
          )}
          {item.items.length > 0 && (
            <ActivityList items={item.items} depth={depth + 1} onBeforeToggle={onBeforeToggle} />
          )}
          {item.status === "running" && item.items.length === 0 && (
            <p className="text-[11.5px] text-fg-secondary">This harness has not streamed child activity yet.</p>
          )}
          {item.result && <Prose text={item.result} className="mt-2 text-[12px]" />}
          {item.error && (
            <div className="mt-2">
              <div className="mb-1 text-[10.5px] font-medium text-state-failed">Issue</div>
              <div className="text-[12px] leading-relaxed whitespace-pre-wrap text-state-failed">{item.error}</div>
            </div>
          )}
          {!item.prompt && !item.items.length && !item.result && !item.error && item.status !== "running" && (
            <p className="text-[11.5px] text-fg-secondary">This harness reported no child transcript.</p>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

function subagentMeta(item: SubagentActivityItem): React.ReactNode[] {
  const values: React.ReactNode[] = []
  if (item.agentType) values.push(displayLabel(item.agentType))
  if (item.effort) values.push(displayLabel(item.effort))
  if (item.model) values.push(<span key="model" className="font-mono">{item.model}</span>)
  if (values.length === 0) values.push("Subagent")
  return values
}

function displayLabel(value: string): string {
  return value
    .replaceAll(/[-_]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase())
}

function subagentDuration(item: SubagentActivityItem): string | null {
  if (item.durationMs !== null && item.durationMs > 0) return formatDuration(item.durationMs)
  if (item.startedAt === null || item.endedAt === null) return null
  const label = duration(item.startedAt, item.endedAt)
  return label === "0s" ? null : label
}
