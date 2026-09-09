import { CLEANUP_LABEL } from "@/lib/state"
import { useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { Dialog } from "@base-ui/react/dialog"
import { Button, POPOVER_SURFACE } from "./primitives"
import { useDaemonRuntime } from "@/lib/runtime"
import type { ApiTask, CleanupSummary } from "@/lib/types"
import { cn } from "@/lib/utils"

export function CleanupPanel({ task }: { task: ApiTask }) {
  const { connectionId } = useDaemonRuntime()
  return task.cleanup ? <CleanupRecovery key={`${connectionId}:${task.id}`} task={task} cleanup={task.cleanup} /> : null
}

function CleanupRecovery({ task, cleanup }: { task: ApiTask; cleanup: CleanupSummary }) {
  const { transport, qk } = useDaemonRuntime()
  const client = useQueryClient()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [log, setLog] = useState<string | null>(null)
  const [checked, setChecked] = useState(false)
  const [decision, setDecision] = useState<{ action: "confirm" | "rerun"; revision: number; legacy: boolean; step: string } | null>(null)
  const refresh = () => Promise.all([
    client.invalidateQueries({ queryKey: qk.task(task.id) }),
    client.invalidateQueries({ queryKey: qk.tasks }),
  ])
  async function act(action: "retry" | "confirm" | "rerun", revision: number, confirmStopped = false) {
    setPending(true); setError(null)
    try {
      await transport.request(`/api/tasks/${task.id}/cleanup`, { method: "POST", body: { action, revision, confirmStopped } })
      setDecision(null)
      await refresh()
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setPending(false) }
  }
  async function viewLog() {
    setError(null)
    try { setLog((await transport.request<{ log: string }>(`/api/tasks/${task.id}/cleanup`)).log) }
    catch (e) { setError(`Could not read the cleanup log: ${e instanceof Error ? e.message : String(e)}. Try again when Wisp is reachable.`) }
  }
  return <section aria-label="Archive cleanup" className="mt-2 text-[11.5px] leading-relaxed text-muted-foreground">
    <p className={cn(cleanup.state === "needs-attention" && "text-destructive")}>{CLEANUP_LABEL[cleanup.state]}{cleanup.state !== "complete" && ` · ${cleanup.step}`}</p>
    {cleanup.state !== "complete" && <>
      <p>The task is archived. Cleanup must finish before its remaining files can be removed.</p>
      {cleanup.uncertain && <p>The script may have already made changes. Check its effects before continuing.</p>}
      {cleanup.error && <p className="mt-1 break-words">{cleanup.error}</p>}
      {cleanup.retryAt && <p>Wisp will retry at {new Date(cleanup.retryAt).toLocaleTimeString()}.</p>}
      <div className="mt-1.5 flex flex-wrap gap-2">
        {cleanup.uncertain ? <>
          <Button disabled={pending} onClick={() => { setChecked(false); setDecision({ action: "confirm", revision: cleanup.revision, legacy: cleanup.confirmStopped, step: cleanup.step }) }}>Confirm script completed…</Button>
          <Button disabled={pending} onClick={() => { setChecked(false); setDecision({ action: "rerun", revision: cleanup.revision, legacy: cleanup.confirmStopped, step: cleanup.step }) }}>Rerun script…</Button>
        </> : cleanup.state !== "running" && <Button disabled={pending} onClick={() => void act("retry", cleanup.revision)}>{pending ? "Retrying…" : "Retry cleanup"}</Button>}
        <Button onClick={() => void viewLog()}>View script log</Button>
        <Button onClick={() => void refresh()}>Refresh status</Button>
      </div>
    </>}
    {error && !decision && <p role="alert" className="mt-1 text-destructive">{error}</p>}
    {log !== null && <details open className="mt-2"><summary>Last script attempt (last 16 KiB)</summary><pre className="scroll-slim max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px]">{log}</pre></details>}
    <Dialog.Root open={decision !== null} onOpenChange={open => !open && !pending && setDecision(null)}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-(--z-backdrop) bg-scrim" />
        <Dialog.Popup className={cn(POPOVER_SURFACE, "fixed top-[20vh] left-1/2 z-(--z-modal) max-h-[70dvh] w-[min(460px,calc(100vw-3rem))] -translate-x-1/2 overflow-y-auto rounded-xl p-5 outline-none")}>
          <Dialog.Title className="text-[14.5px] font-semibold">{decision?.action === "confirm" ? "Confirm script completion" : "Rerun cleanup script?"}</Dialog.Title>
          <Dialog.Description className="mt-2 text-[12px] leading-relaxed text-fg-secondary">
            {decision?.step}. {decision?.action === "confirm" ? "Only continue if you verified the script completed its intended cleanup. Wisp will skip this script and continue removing the remaining files." : "The previous attempt may already have made changes. Running it again can repeat those effects. Review the script and its outcome first."}
          </Dialog.Description>
          {decision?.legacy && <label className="mt-3 flex gap-2 text-[12px]"><input type="checkbox" checked={checked} onChange={e => setChecked(e.target.checked)} />I verified both cleanup scripts and their child processes have stopped.</label>}
          {error && <p role="alert" className="mt-2 text-[12px] text-destructive">{error}</p>}
          <div className="mt-4 flex justify-end gap-2">
            <Button size="lg" disabled={pending} onClick={() => setDecision(null)}>Cancel</Button>
            <Button size="lg" tone="primary" disabled={pending || (decision?.legacy && !checked)} onClick={() => decision && void act(decision.action, decision.revision, checked)}>{pending ? "Checking…" : decision?.action === "confirm" ? "Confirmed, continue cleanup" : "Rerun script"}</Button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  </section>
}
