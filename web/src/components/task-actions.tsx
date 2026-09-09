import { TaskRetentionDialog } from "./task-retention-dialog"
import { useState } from "react"

import { ArchiveConfirmDialog } from "@/components/archive-flow"
import { More } from "@/components/icons"
import { Menu, MenuItem } from "@/components/menu"
import { RenameTaskDialog } from "@/components/rename-task-dialog"
import { useArchiveFlow } from "@/hooks/useArchiveFlow"
import { useDaemonRuntime } from "@/lib/runtime"
import type { ApiTask } from "@/lib/types"
import { uiIntentsFor } from "@/lib/ui-intents"

/**
 * The task verbs that are not worth a permanent button: find, rename and
 * archive.
 * Stop/steer lives in the composer; Push stays in the header because it has a
 * consequence at the moment you are reading a task. Fresh session is a slash
 * command in the composer (`/fresh`).
 *
 * Archive goes through the shared flow (hooks/useArchiveFlow.ts) so the refusal
 * reads the same here, on a sidebar row's hover control and behind `/archive`.
 */
export function TaskActions({ task }: { task: ApiTask }) {
  const runtime = useDaemonRuntime()
  const [menuOpen, setMenuOpen] = useState(false)
  const [retentionOpen, setRetentionOpen] = useState(false)
  const [renameOpen, setRenameOpen] = useState(false)
  const archive = useArchiveFlow(task)

  return (
    <>
      <Menu
        label="More actions"
        icon={<More />}
        iconOnly
        align="end"
        open={menuOpen}
        onOpenChange={setMenuOpen}
      >
        {/* The keyboard is the primary way in; the menu is how you FIND that
            there is a keyboard way in, so the row carries the chord. */}
        <MenuItem
          hint="⌘F"
          onClick={() => {
            setMenuOpen(false)
            uiIntentsFor(runtime.connectionId).openFind()
          }}
        >
          Find in task
        </MenuItem>
        <MenuItem
          onClick={() => {
            setMenuOpen(false)
            setRenameOpen(true)
          }}
        >
          Rename
        </MenuItem>
        <MenuItem
          onClick={() => {
            setMenuOpen(false)
            archive.request(false)
          }}
          disabled={task.archived}
        >
          Archive
        </MenuItem>
        {task.archived && task.attachmentsRetained !== undefined && (
          <MenuItem
            onClick={() => {
              setMenuOpen(false)
              setRetentionOpen(true)
            }}
          >
            Export or delete task data…
          </MenuItem>
        )}
      </Menu>

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

      <ArchiveConfirmDialog
        task={task}
        reason={archive.reason}
        pending={archive.pending}
        onCancel={archive.dismiss}
        onForce={() => archive.request(true)}
      />
    </>
  )
}
