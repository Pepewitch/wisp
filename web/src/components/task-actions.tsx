import { TaskRetentionDialog } from "./task-retention-dialog"
import { useState } from "react"

import { ArchiveConfirmDialog } from "@/components/archive-flow"
import { More } from "@/components/icons"
import { Menu, MenuCheckboxItem, MenuItem, MenuNote, MenuSeparator } from "@/components/menu"
import { RenameTaskDialog } from "@/components/rename-task-dialog"
import { useAutopilot } from "@/hooks/mutations"
import { useHarnessFeatures } from "@/hooks/queries"
import { useArchiveFlow } from "@/hooks/useArchiveFlow"
import { failureReason } from "@/lib/api"
import { useDaemonRuntime } from "@/lib/runtime"
import type { ApiTask } from "@/lib/types"
import { uiIntentsFor } from "@/lib/ui-intents"

/**
 * The task verbs that are not worth a permanent button: find, rename and
 * archive — and auto-merge, a switch you flip once and then read on the PR
 * line, which is where its reason lives while it waits.
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
        <AutoMergeItems task={task} />
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

/**
 * Auto-merge's own group: the switch, naming the PR it is bound to, the one
 * reason it is waiting, and the single action a pause or a Stop hold asks for.
 * Every control is a menu row, so touch and keyboard reach all of them.
 */
function AutoMergeItems({ task }: { task: ApiTask }) {
  const features = useHarnessFeatures()
  const autopilot = useAutopilot()
  if (!features.data?.taskAutopilot || task.archived) return null
  const status = task.autopilot
  const armed = status?.autoMerge === true
  const local = task.mode === "local"
  const set = (autoMerge?: boolean) => autopilot.mutate({ id: task.id, autoMerge })
  return (
    <>
      <MenuSeparator />
      <MenuCheckboxItem checked={armed} disabled={local || autopilot.isPending} onCheckedChange={(checked) => set(checked)}>
        {armed && status?.pr ? `Auto-merge #${status.pr}` : "Auto-merge"}
      </MenuCheckboxItem>
      {local && <MenuNote>Needs a worktree task: this one runs in the project checkout.</MenuNote>}
      {/* the reason while it is on; and when Wisp itself switched it off, why */}
      {status && (armed || (status.reason !== "" && status.reason !== "Auto-merge off")) && (
        <div className="max-w-[280px]">
          <MenuNote>{status.state === "paused" ? `Paused — ${status.reason}` : status.reason}</MenuNote>
        </div>
      )}
      {armed && status?.state === "paused" && <MenuItem keepOpen disabled={autopilot.isPending} onClick={() => set()}>Resume</MenuItem>}
      {armed && status?.state === "held" && <MenuItem keepOpen disabled={autopilot.isPending} onClick={() => set()}>Continue now</MenuItem>}
      {autopilot.error && <div className="max-w-[280px]"><MenuNote>{failureReason(autopilot.error)}</MenuNote></div>}
    </>
  )
}

