import { QueryClient, QueryClientProvider } from "@tanstack/react-query"

import type { Workflow, WorkflowDefinition, WorkflowDetail } from "../../../shared/workflows"
import { Tab } from "@/components/primitives"
import { WorkflowsPane } from "@/components/workflows-pane"
import { TASKS } from "@/lib/fixtures"
import { DaemonRuntimeProvider } from "@/lib/runtime"
import type { DaemonEventStream, DaemonTransport } from "@/lib/transport"

/**
 * The Workflows pane, rendered for real rather than mocked up: the same
 * component the right column mounts, fed by a transport that answers from
 * fixtures — populated beside empty, the two states a task is ever in.
 */

const TYPES: WorkflowDefinition[] = [
  {
    id: "schedule-steer",
    version: "1",
    name: "Schedule Steer",
    description: "Send one steer message at a chosen time, then complete.",
    parameters: [
      { key: "prompt", label: "Steer message", type: "string", default: "", required: true, multiline: true, description: "What should the agent know or do at the scheduled time?" },
      { key: "scheduledAt", label: "Scheduled time", type: "string", default: "", required: true, description: "An exact time with a UTC offset, stored as an instant." },
    ],
  },
  {
    id: "heartbeat",
    version: "1",
    name: "Heartbeat",
    description: "Revisit an objective on a timer. Each eligible check wakes the agent and can spend tokens.",
    parameters: [],
  },
]

const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString()
const base = {
  taskId: TASKS[0]!.id,
  version: "1",
  revision: 1,
  contextN: 1,
  checkCount: 18,
  expiresAt: at(-1400),
  createdAt: at(240),
  updatedAt: at(4),
}
const ITEMS: Workflow[] = [
  {
    ...base,
    id: "wf-beat",
    type: "heartbeat",
    params: { maxWakeups: 20, everyMinutes: 30 },
    state: "active",
    reason: "Waiting for task (running); no instruction queued",
    wakeCount: 2,
    lastCheckedAt: at(4),
    nextCheckAt: at(-26),
  },
  {
    ...base,
    id: "wf-steer",
    type: "schedule-steer",
    params: { scheduledAt: at(-90) },
    state: "paused",
    reason: "Paused when you stopped the turn",
    wakeCount: 0,
    lastCheckedAt: null,
    nextCheckAt: at(-90),
  },
  {
    ...base,
    id: "wf-done",
    type: "heartbeat",
    params: { maxWakeups: 20 },
    state: "completed",
    reason: "The agent reported the deployment healthy",
    wakeCount: 7,
    lastCheckedAt: at(96),
    nextCheckAt: at(96),
  },
]
const HISTORY: WorkflowDetail = {
  workflow: ITEMS[0]!,
  history: [
    { id: 3, at: at(4), kind: "wait", detail: "Waiting for task (running); no instruction queued", messageId: null },
    { id: 2, at: at(34), kind: "wake", detail: "Heartbeat due", messageId: "m2" },
    { id: 1, at: at(240), kind: "armed", detail: "Heartbeat", messageId: null },
  ],
}

const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })

// One client, so two panes on this page must not share a connection id — the
// query keys are connection-scoped and the empty specimen would otherwise read
// the populated one's cache.
function specimenTransport(connectionId: string, items: Workflow[]): DaemonTransport {
  return {
    connectionId,
    request: async <T,>(path: string) =>
      (path === "/api/workflow-types" ? TYPES : path.startsWith("/api/workflows/") ? HISTORY : items) as T,
    upload: async <T,>() => ({} as T),
    openEventStream: () => ({}) as DaemonEventStream,
    openWebSocket: () => ({}) as WebSocket,
    assetUrl: (path: string) => path,
    ensureReady: () => Promise.resolve(),
  }
}

function Framed({ id, items }: { id: string; items: Workflow[] }) {
  return (
    <div className="h-[340px] overflow-hidden rounded-lg border border-border bg-sidebar">
      <QueryClientProvider client={client}>
        <DaemonRuntimeProvider transport={specimenTransport(id, items)}>
          <WorkflowsPane task={TASKS[0]!} header={<Strip workflows={items.filter((w) => w.state !== "completed").length} />} />
        </DaemonRuntimeProvider>
      </QueryClientProvider>
    </div>
  )
}

/** The right column's real strip, so the pane is never shown without its tab. */
function Strip({ workflows }: { workflows: number }) {
  return (
    <div className="flex items-center gap-0.5">
      <Tab count={6}>Changes</Tab>
      <Tab active count={workflows || undefined}>
        Workflows
      </Tab>
    </div>
  )
}

export function WorkflowsPaneSpecimen() {
  return (
    <div className="grid grid-cols-2 gap-8">
      <div>
        <Framed id="gallery-running" items={ITEMS} />
        <p className="mt-2.5 text-[11.5px] leading-relaxed text-muted-foreground">
          Two lines a row: what is running, and what it is waiting for. That second line is the whole reason this
          left the task header — a button could only count the active ones. Completed work collapses into one line
          rather than accumulating obituaries, and{" "}
          <span className="font-medium text-foreground">Complete</span> — the same word{" "}
          <span className="font-mono">wisp workflow complete</span> uses — is what sends a row there.
        </p>
      </div>
      <div>
        <Framed id="gallery-empty" items={[]} />
        <p className="mt-2.5 text-[11.5px] leading-relaxed text-muted-foreground">
          Empty ends in the control, not in a noun. Creating one is a drill-down inside the pane — picker, then form, with a
          back row where a dialog would have put a close button. Nothing about starting a workflow opens an overlay, so
          the diff you were reading is one click away the whole time.
        </p>
      </div>
    </div>
  )
}
