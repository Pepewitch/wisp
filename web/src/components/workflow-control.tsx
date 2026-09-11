import { useState } from "react"
import { Dialog } from "@base-ui/react/dialog"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import type { Workflow, WorkflowDefinition, WorkflowDetail, WorkflowParams } from "../../../shared/workflows"
import { useHarnessFeatures } from "@/hooks/queries"
import { useDaemonRuntime } from "@/lib/runtime"
import { failureReason } from "@/lib/api"
import { fromNow as since } from "@/lib/time"
import type { ApiTask } from "@/lib/types"
import { Button, POPOVER_SURFACE } from "./primitives"
import { WorkflowForm } from "./workflow-form"

export function WorkflowControl({ task, prUrl }: { task: ApiTask; prUrl?: string }) {
  const features = useHarnessFeatures()
  const { connectionId } = useDaemonRuntime()
  if (!features.data?.taskWorkflows) return null
  return <ConnectedWorkflows key={`${connectionId}:${task.id}`} task={task} prUrl={prUrl} />
}

function ConnectedWorkflows({ task, prUrl }: { task: ApiTask; prUrl?: string }) {
  const runtime = useDaemonRuntime()
  const [open, setOpen] = useState(false)
  const items = useQuery({
    queryKey: [...runtime.qk.task(task.id), "workflows"],
    queryFn: () => runtime.transport.request<Workflow[]>(`/api/tasks/${task.id}/workflows`),
  })
  const active = items.data?.filter(w => w.state === "active").length ?? 0
  const paused = items.data?.filter(w => w.state === "paused").length ?? 0
  return (
    <>
      <Button onClick={() => setOpen(true)} size="sm" className="touch:min-h-11" aria-label="Task workflows">
        <span aria-hidden className={`size-1.5 rounded-full border-2 ${active ? "border-state-background" : "border-faint"}`} />
        Workflows{active ? ` · ${active} active` : paused ? ` · ${paused} paused` : ""}
      </Button>
      {items.error && <span role="alert" className="text-[11.5px] text-destructive">{failureReason(items.error)}</span>}
      {open && <WorkflowDialog key={`${runtime.connectionId}:${task.id}`} task={task} prUrl={prUrl} items={items.data ?? []} onClose={() => setOpen(false)} />}
    </>
  )
}

function WorkflowDialog({ task, prUrl, items, onClose }: { task: ApiTask; prUrl?: string; items: Workflow[]; onClose: () => void }) {
  const { transport, qk } = useDaemonRuntime()
  const client = useQueryClient()
  const [selected, setSelected] = useState<string | null>(null)
  const [editing, setEditing] = useState<Workflow | undefined>()
  const [history, setHistory] = useState<string | null>(null)
  const types = useQuery({
    queryKey: [...qk.connection, "workflow-types"],
    queryFn: () => transport.request<WorkflowDefinition[]>("/api/workflow-types"),
  })
  const detail = useQuery({
    queryKey: [...qk.task(task.id), "workflows", history],
    queryFn: () => transport.request<WorkflowDetail>(`/api/workflows/${history}`),
    enabled: !!history,
  })
  const mutation = useMutation({
    mutationFn: ({ path, method, body }: { path: string; method: "POST" | "PATCH"; body: unknown }) => transport.request(path, { method, body }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: [...qk.task(task.id), "workflows"] })
      setSelected(null)
      setEditing(undefined)
    },
  })
  const definition = types.data?.find(d => d.id === selected)
  const act = (item: Workflow, action: string) => mutation.mutate({ path: `/api/workflows/${item.id}/${action}`, method: "POST", body: {} })
  const save = (params: WorkflowParams) => mutation.mutate(editing
    ? { path: `/api/workflows/${editing.id}`, method: "PATCH", body: { revision: editing.revision, params } }
    : { path: `/api/tasks/${task.id}/workflows`, method: "POST", body: { type: selected, params } })
  const error = mutation.error ?? types.error ?? detail.error
  return (
    <Dialog.Root open onOpenChange={value => { if (!value && !mutation.isPending) onClose() }}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-(--z-backdrop) bg-scrim" />
        <Dialog.Popup className={`fixed top-1/2 left-1/2 z-(--z-modal) max-h-[calc(100dvh-2rem)] w-[min(640px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl p-5 shadow-modal outline-none [&_button]:touch:min-h-11 ${POPOVER_SURFACE}`}>
          <div className="flex items-center justify-between gap-3">
            <Dialog.Title className="text-[14.5px] font-semibold">Task workflows</Dialog.Title>
            <Button disabled={mutation.isPending} onClick={onClose}>Close</Button>
          </div>
          <Dialog.Description className="mt-1 text-[12.5px] text-muted-foreground">{task.title}. Wisp waits; your agent acts when needed.</Dialog.Description>
          <div className="mt-5">
            {definition ? (
              <WorkflowForm key={`${definition.id}:${editing?.id ?? "new"}`} definition={definition} existing={editing} prUrl={prUrl}
                pending={mutation.isPending} onSubmit={save} onCancel={() => { setSelected(null); setEditing(undefined); mutation.reset() }} />
            ) : (
              <>
                {!task.archived && (
                  <div className="space-y-1">
                    <p className="mb-2 text-[12px] font-medium">Add a workflow</p>
                    {types.isPending && <p role="status" className="text-[12px] text-muted-foreground">Loading workflows…</p>}
                    {types.data?.map(def => (
                      <button key={def.id} type="button" aria-label={`Add ${def.name}`} disabled={mutation.isPending}
                        onClick={() => { setSelected(def.id); setEditing(undefined); setHistory(null); mutation.reset() }}
                        className="block w-full rounded-lg px-3 py-3 text-left hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none">
                        <span className="block text-[12.5px] font-medium">{def.name}</span>
                        <span className="mt-1 block text-[11.5px] leading-relaxed text-muted-foreground">{def.description}</span>
                      </button>
                    ))}
                  </div>
                )}
                <div className="mt-5 border-t border-border pt-4">
                  <h3 className="text-[12px] font-medium">Attached workflows</h3>
                  {!items.length && <p className="mt-3 text-[12.5px] leading-relaxed text-muted-foreground">No workflows yet. Choose one above to keep this task moving without checking in yourself.</p>}
                  {items.map(item => (
                    <section key={item.id} className="border-b border-border py-4 last:border-0">
                      <div className="flex items-center gap-2 text-[12.5px] font-medium">
                        <span aria-hidden className={`size-1.5 rounded-full border-2 ${item.state === "active" ? "border-state-background" : "border-faint"}`} />
                        {types.data?.find(d => d.id === item.type)?.name ?? item.type}
                        <span className="ml-auto text-[11.5px] font-normal text-muted-foreground">{item.state === "active" ? "Active" : item.state === "paused" ? "Paused" : "Completed"}</span>
                      </div>
                      <p className="mt-1.5 text-[12px] leading-relaxed text-fg-secondary">{item.reason}</p>
                      <p className="mt-1.5 text-[11.5px] text-muted-foreground">
                        {item.lastCheckedAt ? `Checked ${since(item.lastCheckedAt)}` : "Not checked yet"} · {item.wakeCount}/{String(item.params.maxWakeups)} wake-ups
                      </p>
                      {item.state === "active" && <p className="mt-1 text-[11.5px] text-muted-foreground">Next check: {new Date(item.nextCheckAt).toLocaleString()}</p>}
                      <div className="mt-2 flex flex-wrap gap-1">
                        {item.state !== "completed" && !task.archived && <>
                          <Button disabled={mutation.isPending} onClick={() => act(item, item.state === "active" ? "pause" : "resume")}>{item.state === "active" ? "Pause" : "Resume"}</Button>
                          <Button disabled={mutation.isPending} onClick={() => { setSelected(item.type); setEditing(item); mutation.reset() }}>Configure</Button>
                          <Button disabled={mutation.isPending} onClick={() => act(item, "complete")}>Complete</Button>
                        </>}
                        <Button onClick={() => setHistory(history === item.id ? null : item.id)} aria-expanded={history === item.id}>History</Button>
                      </div>
                      {history === item.id && (
                        <div className="mt-2 space-y-2 border-l border-border pl-3">
                          {detail.isPending && <p role="status" className="text-[12px] text-muted-foreground">Loading history…</p>}
                          {detail.data?.history.map(entry => <p key={entry.id} className="text-[11.5px] leading-relaxed text-muted-foreground"><span title={entry.at}>{since(entry.at)}</span> · {entry.detail}</p>)}
                        </div>
                      )}
                    </section>
                  ))}
                </div>
                <p className="mt-3 text-[11.5px] leading-relaxed text-muted-foreground">Runs while this daemon and its host are awake, even with the app closed. Stop turn pauses automation. Closing this window does not.</p>
              </>
            )}
          </div>
          {error && <p role="alert" className="mt-3 text-[12px] text-destructive">{failureReason(error)}</p>}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
