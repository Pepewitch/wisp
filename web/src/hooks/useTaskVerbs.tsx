import { useState, type ReactNode } from "react"

import { ArchiveConfirmDialog } from "@/components/archive-flow"
import { NewSubtaskDialog } from "@/components/new-subtask-dialog"
import { RenameTaskDialog } from "@/components/rename-task-dialog"
import { TaskRetentionDialog } from "@/components/task-retention-dialog"
import { useHarnessFeatures } from "@/hooks/queries"
import { useArchiveFlow } from "@/hooks/useArchiveFlow"
import { useDaemonRuntime } from "@/lib/runtime"
import type { ApiTask } from "@/lib/types"
import { uiIntentsFor } from "@/lib/ui-intents"

/** The task verbs, as plain actions plus the dialogs they open: the title menu's items and the phone sheet's tiles are two faces of one set. */
export interface TaskVerbs {
  find: () => void
  rename: () => void
  /** null where a subtask cannot be started: on a subtask, an archived task, or a daemon without subtasks */
  newSubtask: (() => void) | null
  /** null once the task is archived */
  archive: (() => void) | null
  /** export or delete an archived task's kept data; null where there is none */
  retention: (() => void) | null
  /** mount these where they outlive the surface that opened them */
  dialogs: ReactNode
}

/**
 * Find, rename, a new subtask and archive. Archive goes through the shared
 * flow (hooks/useArchiveFlow.ts) so the refusal reads the same here, on a
 * sidebar row's hover control and behind `/archive`.
 */
export function useTaskVerbs(task: ApiTask): TaskVerbs {
  const runtime = useDaemonRuntime()
  const [retentionOpen, setRetentionOpen] = useState(false)
  const [renameOpen, setRenameOpen] = useState(false)
  const [subtaskOpen, setSubtaskOpen] = useState(false)
  const archive = useArchiveFlow(task)
  // a subtask has none of its own, and an archived task takes none
  const subtasks = useHarnessFeatures().data?.subtasks === true && !task.subtask_kind && !task.archived
  return {
    find: () => uiIntentsFor(runtime.connectionId).openFind(),
    rename: () => setRenameOpen(true),
    newSubtask: subtasks ? () => setSubtaskOpen(true) : null,
    archive: task.archived ? null : () => archive.request(false),
    retention: task.archived && task.attachmentsRetained !== undefined ? () => setRetentionOpen(true) : null,
    dialogs: (
      <>
        {retentionOpen && (
          <TaskRetentionDialog
            key={task.id}
            task={task}
            onClose={() => setRetentionOpen(false)}
          />
        )}
        <RenameTaskDialog
          task={task}
          open={renameOpen}
          onOpenChange={setRenameOpen}
        />
        {subtasks && <NewSubtaskDialog parent={task} open={subtaskOpen} onOpenChange={setSubtaskOpen} />}
        <ArchiveConfirmDialog task={task} flow={archive} />
      </>
    ),
  }
}
