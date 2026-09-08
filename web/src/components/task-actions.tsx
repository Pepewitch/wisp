import { useState } from "react"

import { ArchiveConfirmDialog } from "@/components/archive-flow"
import { More } from "@/components/icons"
import { Menu, MenuItem } from "@/components/menu"
import { RenameTaskDialog } from "@/components/rename-task-dialog"
import { useArchiveFlow } from "@/hooks/useArchiveFlow"
import type { ApiTask } from "@/lib/types"

/**
 * The task verbs that are not worth a permanent button: rename and archive.
 * Stop/steer lives in the composer; Push stays in the header because it has a
 * consequence at the moment you are reading a task. Fresh session is a slash
 * command in the composer (`/fresh`).
 *
 * Archive goes through the shared flow (hooks/useArchiveFlow.ts) so the refusal
 * reads the same here, on a sidebar row's hover control and behind `/archive`.
 */
export function TaskActions({ task }: { task: ApiTask }) {
  const [renameOpen, setRenameOpen] = useState(false)
  const archive = useArchiveFlow(task)

  return (
    <>
      <Menu label="More actions" icon={<More />} iconOnly align="end">
        <MenuItem onClick={() => setRenameOpen(true)}>Rename</MenuItem>
        <MenuItem onClick={() => archive.request(false)} disabled={task.archived}>
          Archive
        </MenuItem>
      </Menu>

      <RenameTaskDialog task={task} open={renameOpen} onOpenChange={setRenameOpen} />

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
