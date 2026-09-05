import { useEffect, useRef, useState } from "react"
import { Dialog } from "@base-ui/react/dialog"

import { Button, POPOVER_SURFACE } from "@/components/primitives"
import { useRenameTask } from "@/hooks/mutations"
import { failureReason } from "@/lib/api"
import type { ApiTask } from "@/lib/types"
import { cn } from "@/lib/utils"

const TASK_TITLE_MAX = 80

export function RenameTaskDialog({
  task,
  open,
  onOpenChange,
}: {
  task: ApiTask
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-(--z-backdrop) bg-black/60" />
        <Dialog.Popup
          className={cn(
            "fixed top-[24vh] left-1/2 z-(--z-modal) w-[min(460px,calc(100vw-3rem))] -translate-x-1/2",
            POPOVER_SURFACE,
            "rounded-xl shadow-modal outline-none",
          )}
        >
          {open && <RenameTaskForm key={task.id} task={task} onClose={() => onOpenChange(false)} />}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function RenameTaskForm({ task, onClose }: { task: ApiTask; onClose: () => void }) {
  const [title, setTitle] = useState(task.title)
  const input = useRef<HTMLInputElement>(null)
  const rename = useRenameTask()
  const cleaned = title.trim()
  const ready = cleaned !== "" && cleaned !== task.title && !rename.isPending

  useEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [])

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        if (!ready) return
        rename.mutate({ id: task.id, title: cleaned }, { onSuccess: onClose })
      }}
    >
      <div className="border-b border-border px-4 py-3">
        <Dialog.Title className="text-[14.5px] font-semibold tracking-[-0.01em]">Rename task</Dialog.Title>
      </div>

      <div className="px-4 py-3.5">
        <label className="flex flex-col gap-1.5 text-[11.5px] font-medium text-fg-secondary">
          Task name
          <input
            ref={input}
            value={title}
            maxLength={TASK_TITLE_MAX}
            onChange={(event) => setTitle(event.target.value)}
            className={cn(
              "h-8 rounded-md border border-input bg-surface px-2.5 text-[12.5px] font-normal text-foreground",
              "focus:border-accent-dim focus:ring-2 focus:ring-ring/15 focus:outline-none",
            )}
          />
        </label>
      </div>

      {rename.error && <div className="px-4 pb-2 text-[11.5px] text-destructive">{failureReason(rename.error)}</div>}

      <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-2.5">
        <Button type="button" size="lg" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" size="lg" tone="primary" disabled={!ready}>
          {rename.isPending ? "Renaming…" : "Rename"}
        </Button>
      </div>
    </form>
  )
}
