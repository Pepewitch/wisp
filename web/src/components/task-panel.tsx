import { useState } from "react"

import { ChangesPane } from "@/components/changes-pane"
import { Tab } from "@/components/primitives"
import { WorkflowsPane } from "@/components/workflows-pane"
import { useDiff, useHarnessFeatures, useTaskWorkflows } from "@/hooks/queries"
import { changedFileCount, parseDiff } from "@/lib/diff"
import { useDaemonRuntime } from "@/lib/runtime"
import type { ApiTask } from "@/lib/types"

/**
 * The right column's upper panel. Two views of the same task's durable state:
 * **Changes**, and the **Workflows** watching it.
 *
 * The frontend reference said Changes "keeps a tab's shape so Checks can slot
 * in beside it later". Workflows is the sibling that arrived first. It belongs
 * here rather than behind a button under the task header, because an armed
 * workflow is standing state you want to SEE: the button only said how many
 * were active, and "what is it waiting for?" cost a modal over the whole app.
 *
 * Both panes stay mounted. Switching to Workflows and back must not close the
 * diff you had open — the same rule the mobile shell's tabs already follow.
 *
 * An older daemon without `taskWorkflows` gets no strip at all: one pane, its
 * own label, exactly as before.
 */
export function TaskPanel({
  task,
  taskId,
  archived,
  prUrl,
  onRefresh,
  touch = false,
}: {
  task: ApiTask | null
  taskId: string | null
  archived: boolean
  prUrl?: string
  onRefresh?: () => void
  touch?: boolean
}) {
  const { connectionId } = useDaemonRuntime()
  const features = useHarnessFeatures()
  const supported = Boolean(features.data?.taskWorkflows)
  const [tab, setTab] = useState<"changes" | "workflows">("changes")
  const view = supported ? tab : "changes"

  // Both counts belong to the strip, so it reads the same from either tab.
  // Each is the query the pane below already makes — one key, one request.
  const diff = useDiff(taskId, archived).data
  const changes = diff?.kind === "ok" ? changedFileCount(parseDiff(diff.diff).files, diff.untracked) : undefined
  const workflows = useTaskWorkflows(taskId, supported).data
  const attached = workflows?.filter((w) => w.state !== "completed").length ?? 0

  // Handed to the VISIBLE pane only: the hidden one keeps its own plain label,
  // so there is never a second tablist in the tree.
  const strip = supported ? (
    <div role="tablist" aria-label="Task panel" className="flex items-center gap-0.5">
      {(["changes", "workflows"] as const).map((name) => (
        <Tab
          key={name}
          role="tab"
          size={touch ? "lg" : "sm"}
          active={view === name}
          aria-selected={view === name}
          count={name === "changes" ? changes : attached || undefined}
          onClick={() => setTab(name)}
        >
          {name === "changes" ? "Changes" : "Workflows"}
        </Tab>
      ))}
    </div>
  ) : undefined

  return (
    // h-full AND flex-1: this root fills a resizable panel (which sets a
    // height) as well as a flex column (which does not) — frontend reference §6b
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <ChangesPane
        taskId={taskId}
        archived={archived}
        onRefresh={onRefresh}
        header={view === "changes" ? strip : undefined}
        hidden={view !== "changes"}
        touch={touch}
      />
      {supported && (
        <WorkflowsPane
          // a drill-down belongs to ONE task on ONE daemon: switching either
          // must not leave a half-filled form pointing at the wrong place
          key={`${connectionId}:${taskId ?? ""}`}
          task={task}
          prUrl={prUrl}
          header={view === "workflows" ? strip : undefined}
          hidden={view !== "workflows"}
          touch={touch}
        />
      )}
    </div>
  )
}
