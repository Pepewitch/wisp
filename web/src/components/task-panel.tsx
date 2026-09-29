import { useState } from "react"

import { ChangesPane } from "@/components/changes-pane"
import { PaneErrorBoundary } from "@/components/error-boundary"
import { Tab } from "@/components/primitives"
import { BriefPane } from "@/components/task-brief"
import { WorkflowsPane } from "@/components/workflows-pane"
import { parsedDiff, useDiff, useHarnessFeatures, useTaskWorkflows } from "@/hooks/queries"
import { changedFileCount } from "@/lib/diff"
import { useDaemonRuntime } from "@/lib/runtime"
import type { ApiTask } from "@/lib/types"

type PanelTab = "brief" | "changes" | "workflows"

const LABEL: Record<PanelTab, string> = { brief: "Brief", changes: "Changes", workflows: "Workflows" }

/**
 * The right column's upper panel. Three views of the same task's durable state:
 * the **Brief** (where it stands), its **Changes**, and the **Workflows**
 * watching it.
 *
 * The frontend reference said Changes "keeps a tab's shape so Checks can slot
 * in beside it later". Workflows is the sibling that arrived first. It belongs
 * here rather than behind a button under the task header, because an armed
 * workflow is standing state you want to SEE: the button only said how many
 * were active, and "what is it waiting for?" cost a modal over the whole app.
 *
 * The brief joined them for the same reason. As a band above the conversation
 * it took height from the one column you read in, on every task, whether or
 * not you wanted it. Here it costs nothing until you look, and it is the tab
 * the panel opens on: it is the answer to "where did this leave off?".
 *
 * All panes stay mounted. Switching to Workflows and back must not close the
 * diff you had open — the same rule the mobile shell's tabs already follow.
 *
 * A daemon with neither `taskBriefs` nor `taskWorkflows` gets no strip at
 * all: one pane, its own label, exactly as before.
 */
export function TaskPanel({
  task,
  taskId,
  archived,
  onRefresh,
  touch = false,
}: {
  task: ApiTask | null
  taskId: string | null
  archived: boolean
  onRefresh?: () => void
  touch?: boolean
}) {
  const { connectionId } = useDaemonRuntime()
  const features = useHarnessFeatures()
  const workflowsSupported = Boolean(features.data?.taskWorkflows)
  const briefsSupported = Boolean(features.data?.taskBriefs)
  const tabs: PanelTab[] = [
    ...(briefsSupported ? (["brief"] as const) : []),
    "changes",
    ...(workflowsSupported ? (["workflows"] as const) : []),
  ]
  // What the person last asked for; the Brief is the opening choice. Features
  // load after first paint, so the choice is held even while it is unavailable.
  const [tab, setTab] = useState<PanelTab>("brief")
  const view = tabs.includes(tab) ? tab : "changes"

  // Both counts belong to the strip, so it reads the same from either tab.
  // Each is the query the pane below already makes — one key, one request.
  const diff = useDiff(taskId, archived).data
  const changes = diff?.kind === "ok" ? changedFileCount(parsedDiff(diff).files, diff.untracked) : undefined
  const workflows = useTaskWorkflows(taskId, workflowsSupported).data
  const attached = workflows?.filter((w) => w.state !== "completed").length ?? 0

  // Handed to the VISIBLE pane only: the hidden one keeps its own plain label,
  // so there is never a second tablist in the tree.
  const strip = tabs.length > 1 ? (
    <div role="tablist" aria-label="Task panel" className="flex items-center gap-0.5">
      {tabs.map((name) => (
        <Tab
          key={name}
          role="tab"
          size={touch ? "lg" : "sm"}
          active={view === name}
          aria-selected={view === name}
          count={name === "changes" ? changes : name === "workflows" ? attached || undefined : undefined}
          onClick={() => setTab(name)}
        >
          {LABEL[name]}
        </Tab>
      ))}
    </div>
  ) : undefined

  // The strip depends on which surfaces the daemon has. Painting before that
  // is known opens on Changes, then jumps to the Brief when features arrive.
  // A failed features read falls through to Changes, as it always did.
  if (features.isPending) return <div className="h-full min-h-0 flex-1" />

  return (
    // h-full AND flex-1: this root fills a resizable panel (which sets a
    // height) as well as a flex column (which does not) — frontend reference §6b
    <div className="flex h-full min-h-0 flex-1 flex-col">
      {briefsSupported && (
        <BriefPane
          // a task's brief belongs to ONE task on ONE daemon; the prefix keeps
          // it apart from its sibling, whose key would otherwise be identical
          key={`brief:${connectionId}:${taskId ?? ""}`}
          task={task}
          header={view === "brief" ? strip : undefined}
          hidden={view !== "brief"}
          touch={touch}
        />
      )}
      {/* Keyed like its siblings: a diff that broke rendering one task must not
          still show that fallback once the panel points at another. */}
      <PaneErrorBoundary key={`changes:${connectionId}:${taskId ?? ""}`} label="the changes">
        <ChangesPane
          taskId={taskId}
          archived={archived}
          onRefresh={onRefresh}
          header={view === "changes" ? strip : undefined}
          hidden={view !== "changes"}
          touch={touch}
        />
      </PaneErrorBoundary>
      {workflowsSupported && (
        <WorkflowsPane
          // a drill-down belongs to ONE task on ONE daemon: switching either
          // must not leave a half-filled form pointing at the wrong place
          key={`workflows:${connectionId}:${taskId ?? ""}`}
          task={task}
          header={view === "workflows" ? strip : undefined}
          hidden={view !== "workflows"}
          touch={touch}
        />
      )}
    </div>
  )
}
