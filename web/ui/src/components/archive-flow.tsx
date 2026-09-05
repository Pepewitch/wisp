import { Dialog } from "@base-ui/react/dialog"

import { Button, POPOVER_SURFACE } from "@/components/primitives"
import type { ApiTask } from "@/lib/types"
import { cn } from "@/lib/utils"

/**
 * The archive refusal, as a dialog. Rendered by all three places that archive
 * (the overflow menu, the sidebar row's hover control, `/archive`), so the
 * refusal reads identically wherever the verb was reached from. Its state comes
 * from `useArchiveFlow` (hooks/useArchiveFlow.ts).
 *
 * Portalled and unmounted while `reason` is null, so a row that is not
 * refusing anything contributes nothing to the document.
 */
export function ArchiveConfirmDialog({
  task,
  reason,
  pending,
  onCancel,
  onForce,
}: {
  task: ApiTask
  /** the daemon's sentence; null closes the dialog */
  reason: string | null
  pending: boolean
  onCancel: () => void
  onForce: () => void
}) {
  return (
    <Dialog.Root open={reason !== null} onOpenChange={(open) => !open && onCancel()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-(--z-backdrop) bg-black/60" />
        <Dialog.Popup
          className={cn(
            "fixed top-[24vh] left-1/2 z-(--z-modal) w-[min(460px,calc(100vw-3rem))] -translate-x-1/2",
            POPOVER_SURFACE,
            "rounded-xl p-5 shadow-modal outline-none",
          )}
        >
          <Dialog.Title className="text-[14.5px] font-semibold tracking-[-0.01em]">
            Archive {task.title.slice(0, 40)}
            {task.title.length > 40 && "…"}?
          </Dialog.Title>
          {/* the daemon's own sentence, verbatim: it names what is unsaved
              and what the remedies are, which is the whole decision */}
          <p className="mt-2 text-[12px] leading-relaxed text-fg-secondary">{reason}</p>
          <p className="mt-2 text-[11.5px] leading-relaxed text-muted-foreground">
            {task.mode === "local"
              ? "This task runs in the project directory, so archiving only files it — nothing is removed."
              : "Forcing commits any uncommitted work onto the branch (it is never discarded) and then removes the worktree. The branch is kept, so the commit is where you will find that work."}
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <Button type="button" size="lg" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="button" size="lg" tone="primary" disabled={pending} onClick={onForce}>
              {pending ? "Archiving…" : "Archive anyway"}
            </Button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
