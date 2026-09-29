import { Dialog } from "@base-ui/react/dialog"

import { Button, POPOVER_SURFACE } from "@/components/primitives"
import { cn } from "@/lib/utils"

/**
 * Asked before a daemon update that would interrupt running turns. The
 * daemon's `409` names how many tasks; the update itself is unchanged.
 */
export function UpdateInterruptDialog({
  running,
  onCancel,
  onConfirm,
}: {
  /** Tasks with a running turn; null keeps the dialog closed. */
  running: number | null
  onCancel: () => void
  onConfirm: () => void
}) {
  const tasks = running === 1 ? "1 task is" : `${running ?? 0} tasks are`
  return (
    <Dialog.Root open={running !== null} onOpenChange={(next) => !next && onCancel()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-(--z-backdrop) bg-scrim" />
        <Dialog.Popup
          className={cn(
            "fixed top-[24vh] left-1/2 z-(--z-modal) w-[min(460px,calc(100vw-3rem))] -translate-x-1/2",
            POPOVER_SURFACE,
            "rounded-xl p-5 shadow-modal outline-none"
          )}
        >
          <Dialog.Title className="text-[14.5px] font-semibold tracking-[-0.01em]">
            Interrupt running tasks?
          </Dialog.Title>
          <Dialog.Description className="mt-2 text-[12px] leading-relaxed text-fg-secondary">
            {tasks} running. Updating restarts the Wisp daemon, which interrupts{" "}
            {running === 1 ? "its turn" : "their turns"}.
          </Dialog.Description>
          <div className="mt-4 flex justify-end gap-2">
            <Button size="lg" onClick={onCancel}>
              Cancel
            </Button>
            <Button size="lg" tone="destructive" onClick={onConfirm}>
              Update anyway
            </Button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
