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
        stopsAutopilot={archive.stopsAutopilot}
      />
    </>
  )
}

/**
 * Auto-merge and auto-fix: the two switches, the PR they are bound to, the one
 * reason they are waiting, and the single action a pending round, a pause, or
 * a Stop hold asks for. Every control is a menu row, so touch and keyboard
 * reach all of them.
 */
function AutoMergeItems({ task }: { task: ApiTask }) {
  const features = useHarnessFeatures()
  const autopilot = useAutopilot()
  if (!features.data?.taskAutopilot || task.archived) return null
  const status = task.autopilot
  const merge = status?.autoMerge === true
  const fix = status?.autoFix === true
  const armed = merge || fix
  const local = task.mode === "local"
  const busy = local || autopilot.isPending
  const act = (action: "resume" | "send-now" | "skip") => autopilot.mutate({ id: task.id, act: action })
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
      {/* the reason while it is on; and when Wisp itself switched it off, why */}
      {status && (armed || (status.reason !== "" && status.reason !== "Auto-merge off")) && (
        <div className="max-w-[280px]">
          <MenuNote>{status.state === "paused" ? `Paused — ${status.reason}` : status.reason}</MenuNote>
        </div>
      )}
      {armed && status && <AutopilotActions status={status} pending={autopilot.isPending} act={act} />}
      {autopilot.error && <div className="max-w-[280px]"><MenuNote>{failureReason(autopilot.error)}</MenuNote></div>}
    </>
  )
}

/** The one action the current state asks for: a pending round, a pause, or a Stop hold. */
function AutopilotActions({ status, pending, act }: {
  status: NonNullable<ApiTask["autopilot"]>
  pending: boolean
  act: (action: "resume" | "send-now" | "skip") => void
}) {
  if (status.state === "paused") return <MenuItem keepOpen disabled={pending} onClick={() => act("resume")}>Resume</MenuItem>
  if (status.state === "held") return <MenuItem keepOpen disabled={pending} onClick={() => act("resume")}>Continue now</MenuItem>
  if (!status.autoFix || !status.pendingFix) return null
  return (
    <>
      <MenuItem keepOpen disabled={pending} onClick={() => act("send-now")}>Send now</MenuItem>
      <MenuItem keepOpen disabled={pending} onClick={() => act("skip")}>Skip</MenuItem>
    </>
  )
}

