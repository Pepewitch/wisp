import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { TaskPanel } from "./task-panel"
import { WorkflowsPane } from "./workflows-pane"
import { WorkflowForm } from "./workflow-form"
import { sameOriginWebTransport } from "@/lib/web-transport"
import { createDesktopTransport } from "@/lib/desktop-transport"
import { fakeDaemonTransport, runtimeWrapper } from "@/test/runtime"
import { DaemonRuntimeProvider } from "@/lib/runtime"
import { TASKS } from "@/lib/fixtures"
import type { DaemonTransport } from "@/lib/transport"
import type { Workflow, WorkflowDefinition } from "../../../shared/workflows"

const definition: WorkflowDefinition = {
  id: "pr-review", version: "1", name: "PR review watch",
  description: "Watch comments and nits without polling with an agent.",
  parameters: [
    { key: "prUrl", label: "Pull request URL", type: "string", default: "", required: true, description: "" },
    { key: "prompt", label: "When new feedback arrives", type: "string", default: "Fix valid nits.", multiline: true, description: "" },
    { key: "everyMinutes", label: "Check every (minutes)", type: "number", default: 2, min: 1, max: 1440, description: "" },
    { key: "quietMinutes", label: "Stop after quiet (minutes)", type: "number", default: 30, min: 5, max: 1440, description: "" },
    { key: "allowPush", label: "Allow pushing changes", type: "boolean", default: false, description: "" },
  ],
}
const task = { ...TASKS[0]!, state: "done" as const }
const item: Workflow = {
  id: "wfixture", taskId: task.id, type: definition.id, version: "1", params: { maxWakeups: 20, ...Object.fromEntries(definition.parameters.map(p => [p.key, p.default])) },
  state: "active", reason: "Waiting for feedback", revision: 1, contextN: 1, wakeCount: 2, checkCount: 5,
  lastCheckedAt: new Date().toISOString(), nextCheckAt: new Date().toISOString(),
  expiresAt: "2026-12-01T00:00:00Z", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
}
afterEach(() => vi.unstubAllGlobals())

it.each(["browser", "desktop"] as const)("arms a parameterized review watch through the %s transport", async runtime => {
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    const path = String(url)
    const data = path.endsWith("/api/harnesses") ? { harnesses: [], features: { taskWorkflows: true } }
      : path.endsWith("/api/workflow-types") ? [definition]
      : init?.method === "POST" ? item : []
    return new Response(JSON.stringify(data), { status: 200 })
  })
  vi.stubGlobal("fetch", fetcher)
  const transport = runtime === "browser" ? sameOriginWebTransport : createDesktopTransport("http://127.0.0.1:45678/fixture", "remote-fixture", 1)
  render(<WorkflowsPane task={task} prUrl="https://github.com/example/project/pull/42" />, { wrapper: runtimeWrapper(transport) })
  fireEvent.click(await screen.findByRole("button", { name: "New workflow…" }))
  fireEvent.click(await screen.findByRole("button", { name: "Choose PR review watch" }))
  expect(screen.getByRole("textbox", { name: "Pull request URL" })).toHaveValue("https://github.com/example/project/pull/42")
  expect(screen.getByRole("spinbutton", { name: "Stop after quiet (minutes)" })).toHaveValue(30)
  fireEvent.change(screen.getByRole("textbox", { name: "When new feedback arrives" }), { target: { value: "Fix nits and run tests." } })
  fireEvent.click(screen.getByRole("button", { name: "Start" }))
  await waitFor(() => expect(fetcher.mock.calls.some(([, init]) => init?.method === "POST")).toBe(true))
  const call = fetcher.mock.calls.find(([, init]) => init?.method === "POST")!
  expect(String(call[0])).toBe(runtime === "browser"
    ? `/api/tasks/${task.id}/workflows`
    : `http://127.0.0.1:45678/fixture/connections/remote-fixture/1/api/tasks/${task.id}/workflows`)
  expect(JSON.parse(String(call[1]?.body))).toEqual({
    type: "pr-review", params: { prUrl: "https://github.com/example/project/pull/42", prompt: "Fix nits and run tests.", everyMinutes: 2, quietMinutes: 30, allowPush: false },
  })
})

it("opens a row for its numbers and history without treating quiet completion as approval", async () => {
  const request = vi.fn(async (path: string) => path === "/api/workflow-types" ? [definition]
    : path === "/api/workflows/wfixture" ? { workflow: item, history: [{ id: 1, at: item.createdAt, kind: "completed", detail: "No new feedback for 30 minutes. This does not mean approval.", messageId: null }] }
    : [item])
  render(<WorkflowsPane task={task} />, { wrapper: runtimeWrapper(fakeDaemonTransport("fixture", { request: request as DaemonTransport["request"] })) })
  // the row's own two lines answer "what is armed, and what is it waiting for"
  // before anything is clicked — that is the whole point of the pane
  expect(await screen.findByText("Waiting for feedback")).toBeInTheDocument()
  expect(screen.queryByText(/wake-ups/)).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole("button", { name: /PR review watch/ }))
  expect(await screen.findByText(/2\/20 wake-ups/)).toBeInTheDocument()
  expect(await screen.findByText(/This does not mean approval/)).toBeInTheDocument()
  fireEvent.click(screen.getByRole("button", { name: "Pause" }))
  await waitFor(() => expect(request).toHaveBeenCalledWith("/api/workflows/wfixture/pause", { method: "POST", body: {} }))
})

it("completes a workflow with the CLI's own verb, and files it under Completed", async () => {
  const request = vi.fn(async (path: string) => path === "/api/workflow-types" ? [definition]
    : path === "/api/workflows/wfixture" ? { workflow: item, history: [] }
    : [{ ...item, state: "completed", reason: "Stopped" }])
  render(<WorkflowsPane task={task} />, { wrapper: runtimeWrapper(fakeDaemonTransport("fixture", { request: request as DaemonTransport["request"] })) })
  // completing is not deleting: the row leaves the live list for a collapsed
  // group, so the history that explains it survives
  expect(await screen.findByText("Completed · 1")).toBeInTheDocument()
  fireEvent.click(await screen.findByRole("button", { name: /PR review watch/ }))
  // and a completed workflow is read-only — nothing acts on it
  expect(screen.queryByRole("button", { name: "Complete" })).not.toBeInTheDocument()
  expect(screen.queryByRole("button", { name: "Pause" })).not.toBeInTheDocument()
})

it("puts adding in the list rather than in the tab strip", async () => {
  // A `+` at the right end of a tab row is the universal "new tab" affordance,
  // and the Terminal pane one divider down uses exactly that for new shells.
  // The control belongs beside the things it adds to.
  const request = vi.fn(async (path: string) => path === "/api/workflow-types" ? [definition] : [item])
  render(<WorkflowsPane task={task} header={<div role="tablist" aria-label="Task panel" />} />, {
    wrapper: runtimeWrapper(fakeDaemonTransport("fixture", { request: request as DaemonTransport["request"] })),
  })
  const add = await screen.findByRole("button", { name: "New workflow…" })
  expect(within(screen.getByRole("tablist")).queryByRole("button")).toBeNull()
  fireEvent.click(add)
  expect(await screen.findByRole("button", { name: "Choose PR review watch" })).toBeInTheDocument()
})

it("ends its empty state in the control, not in a noun", async () => {
  const request = vi.fn(async (path: string) => path === "/api/workflow-types" ? [definition] : [])
  render(<WorkflowsPane task={task} />, { wrapper: runtimeWrapper(fakeDaemonTransport("fixture", { request: request as DaemonTransport["request"] })) })
  fireEvent.click(await screen.findByRole("button", { name: "New workflow…" }))
  expect(await screen.findByRole("button", { name: "Choose PR review watch" })).toBeInTheDocument()
})

const EMPTY_DIFF = { diff: "", untracked: [], base: null, worktreeReason: null }

it("tabs Workflows beside Changes in the right column", async () => {
  const request = vi.fn(async (path: string) => path === "/api/harnesses" ? { features: { taskWorkflows: true } }
    : path === "/api/workflow-types" ? [definition]
    : path.endsWith("/diff") ? EMPTY_DIFF
    : [item])
  render(<TaskPanel task={task} taskId={task.id} archived={false} />, {
    wrapper: runtimeWrapper(fakeDaemonTransport("new", { request: request as unknown as DaemonTransport["request"] })),
  })
  const tabs = await screen.findByRole("tablist", { name: "Task panel" })
  // the count is on the strip, so "is anything watching this?" is answered
  // from the Changes tab without switching
  await waitFor(() => expect(within(tabs).getByRole("tab", { name: /Workflows/ })).toHaveTextContent("1"))
  fireEvent.click(within(tabs).getByRole("tab", { name: /Workflows/ }))
  expect(await screen.findByText("Waiting for feedback")).toBeInTheDocument()
  expect(screen.getByRole("tab", { name: /Changes/ })).toBeInTheDocument()
})

it("offers no strip, and asks for no workflows, on an older daemon", async () => {
  const request = vi.fn(async (path: string) => path === "/api/harnesses" ? { features: {} }
    : path.endsWith("/diff") ? EMPTY_DIFF
    : [])
  render(<TaskPanel task={task} taskId={task.id} archived={false} />, {
    wrapper: runtimeWrapper(fakeDaemonTransport("old", { request: request as unknown as DaemonTransport["request"] })),
  })
  await waitFor(() => expect(request).toHaveBeenCalled())
  expect(screen.queryByRole("tablist", { name: "Task panel" })).not.toBeInTheDocument()
  expect(await screen.findByText("Changes")).toBeInTheDocument()
  expect(request.mock.calls.some(([path]) => String(path).includes("/workflows"))).toBe(false)
})

it("drops a half-filled form when the daemon changes under the same task ID", async () => {
  const request = vi.fn(async (path: string) => path === "/api/harnesses" ? { features: { taskWorkflows: true } }
    : path === "/api/workflow-types" ? [definition]
    : path.endsWith("/diff") ? { diff: "", untracked: [], base: null, worktreeReason: null }
    : [])
  const a = fakeDaemonTransport("a", { request: request as unknown as DaemonTransport["request"] })
  const b = fakeDaemonTransport("b", { request: request as unknown as DaemonTransport["request"] })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = (transport: DaemonTransport) => (
    <QueryClientProvider client={client}>
      <DaemonRuntimeProvider transport={transport}>
        <TaskPanel task={task} taskId={task.id} archived={false} />
      </DaemonRuntimeProvider>
    </QueryClientProvider>
  )
  const rendered = render(view(a))
  fireEvent.click(await screen.findByRole("tab", { name: /Workflows/ }))
  fireEvent.click(await screen.findByRole("button", { name: "New workflow…" }))
  fireEvent.click(await screen.findByRole("button", { name: "Choose PR review watch" }))
  expect(screen.getByRole("button", { name: "Start" })).toBeInTheDocument()
  rendered.rerender(view(b))
  await waitFor(() => expect(screen.queryByRole("button", { name: "Start" })).not.toBeInTheDocument())
})

it("keeps an edited PR pinned and permits explicit push authorization", () => {
  const submit = vi.fn()
  render(<WorkflowForm definition={definition} existing={{ ...item, params: { ...item.params, prUrl: "https://github.com/example/project/pull/42" } }} pending={false} onSubmit={submit} onCancel={() => {}} />)
  expect(screen.getByRole("textbox", { name: "Pull request URL" })).toBeDisabled()
  fireEvent.click(screen.getByText("Limits and permissions"))
  const checkbox = within(screen.getByText("Allow pushing changes").closest("label")!).getByRole("checkbox")
  fireEvent.click(checkbox)
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }))
  expect(submit).toHaveBeenCalledWith(expect.objectContaining({ allowPush: true }))
})
