import type { DaemonTransport } from "@/lib/transport"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { CleanupPanel } from "./cleanup-panel"
import { Sidebar } from "./sidebar"
import { MobileShell } from "./mobile-shell"
import { sameOriginWebTransport } from "@/lib/web-transport"
import { createDesktopTransport } from "@/lib/desktop-transport"
import { DaemonRuntimeProvider } from "@/lib/runtime"
import { fakeDaemonTransport, runtimeWrapper } from "@/test/runtime"
import type { ApiTask } from "@/lib/types"
import { inertProjectSearch } from "@/test/project-search"

const TASK = { id: "tfixture", title: "Archive fixture", state: "done", archived: true,
  cleanup: { state: "needs-attention", step: "Project archive script", error: "The script may have partially completed. Check its effects before continuing.",
    retryAt: null, revision: 8, uncertain: true, confirmStopped: false } } as ApiTask
afterEach(() => vi.unstubAllGlobals())

it.each(["browser", "desktop"] as const)("shows the recovery decision and actionable refusal through %s", async runtime => {
  const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ error: "Cleanup changed. Refresh this task before choosing an action." }), { status: 409 }))
  vi.stubGlobal("fetch", fetcher)
  const transport = runtime === "browser" ? sameOriginWebTransport : createDesktopTransport("http://127.0.0.1:45678/fixture", "remote-fixture", 1)
  render(<CleanupPanel task={TASK} />, { wrapper: runtimeWrapper(transport) })
  expect(screen.getByText(/Cleanup needs attention/)).toBeInTheDocument()
  expect(screen.queryByRole("button", { name: "Retry cleanup" })).toBeNull()
  fireEvent.click(screen.getByRole("button", { name: "Rerun script…" }))
  expect(screen.getByRole("dialog")).toHaveTextContent("Running it again can repeat those effects")
  expect(fetcher).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole("button", { name: "Rerun script" }))
  expect(await screen.findByRole("alert")).toHaveTextContent("Refresh this task")
  expect(fetcher.mock.calls[0]?.[0]).toBe(runtime === "browser" ? "/api/tasks/tfixture/cleanup"
    : "http://127.0.0.1:45678/fixture/connections/remote-fixture/1/api/tasks/tfixture/cleanup")
  expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({ action: "rerun", revision: 8, confirmStopped: false })
})

it("requires the legacy stopped-process check before confirming scripts completed", async () => {
  const request = vi.fn(async () => ({}))
  render(<CleanupPanel task={{ ...TASK, cleanup: { ...TASK.cleanup!, confirmStopped: true } }} />, { wrapper: runtimeWrapper(fakeDaemonTransport("fixture", { request: request as DaemonTransport["request"] })) })
  fireEvent.click(screen.getByRole("button", { name: "Confirm script completed…" }))
  const confirm = screen.getByRole("button", { name: "Confirmed, continue cleanup" })
  expect(confirm).toBeDisabled()
  fireEvent.click(screen.getByRole("checkbox"))
  fireEvent.click(confirm)
  await waitFor(() => expect(request).toHaveBeenCalledWith("/api/tasks/tfixture/cleanup", { method: "POST", body: { action: "confirm", revision: 8, confirmStopped: true } }))
})

it("keeps a delayed cleanup response scoped to the Desktop connection that initiated it", async () => {
  let answer!: (value: unknown) => void
  const first = fakeDaemonTransport("first", { request: vi.fn(() => new Promise<unknown>(resolve => { answer = resolve })) as DaemonTransport["request"] })
  const second = fakeDaemonTransport("second", { request: vi.fn(async () => ({})) as DaemonTransport["request"] })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const invalidate = vi.spyOn(client, "invalidateQueries")
  const task = { ...TASK, cleanup: { ...TASK.cleanup!, uncertain: false, step: "Remove workspace" } }
  const view = (transport: typeof first) => <QueryClientProvider client={client}><DaemonRuntimeProvider transport={transport}><CleanupPanel task={task} /></DaemonRuntimeProvider></QueryClientProvider>
  const rendered = render(view(first))
  fireEvent.click(screen.getByRole("button", { name: "Retry cleanup" }))
  rendered.rerender(view(second))
  answer({})
  await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ["first", "tasks"] }))
  expect(second.request).not.toHaveBeenCalled()
  expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ["second", "tasks"] })
})

it.each([false, true])("shows incomplete archived tasks with history hidden (touch=%s)", touch => {
  render(<Sidebar groups={[]} archivedTasks={[TASK]} status={{}} pullRequests={{}} selectedId={null} onSelect={() => {}}
    showArchived={false} onShowArchivedChange={() => {}} onNewTask={() => {}} onConfigureProject={() => {}} search={inertProjectSearch()} error={null} loading={false} touch={touch} />,
  { wrapper: runtimeWrapper(fakeDaemonTransport()) })
  expect(screen.getByText("Cleanup")).toBeInTheDocument()
  expect(screen.getByText("Archive fixture")).toBeInTheDocument()
  expect(screen.getByRole("img", { name: "Cleanup needs attention" })).toBeInTheDocument()
  expect(screen.getByRole("switch", { name: "Show archived" })).toHaveAttribute("aria-checked", "false")
})

it("offers recovery in the phone shell where the desktop task header is absent", () => {
  render(<MobileShell task={TASK} sidebar={() => null} conversation={null} changes={null} terminal={null} composer={null} />,
    { wrapper: runtimeWrapper(fakeDaemonTransport()) })
  expect(screen.getByRole("region", { name: "Archive cleanup" })).toBeInTheDocument()
  fireEvent.click(screen.getByRole("button", { name: "Rerun script…" }))
  expect(screen.getByRole("dialog")).toHaveTextContent("Running it again can repeat those effects")
})

it("shows a safe retry schedule and the captured log", async () => {
  const request = vi.fn(async () => ({ log: "fixture script output" }))
  render(<CleanupPanel task={{ ...TASK, cleanup: { ...TASK.cleanup!, state: "pending", uncertain: false, step: "Remove workspace", retryAt: "2026-01-01T12:00:00Z" } }} />,
    { wrapper: runtimeWrapper(fakeDaemonTransport("fixture", { request: request as DaemonTransport["request"] })) })
  expect(screen.getByText(/Wisp will retry at/)).toBeInTheDocument()
  fireEvent.click(screen.getByRole("button", { name: "View script log" }))
  expect(await screen.findByText("fixture script output")).toBeInTheDocument()
})
