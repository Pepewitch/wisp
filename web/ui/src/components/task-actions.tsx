import { useState } from "react"
import { Dialog } from "@base-ui/react/dialog"

import { ArchiveConfirmDialog } from "@/components/archive-flow"
import { More } from "@/components/icons"
import { Menu, MenuItem } from "@/components/menu"
import { Button, POPOVER_SURFACE } from "@/components/primitives"
import { RenameTaskDialog } from "@/components/rename-task-dialog"
import { useFreshSession } from "@/hooks/mutations"
import { useArchiveFlow } from "@/hooks/useArchiveFlow"
import { failureReason } from "@/lib/api"
import type { ApiTask } from "@/lib/types"
import { cn } from "@/lib/utils"

/**
 * The task verbs that are not worth a permanent button: rename, archive,
 * fresh session, copy branch. Stop/steer lives in the composer; Push stays in
 * the header because it has a consequence at the moment you are reading a task.
 *
 * Archive goes through the shared flow (hooks/useArchiveFlow.ts) so the refusal
 * reads the same here, on a sidebar row's hover control and behind `/archive`.
 *
 * ONE state per dialog. Until slice 4 a single `confirm` string did two jobs,
 * and a failed FRESH SESSION opened the ARCHIVE dialog — the daemon's "turn 2
 * is still running" under a title offering to archive the task, with an
 * "Archive anyway" button that would have done it. Two states, two dialogs.
 */
export function TaskActions({ task }: { task: ApiTask }) {
  const [renameOpen, setRenameOpen] = useState(false)
  const [freshError, setFreshError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const archive = useArchiveFlow(task)
  const freshSessionTask = useFreshSession()

  const freshSession = (): void => {
    freshSessionTask.mutate(task.id, { onError: (e) => setFreshError(failureReason(e)) })
  }

  const copyBranch = (): void => {
    if (!task.branch) return
    void navigator.clipboard?.writeText(task.branch).then(
      () => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1_200)
      },
      () => undefined, // a blocked clipboard costs a convenience, not a crash
    )
  }

  return (
    <>
      <Menu label="More actions" icon={<More />} iconOnly align="end">
        <MenuItem onClick={() => setRenameOpen(true)}>Rename</MenuItem>
        <MenuItem onClick={copyBranch} disabled={!task.branch} hint={copied ? "copied" : undefined}>
          Copy branch
        </MenuItem>
        <MenuItem
          onClick={freshSession}
          disabled={task.archived || task.state === "creating" || task.state === "running"}
          hint="next turn starts clean"
        >
          Fresh session
        </MenuItem>
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

      {/* a refused fresh session has nothing to confirm: the daemon's sentence
          IS the whole answer, so this dialog offers only to be closed */}
      <Dialog.Root open={freshError !== null} onOpenChange={(open) => !open && setFreshError(null)}>
        <Dialog.Portal>
          <Dialog.Backdrop className="fixed inset-0 z-(--z-backdrop) bg-black/60" />
          <Dialog.Popup
            className={cn(
              "fixed top-[24vh] left-1/2 z-(--z-modal) w-[min(460px,calc(100vw-3rem))] -translate-x-1/2",
              POPOVER_SURFACE,
              "rounded-xl p-5 shadow-modal outline-none",
            )}
          >
            <Dialog.Title className="text-[14.5px] font-semibold tracking-[-0.01em]">Fresh session</Dialog.Title>
            <p className="mt-2 text-[12px] leading-relaxed text-fg-secondary">{freshError}</p>
            <div className="mt-4 flex justify-end">
              <Button type="button" size="lg" onClick={() => setFreshError(null)}>
                Close
              </Button>
            </div>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  )
}
