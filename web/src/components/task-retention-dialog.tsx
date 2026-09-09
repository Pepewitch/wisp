import { useState } from "react"
import { Dialog } from "@base-ui/react/dialog"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Button, POPOVER_SURFACE } from "./primitives"
import { useDaemonRuntime } from "@/lib/runtime"
import { failureReason } from "@/lib/api"
import { clearAssetCache } from "@/lib/asset-src"
import { decodeTaskExport, saveTaskExport } from "@/lib/task-export"
import type { ApiTask } from "@/lib/types"

export function TaskRetentionDialog({
  task,
  onClose,
}: {
  task: ApiTask
  onClose: () => void
}) {
  const { transport, qk, connectionId } = useDaemonRuntime()
  const client = useQueryClient()
  const [confirmation, setConfirmation] = useState("")
  const [notice, setNotice] = useState("")
  const storage = useQuery({
    queryKey: [...qk.task(task.id), "storage"],
    queryFn: () =>
      transport.request<{ bytes: number; files: number }>(
        `/api/tasks/${task.id}/storage`
      ),
    retry: false,
  })
  const exporting = useMutation({
    mutationFn: async () => {
      const data = decodeTaskExport(
        await transport.request(`/api/tasks/${task.id}/export`)
      )
      if (data.task.id !== task.id)
        throw new Error(
          "The export does not match this task. Refresh and retry."
        )
      const saved = await saveTaskExport(task.id, JSON.stringify(data, null, 2))
      setNotice(
        saved
          ? `Export saved or sent to Downloads.${data.missing.length ? ` ${data.missing.length} unavailable files are listed in the export.` : ""}`
          : "Save cancelled. Your task is unchanged."
      )
    },
  })
  const deleting = useMutation({
    mutationFn: () =>
      transport.request(`/api/tasks/${task.id}/purge`, {
        method: "DELETE",
        body: { confirmTaskId: task.id },
      }),
    onSuccess: () => {
      clearAssetCache(connectionId, `/api/tasks/${task.id}/`)
      client.removeQueries({ queryKey: qk.task(task.id) })
      void client.invalidateQueries({ queryKey: qk.tasks })
      onClose()
    },
  })
  const busy = exporting.isPending || deleting.isPending
  const error = exporting.error || deleting.error
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-(--z-backdrop) bg-scrim" />
        <Dialog.Popup
          className={`fixed top-1/2 left-1/2 z-(--z-modal) max-h-[calc(100dvh-3rem)] w-[min(480px,calc(100vw-3rem))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl p-4 shadow-modal outline-none ${POPOVER_SURFACE}`}
        >
          <Dialog.Title className="text-[14.5px] font-semibold">
            Archived task data
          </Dialog.Title>
          <Dialog.Description className="mt-2 text-[12.5px] text-fg-secondary">
            {task.title}: the conversation and retained attachments stay in Wisp
            until you delete them.
          </Dialog.Description>
          <p className="mt-2 text-[12px]">
            {storage.data
              ? `${(storage.data.bytes / 1024 / 1024).toFixed(1)} MiB in ${storage.data.files} task files (database overhead excluded).`
              : storage.error
                ? `Storage estimate unavailable. ${failureReason(storage.error)}`
                : "Measuring task storage…"}
          </p>
          {!task.attachmentsRetained && (
            <p className="mt-2 text-[12px]">
              Attachments removed by an older version cannot be recovered here.
            </p>
          )}
          {task.deletionPending && (
            <p role="status" className="mt-2 text-[12px]">
              Deletion was interrupted. Some files may already be gone. Retry
              Delete permanently to finish.
            </p>
          )}
          <Button
            disabled={busy || task.deletionPending}
            onClick={() => exporting.mutate()}
            className="mt-3"
          >
            {exporting.isPending
              ? "Exporting…"
              : "Export conversation and files"}
          </Button>
          <p className="mt-2 text-[12px] text-fg-secondary">
            Portable JSON includes retained transcripts and attachments, up to
            32 MiB of files. It excludes repository code, Git history, and
            provider sessions. For a complete backup, follow the offline backup
            procedure in the documentation.
          </p>
          <p className="mt-4 text-[12px]">
            Permanent deletion removes this task’s Wisp records, logs, and
            attachments. The repository and Git branches are kept. Export
            anything you want to keep first.
          </p>
          <label className="mt-3 block text-[12px]">
            Type {task.id} to confirm deletion
            <input
              aria-label="Task ID to confirm deletion"
              value={confirmation}
              disabled={busy}
              onChange={(e) => setConfirmation(e.target.value)}
              className="mt-1 block w-full rounded border border-input bg-surface p-2"
            />
          </label>
          {notice && (
            <p role="status" className="mt-2 text-[12px]">
              {notice}
            </p>
          )}
          {error && (
            <p role="alert" className="mt-2 text-[12px] text-destructive">
              {failureReason(error)}
            </p>
          )}
          <div className="mt-4 flex justify-end gap-2">
            <Button disabled={busy} onClick={onClose}>
              Close
            </Button>
            <Button
              disabled={busy || confirmation !== task.id}
              onClick={() => deleting.mutate()}
            >
              {deleting.isPending ? "Deleting…" : "Delete permanently"}
            </Button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
