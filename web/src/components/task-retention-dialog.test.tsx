import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { TaskRetentionDialog } from "./task-retention-dialog"
import { sameOriginWebTransport } from "@/lib/web-transport"
import { createDesktopTransport } from "@/lib/desktop-transport"
import { runtimeWrapper, fakeDaemonTransport } from "@/test/runtime"
import type { ApiTask } from "@/lib/types"
import type { DaemonTransport } from "@/lib/transport"

const save = vi.hoisted(() => vi.fn(async () => true))
vi.mock("@/lib/task-export", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  saveTaskExport: save,
}))
const task = {
  id: "tfixture",
  title: "Retention fixture",
  state: "done",
  archived: true,
  attachmentsRetained: true,
} as ApiTask
afterEach(() => {
  vi.unstubAllGlobals()
  save.mockClear()
})

it.each(["browser", "desktop"] as const)(
  "requires task identity and shows retry instructions through %s",
  async (runtime) => {
    const fetcher = vi.fn<typeof fetch>(
      async (_url, init) =>
        new Response(
          JSON.stringify(
            init?.method === "DELETE"
              ? {
                  error:
                    "Check free disk space and file permissions, then retry deletion.",
                }
              : { bytes: 2048, files: 2 }
          ),
          { status: init?.method === "DELETE" ? 500 : 200 }
        )
    )
    vi.stubGlobal("fetch", fetcher)
    const transport =
      runtime === "browser"
        ? sameOriginWebTransport
        : createDesktopTransport(
            "http://127.0.0.1:45678/fixture",
            "remote-fixture",
            1
          )
    render(<TaskRetentionDialog task={task} onClose={() => {}} />, {
      wrapper: runtimeWrapper(transport),
    })
    const remove = screen.getByRole("button", { name: "Delete permanently" })
    expect(remove).toBeDisabled()
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: task.id },
    })
    fireEvent.click(remove)
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "then retry deletion"
    )
    const call = fetcher.mock.calls.find(
      ([, init]) => init?.method === "DELETE"
    )!
    expect(call[0]).toBe(
      runtime === "browser"
        ? "/api/tasks/tfixture/purge"
        : "http://127.0.0.1:45678/fixture/connections/remote-fixture/1/api/tasks/tfixture/purge"
    )
    expect(JSON.parse(String(call[1]?.body))).toEqual({
      confirmTaskId: task.id,
    })
    expect(remove).toBeEnabled()
  }
)

it("exports validated data and reports missing files without deleting anything", async () => {
  const data = {
    format: "wisp-task-export-v1",
    exportedAt: "fixture",
    task,
    turns: [],
    messages: [],
    files: [],
    missing: ["older attachment"],
  }
  const request = vi.fn(async (path: string) =>
    path.endsWith("/export") ? data : { bytes: 0, files: 0 }
  )
  render(<TaskRetentionDialog task={task} onClose={() => {}} />, {
    wrapper: runtimeWrapper(
      fakeDaemonTransport("fixture", {
        request: request as DaemonTransport["request"],
      })
    ),
  })
  fireEvent.click(
    screen.getByRole("button", { name: "Export conversation and files" })
  )
  await waitFor(() =>
    expect(save).toHaveBeenCalledWith(task.id, JSON.stringify(data, null, 2))
  )
  expect(await screen.findByRole("status")).toHaveTextContent(
    "1 unavailable files"
  )
  expect(request.mock.calls.some(([path]) => path.endsWith("/purge"))).toBe(
    false
  )
})

it("explains interrupted deletion and disables partial exports", () => {
  render(
    <TaskRetentionDialog
      task={{ ...task, deletionPending: true }}
      onClose={() => {}}
    />,
    { wrapper: runtimeWrapper(fakeDaemonTransport()) }
  )
  expect(screen.getByRole("status")).toHaveTextContent(
    "Retry Delete permanently"
  )
  expect(
    screen.getByRole("button", { name: "Export conversation and files" })
  ).toBeDisabled()
})
