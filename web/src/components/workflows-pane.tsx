import { useState, type ReactNode } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"

import type { Workflow, WorkflowDefinition, WorkflowDetail, WorkflowParams, WorkflowState } from "../../../shared/workflows"
import { ChevronLeft, Plus } from "@/components/icons"
import { Button, PaneHeader } from "@/components/primitives"
import { useTaskWorkflows, useWorkflowTypes } from "@/hooks/queries"
import { failureReason } from "@/lib/api"
import { useDaemonRuntime } from "@/lib/runtime"
import { fromNow } from "@/lib/time"
import type { ApiTask } from "@/lib/types"
import { cn } from "@/lib/utils"
import { WorkflowForm } from "./workflow-form"

/**
 * Workflows are a PANE, not a dialog. They are durable state belonging to one
 * task — the same register as its diff — so they live beside Changes in the
 * right column and stay readable while the agent works.
 *
 * What this replaced: a button under the task header that opened a 640px modal
 * over the whole app. The modal put a scrim between you and the very task the
 * automation was watching, stacked "pick one" and "configure it" into one tall
 * scroll, and made *what is armed here?* a question you had to open a door to
 * ask. None of that was the feature's fault — it was the surface's.
 *
 * The pane is a drill-down, exactly like the diff pane: list → one item, and
 * adding is list → picker → form. Nothing here opens an overlay, so the tab
 * strip never leaves the screen and Changes is always one click away.
 */
export function WorkflowsPane({
  task,
  prUrl,
  header,
  hidden = false,
  touch = false,
}: {
  task: ApiTask | null
  prUrl?: string
  /** the right column's tab strip; the pane still owns the action at the right edge */
  header?: ReactNode
  hidden?: boolean
  touch?: boolean
}) {
  const { transport, qk } = useDaemonRuntime()
  const client = useQueryClient()
  const [view, setView] = useState<View>({ kind: "list" })

  const taskId = task?.id ?? null
  const items = useTaskWorkflows(taskId, true)
  // the list needs these too: a row is named by its definition, not by its id
  const types = useWorkflowTypes(true)
  const mutation = useMutation({
    mutationFn: ({ path, method, body }: { path: string; method: "POST" | "PATCH"; body: unknown }) =>
      transport.request(path, { method, body }),
    onSuccess: () => {
      if (taskId) void client.invalidateQueries({ queryKey: [...qk.task(taskId), "workflows"] })
      setView({ kind: "list" })
    },
  })

  const act = (item: Workflow, action: "pause" | "resume" | "complete") =>
    mutation.mutate({ path: `/api/workflows/${item.id}/${action}`, method: "POST", body: {} })
  const save = (params: WorkflowParams) => {
    if (view.kind !== "form" || !taskId) return
    mutation.mutate(
      view.existing
        ? { path: `/api/workflows/${view.existing.id}`, method: "PATCH", body: { revision: view.existing.revision, params } }
        : { path: `/api/tasks/${taskId}/workflows`, method: "POST", body: { type: view.type, params } },
    )
  }
  const toList = () => {
    setView({ kind: "list" })
    mutation.reset()
  }
  const error = mutation.error ?? types.error ?? items.error

  return (
    <div className={cn("h-full min-h-0 flex-1 flex-col", hidden ? "hidden" : "flex")} aria-hidden={hidden || undefined}>
      <PaneHeader touch={touch} className={header ? "pl-2" : undefined}>
        {/* No action at this end. A `+` here would sit in a tab strip, one
            pane above a Terminal whose `+` means "new shell TAB" — same glyph,
            same corner, different noun. Adding lives in the list instead, next
            to the things it adds to. */}
        {header ?? <span className="text-[12.5px] font-medium text-foreground">Workflows</span>}
      </PaneHeader>

      {/* the way back out of a drill-down, in the pane rather than in a
          dialog's corner — the tab strip above it never moves */}
      {view.kind !== "list" && (
        <button
          type="button"
          onClick={toList}
          className={cn(
            "flex shrink-0 items-center gap-1 border-b border-border px-2 text-[11.5px] text-muted-foreground",
            "transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
            touch ? "h-11" : "h-7",
          )}
        >
          <ChevronLeft className="size-3" />
          Workflows
        </button>
      )}

      <div className="scroll-slim min-h-0 flex-1 overflow-y-auto px-2 py-1.5">
        <Body
          view={view}
          setView={setView}
          task={task}
          prUrl={prUrl}
          items={items.data}
          loading={items.isPending}
          types={types}
          pending={mutation.isPending}
          onAct={act}
          onSave={save}
          onCancel={toList}
          resetMutation={() => mutation.reset()}
        />
      </div>

      {error && (
        <p role="alert" className="shrink-0 border-t border-border px-3.5 py-2 text-[11.5px] text-destructive">
          {failureReason(error)}
        </p>
      )}
    </div>
  )
}

type View = { kind: "list" } | { kind: "picker" } | { kind: "form"; type: string; existing?: Workflow }
type Types = { data?: WorkflowDefinition[]; isPending: boolean }

function Body({
  view,
  setView,
  task,
  prUrl,
  items,
  loading,
  types,
  pending,
  onAct,
  onSave,
  onCancel,
  resetMutation,
}: {
  view: View
  setView: (view: View) => void
  task: ApiTask | null
  prUrl?: string
  items?: Workflow[]
  loading: boolean
  types: Types
  pending: boolean
  onAct: (item: Workflow, action: "pause" | "resume" | "complete") => void
  onSave: (params: WorkflowParams) => void
  onCancel: () => void
  resetMutation: () => void
}) {
  if (!task) return <Note>No task selected</Note>
  if (view.kind === "picker") {
    return <Picker types={types.data} loading={types.isPending} onPick={(type) => setView({ kind: "form", type })} />
  }
  if (view.kind === "form") {
    const definition = types.data?.find((d) => d.id === view.type)
    if (!definition) return <Note>Loading workflow…</Note>
    return (
      <WorkflowForm
        key={`${definition.id}:${view.existing?.id ?? "new"}`}
        definition={definition}
        existing={view.existing}
        prUrl={prUrl}
        pending={pending}
        onSubmit={onSave}
        onCancel={onCancel}
      />
    )
  }
  if (loading) return <Note>Reading this task&#39;s workflows…</Note>
  if (!items?.length) return <Empty archived={task.archived} onAdd={() => setView({ kind: "picker" })} />
  return (
    <List
      items={items}
      types={types.data}
      archived={task.archived}
      pending={pending}
      onAct={onAct}
      onConfigure={(item) => {
        resetMutation()
        setView({ kind: "form", type: item.type, existing: item })
      }}
      onAdd={() => setView({ kind: "picker" })}
    />
  )
}

/**
 * Live workflows read as a list; finished ones collapse into one line. A task
 * that ran three watches over a week should not open on three obituaries.
 */
function List({
  items,
  types,
  archived,
  pending,
  onAct,
  onConfigure,
  onAdd,
}: {
  items: Workflow[]
  types?: WorkflowDefinition[]
  archived: boolean
  pending: boolean
  onAct: (item: Workflow, action: "pause" | "resume" | "complete") => void
  onConfigure: (item: Workflow) => void
  onAdd: () => void
}) {
  const [opened, setOpened] = useState<string | null>(null)
  // a plugin can be uninstalled while its workflow lives on, so the id is the
  // fallback name rather than an empty row
  const nameOf = (item: Workflow) => types?.find((d) => d.id === item.type)?.name ?? item.type
  const live = items.filter((w) => w.state !== "completed")
  const finished = items.filter((w) => w.state === "completed")
  const row = (item: Workflow, frozen: boolean) => (
    <Row
      key={item.id}
      item={item}
      name={nameOf(item)}
      open={opened === item.id}
      onToggle={() => setOpened(opened === item.id ? null : item.id)}
      pending={pending}
      frozen={frozen}
      onAct={(action) => onAct(item, action)}
      onConfigure={() => onConfigure(item)}
    />
  )
  return (
    <>
      {live.map((item) => row(item, archived))}
      {/* The list ends in the control, populated or empty — the same debt the
          empty state pays, paid in the same place. It is a ROW, the height of
          a file row in Changes, so it reads as "one more of these" rather than
          as pane chrome. */}
      {!archived && <AddRow onAdd={onAdd} />}
      {finished.length > 0 && (
        <details className="mt-1">
          <summary className="cursor-pointer rounded-md px-2 py-1.5 text-[11.5px] text-muted-foreground hover:bg-hover">
            Finished · {finished.length}
          </summary>
          {finished.map((item) => row(item, true))}
        </details>
      )}
      <p className="px-2 pt-2.5 pb-1 text-[11px] leading-relaxed text-faint">
        Checks run while this daemon and its host are awake, even with the app closed. Stop turn pauses them; leaving
        this tab does not.
      </p>
    </>
  )
}

const STATE_WORD: Record<WorkflowState, string> = { active: "Active", paused: "Paused", completed: "Finished" }

/**
 * The chip ban applies here too: a dot plus muted words, never a pill. A RING
 * rather than a fill, for the same reason `StateDot` rings background work — a
 * workflow is ambient work attached to the task, not the agent's own outcome.
 * Finished is the one filled dot: it IS an outcome, and it is over.
 */
function AddRow({ onAdd }: { onAdd: () => void }) {
  return (
    <button
      type="button"
      onClick={onAdd}
      className="mt-0.5 flex h-7 w-full items-center gap-1.5 rounded-md px-2 text-left text-[12px] text-muted-foreground transition-colors hover:bg-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
    >
      <Plus className="size-3.5 shrink-0" />
      Add workflow…
    </button>
  )
}

function WorkflowDot({ state }: { state: WorkflowState }) {
  return (
    <span
      aria-hidden
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        state === "active" ? "border-2 border-state-background" : state === "paused" ? "border-2 border-faint" : "bg-faint",
      )}
    />
  )
}

/** Expected states are muted notes; only a real failure gets the destructive hue. */
function Note({ children }: { children: ReactNode }) {
  return <div className="px-1.5 py-1.5 text-[12px] text-faint">{children}</div>
}

/** An empty state ends in the control, not in a noun. */
function Empty({ archived, onAdd }: { archived: boolean; onAdd: () => void }) {
  return (
    <div className="px-1.5 py-1.5">
      <p className="text-[12px] leading-relaxed text-muted-foreground">
        Nothing is watching this task. A workflow checks a condition without spending a turn, and wakes the agent only
        when there is something to do.
      </p>
      {!archived && (
        <Button tone="outline" size="md" className="mt-2.5" onClick={onAdd}>
          <Plus />
          Add workflow…
        </Button>
      )}
    </div>
  )
}

function Picker({
  types,
  loading,
  onPick,
}: {
  types?: WorkflowDefinition[]
  loading: boolean
  onPick: (type: string) => void
}) {
  if (loading) return <Note>Loading workflows…</Note>
  if (!types?.length) return <Note>This daemon installs no workflows.</Note>
  return (
    <>
      {types.map((def) => (
        <button
          key={def.id}
          type="button"
          aria-label={`Add ${def.name}`}
          onClick={() => onPick(def.id)}
          className="block w-full rounded-md px-2 py-2 text-left transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          <span className="block text-[12.5px] font-medium">{def.name}</span>
          <span className="mt-0.5 block text-[11.5px] leading-relaxed text-muted-foreground">{def.description}</span>
        </button>
      ))}
    </>
  )
}

/**
 * Two lines closed — what it is, and what it is waiting for — with the
 * numbers, the controls and the history on click. Same gesture as a file row
 * in Changes, so the right column has one way to open a thing.
 */
function Row({
  item,
  name,
  open,
  onToggle,
  pending,
  frozen,
  onAct,
  onConfigure,
}: {
  item: Workflow
  name: string
  open: boolean
  onToggle: () => void
  pending: boolean
  /** archived tasks and finished workflows read; they do not act */
  frozen: boolean
  onAct: (action: "pause" | "resume" | "complete") => void
  onConfigure: () => void
}) {
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className={cn(
          "flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left transition-colors",
          open ? "bg-accent" : "hover:bg-hover",
        )}
      >
        <span className="flex w-full items-center gap-2">
          <WorkflowDot state={item.state} />
          <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">{name}</span>
          <span className="shrink-0 text-[11.5px] text-muted-foreground">{STATE_WORD[item.state]}</span>
        </span>
        <span className="w-full truncate pl-3.5 text-[11.5px] text-muted-foreground">{item.reason}</span>
      </button>
      {open && (
        <Detail item={item} pending={pending} frozen={frozen} onAct={onAct} onConfigure={onConfigure} />
      )}
    </div>
  )
}

function Detail({
  item,
  pending,
  frozen,
  onAct,
  onConfigure,
}: {
  item: Workflow
  pending: boolean
  frozen: boolean
  onAct: (action: "pause" | "resume" | "complete") => void
  onConfigure: () => void
}) {
  const { transport, qk } = useDaemonRuntime()
  // History is fetched by OPENING the row, not by a second button beside it —
  // one gesture, and only for the row you actually asked about.
  const detail = useQuery({
    queryKey: [...qk.task(item.taskId), "workflows", item.id],
    queryFn: () => transport.request<WorkflowDetail>(`/api/workflows/${item.id}`),
  })
  return (
    <div className="mb-1 px-2 pt-1.5 pb-1 pl-5.5">
      <p className="text-[11.5px] leading-relaxed text-muted-foreground">
        {item.lastCheckedAt ? `Checked ${fromNow(item.lastCheckedAt)}` : "Not checked yet"} · {item.wakeCount}/
        {String(item.params.maxWakeups)} wake-ups
        {item.state === "active" && ` · next check ${fromNow(item.nextCheckAt)}`}
      </p>
      {/* -ml-2.5 cancels the button's own padding, so the labels start on the
          same left edge as the line above them */}
      {!frozen && (
        <div className="-ml-2.5 mt-1.5 flex flex-wrap gap-1">
          <Button disabled={pending} onClick={() => onAct(item.state === "active" ? "pause" : "resume")}>
            {item.state === "active" ? "Pause" : "Resume"}
          </Button>
          <Button disabled={pending} onClick={onConfigure}>
            Configure
          </Button>
          {/* `complete` is the daemon's own verb for "stop watching". The row
              then moves under Finished, which is what removal looks like
              without losing the history that explains it. */}
          <Button disabled={pending} onClick={() => onAct("complete")}>
            Remove
          </Button>
        </div>
      )}
      <div className="mt-1.5 border-l border-border pl-2.5">
        {detail.isPending && (
          <p role="status" className="text-[11.5px] text-faint">
            Loading history…
          </p>
        )}
        {detail.data?.history.length === 0 && <p className="text-[11.5px] text-faint">No history yet</p>}
        {detail.data?.history.map((entry) => (
          <p key={entry.id} className="text-[11.5px] leading-relaxed text-muted-foreground">
            <span title={entry.at} className="text-faint">
              {fromNow(entry.at)}
            </span>{" "}
            {entry.detail}
          </p>
        ))}
      </div>
    </div>
  )
}
