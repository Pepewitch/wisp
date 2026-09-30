import { TaskRetentionDialog } from "./task-retention-dialog"
import { useState } from "react"

import { ArchiveConfirmDialog } from "@/components/archive-flow"
import { More } from "@/components/icons"
import { Menu, MenuCheckboxItem, MenuItem, MenuNote, MenuSeparator } from "@/components/menu"
import { RenameTaskDialog } from "@/components/rename-task-dialog"
import { useAutopilot } from "@/hooks/mutations"
import { useHarnessFeatures } from "@/hooks/queries"
import { useArchiveFlow } from "@/hooks/useArchiveFlow"
import { useBriefSwitch } from "@/hooks/useBriefSwitch"
import { failureReason } from "@/lib/api"
import { useDaemonRuntime } from "@/lib/runtime"
import type { ApiTask } from "@/lib/types"
import { uiIntentsFor } from "@/lib/ui-intents"

/**
 * The task verbs that are not worth a permanent button: find, rename and
 * archive — and the brief, auto-merge and auto-fix switches, as shortcuts.
 * What those switches are doing (the reason, the round waiting to send, the
 * pause to resume) lives in the Autopilot tab, which has the room for it.
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
        <BriefItems task={task} />
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
        stopsAutopilot={archive.stopsAutopilot}
      />
    </>
  )
}

/**
 * Task briefs: the switch alone. What switching does, and that it starts with
 * the NEXT turn, is said by the Autopilot tab's Brief section; a failed write
 * still shows here, on the control that sent it.
 */
function BriefItems({ task }: { task: ApiTask }) {
  const brief = useBriefSwitch(task)
  if (!brief.switchable) return null
  return (
    <>
      <MenuSeparator />
      <MenuCheckboxItem checked={brief.enabled} disabled={brief.disabled} onCheckedChange={brief.set}>
        Task brief
      </MenuCheckboxItem>
      {brief.error && <div className="max-w-[280px]"><MenuNote>{brief.error}</MenuNote></div>}
    </>
  )
}

/**
 * Auto-merge and auto-fix: the two switches and the PR they are bound to, as
 * a keyboard and quick-toggle shortcut. The reason they are waiting and the
 * one action it asks for (Send now / Skip, Resume, Continue now) are the
 * Autopilot tab's; a menu that repeats a paragraph is why that tab exists.
 */
function AutoMergeItems({ task }: { task: ApiTask }) {
  const features = useHarnessFeatures()
  const autopilot = useAutopilot()
  if (!features.data?.taskAutopilot || task.archived) return null
  const status = task.autopilot
  const merge = status?.autoMerge === true
  const fix = status?.autoFix === true
  const local = task.mode === "local"
  const busy = local || autopilot.isPending
  const set = (change: { autoMerge?: boolean; autoFix?: boolean }) => autopilot.mutate({ id: task.id, set: change })
  return (
    <>
      <MenuSeparator />
      <MenuCheckboxItem checked={merge} disabled={busy} onCheckedChange={(checked) => set({ autoMerge: checked })}>
        {merge && status?.pr ? `Auto-merge #${status.pr}` : "Auto-merge"}
      </MenuCheckboxItem>
      <MenuCheckboxItem checked={fix} disabled={busy} onCheckedChange={(checked) => set({ autoFix: checked })}>
        {fix && !merge && status?.pr ? `Auto-fix #${status.pr}` : "Auto-fix"}
      </MenuCheckboxItem>
      {local && <MenuNote>Needs a worktree task: this one runs in the project checkout.</MenuNote>}
      {autopilot.error && <div className="max-w-[280px]"><MenuNote>{failureReason(autopilot.error)}</MenuNote></div>}
    </>
  )
}
