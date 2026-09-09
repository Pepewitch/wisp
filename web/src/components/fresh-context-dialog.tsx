import { Dialog } from "@base-ui/react/dialog"

import { Button, POPOVER_SURFACE } from "@/components/primitives"
import type { TaskAgentChoice } from "@/components/task-agent-picker"
import { cn } from "@/lib/utils"

export function FreshContextDialog({
  choice,
  open,
  pending,
  onCancel,
  onConfirm,
}: {
  choice: TaskAgentChoice
  open: boolean
  pending: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && onCancel()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-(--z-backdrop) bg-scrim" />
        <Dialog.Popup
          className={cn(
            "fixed top-[24vh] left-1/2 z-(--z-modal) w-[min(460px,calc(100vw-3rem))] -translate-x-1/2",
            POPOVER_SURFACE,
            "rounded-xl p-5 shadow-modal outline-none",
          )}
        >
          <Dialog.Title className="text-[14.5px] font-semibold tracking-[-0.01em]">
            Start with fresh context?
          </Dialog.Title>
          <p className="mt-2 text-[12px] leading-relaxed text-fg-secondary">
            Switching to {choice.harness} · <span className="font-mono">{choice.model}</span> starts a new harness
            session. The existing conversation stays visible, but the new harness will not receive its context.
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <Button size="lg" onClick={onCancel}>
              Cancel
            </Button>
            <Button size="lg" tone="primary" disabled={pending} onClick={onConfirm}>
              {pending ? "Starting…" : "Start fresh"}
            </Button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
