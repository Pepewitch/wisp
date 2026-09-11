import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import { WorkflowControl } from "./workflow-control"
import { WorkflowForm } from "./workflow-form"
import { sameOriginWebTransport } from "@/lib/web-transport"
import { createDesktopTransport } from "@/lib/desktop-transport"
import { fakeDaemonTransport, runtimeWrapper } from "@/test/runtime"
import { DaemonRuntimeProvider } from "@/lib/runtime"
import { QueryClientProvider } from "@tanstack/react-query"
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
  render(<WorkflowControl task={task} prUrl="https://github.com/example/project/pull/42" />, { wrapper: runtimeWrapper(transport) })
  fireEvent.click(await screen.findByRole("button", { name: "Task workflows" }))
  fireEvent.click(await screen.findByRole("button", { name: "Add PR review watch" }))
  expect(screen.getByRole("textbox", { name: "Pull request URL" })).toHaveValue("https://github.com/example/project/pull/42")
  expect(screen.getByRole("spinbutton", { name: "Stop after quiet (minutes)" })).toHaveValue(30)
  fireEvent.change(screen.getByRole("textbox", { name: "When new feedback arrives" }), { target: { value: "Fix nits and run tests." } })
  fireEvent.click(screen.getByRole("button", { name: "Arm workflow" }))
  await waitFor(() => expect(fetcher.mock.calls.some(([, init]) => init?.method === "POST")).toBe(true))
  const call = fetcher.mock.calls.find(([, init]) => init?.method === "POST")!
  expect(String(call[0])).toBe(runtime === "browser"
    ? `/api/tasks/${task.id}/workflows`
    : `http://127.0.0.1:45678/fixture/connections/remote-fixture/1/api/tasks/${task.id}/workflows`)
  expect(JSON.parse(String(call[1]?.body))).toEqual({
    type: "pr-review", params: { prUrl: "https://github.com/example/project/pull/42", prompt: "Fix nits and run tests.", everyMinutes: 2, quietMinutes: 30, allowPush: false },
  })
})

it("shows status and history without treating quiet completion as approval", async () => {
  const request = vi.fn(async (path: string) => path === "/api/harnesses" ? { features: { taskWorkflows: true } }
    : path === "/api/workflow-types" ? [definition]
    : path === "/api/workflows/wfixture" ? { workflow: item, history: [{ id: 1, at: item.createdAt, kind: "completed", detail: "No new feedback for 30 minutes. This does not mean approval.", messageId: null }] }
    : [item])
  render(<WorkflowControl task={task} />, { wrapper: runtimeWrapper(fakeDaemonTransport("fixture", { request: request as DaemonTransport["request"] })) })
  fireEvent.click(await screen.findByRole("button", { name: "Task workflows" }))
  expect(await screen.findByText("Waiting for feedback")).toBeInTheDocument()
  expect(screen.getByText(/2\/20 wake-ups/)).toBeInTheDocument()
  fireEvent.click(screen.getByRole("button", { name: "History" }))
  expect(await screen.findByText(/This does not mean approval/)).toBeInTheDocument()
  fireEvent.click(screen.getByRole("button", { name: "Pause" }))
  await waitFor(() => expect(request).toHaveBeenCalledWith("/api/workflows/wfixture/pause", { method: "POST", body: {} }))
})

it("does not offer workflows to an older daemon", async () => {
  const request = vi.fn(async () => ({ features: {} }))
  render(<WorkflowControl task={task} />, { wrapper: runtimeWrapper(fakeDaemonTransport("old", { request: request as DaemonTransport["request"] })) })
  await waitFor(() => expect(request).toHaveBeenCalled())
  expect(screen.queryByRole("button", { name: "Task workflows" })).not.toBeInTheDocument()
  expect(request).toHaveBeenCalledTimes(1)
})

it("closes an open form when switching daemon connections with the same task ID", async () => {
  const request = vi.fn(async (path: string) => path === "/api/harnesses" ? { features: { taskWorkflows: true } } : path === "/api/workflow-types" ? [definition] : [])
  const a = fakeDaemonTransport("a", { request: request as DaemonTransport["request"] })
  const b = fakeDaemonTransport("b", { request: request as DaemonTransport["request"] })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = (transport: DaemonTransport) => <QueryClientProvider client={client}><DaemonRuntimeProvider transport={transport}><WorkflowControl task={task} /></DaemonRuntimeProvider></QueryClientProvider>
  const rendered = render(view(a))
  fireEvent.click(await screen.findByRole("button", { name: "Task workflows" }))
  expect(await screen.findByRole("dialog")).toBeInTheDocument()
  rendered.rerender(view(b))
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
})

it("keeps an edited PR pinned and permits explicit push authorization", () => {
  const submit = vi.fn()
  render(<WorkflowForm definition={definition} existing={{ ...item, params: { ...item.params, prUrl: "https://github.com/example/project/pull/42" } }} pending={false} onSubmit={submit} onCancel={() => {}} />)
  expect(screen.getByRole("textbox", { name: "Pull request URL" })).toBeDisabled()
  fireEvent.click(screen.getByText("Limits, permissions, and filters"))
  const checkbox = within(screen.getByText("Allow pushing changes").closest("label")!).getByRole("checkbox")
  fireEvent.click(checkbox)
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }))
  expect(submit).toHaveBeenCalledWith(expect.objectContaining({ allowPush: true }))
})
