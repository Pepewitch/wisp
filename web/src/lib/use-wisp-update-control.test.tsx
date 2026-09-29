import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { UpdateInterruptDialog } from "@/components/update-interrupt-dialog"
import { ApiError, type DaemonRequestOptions } from "@/lib/transport"
import type { UpdateStatus } from "@/lib/types"
import { useWispUpdateControl } from "@/lib/use-wisp-update-control"
import { fakeDaemonTransport, runtimeWrapper } from "@/test/runtime"

// the restart itself is out of scope: the update stays "restarting"
vi.mock("@/lib/update", () => ({
  waitForUpdatedDaemon: vi.fn(() => new Promise(() => undefined)),
}))

const STATUS: UpdateStatus = {
  currentVersion: "0.5.0",
  latestVersion: "0.5.1",
  currentApiProtocolVersion: 1,
  latestApiProtocolVersion: 1,
  state: "available",
  installMethod: "homebrew",
  canAutoUpdate: true,
  message: null,
  checkedAt: "2026-09-06T12:00:00Z",
}

function Harness() {
  const updates = useWispUpdateControl()
  return (
    <>
      {updates.desktop}
      {updates.dialog}
    </>
  )
}

/** A daemon with `running` busy tasks: it refuses an unforced update, as the real route does. */
function renderWithDaemon(running: number) {
  const posts: unknown[] = []
  const transport = fakeDaemonTransport("local", {
    request: async <T,>(_path: string, options?: DaemonRequestOptions) => {
      if (options?.method !== "POST") return STATUS as T
      posts.push(options.body)
      if (running > 0 && !(options.body as { force?: boolean }).force) {
        const error = `${running} tasks have a running turn that restarting Wisp would interrupt`
        throw new ApiError(error, 409, null, { error, running })
      }
      return { ...STATUS, state: "installing" } as T
    },
  })
  render(<Harness />, { wrapper: runtimeWrapper(transport) })
  return posts
}

describe("updating the daemon while tasks are running", () => {
  it("names how many tasks the restart interrupts, and updates anyway once confirmed", async () => {
    const posts = renderWithDaemon(2)
    fireEvent.click(await screen.findByRole("button", { name: "Update daemon 0.5.1" }))

    const dialog = await screen.findByRole("dialog")
    expect(dialog).toHaveTextContent("2 tasks are running")
    expect(dialog).toHaveTextContent("interrupts their turns")
    expect(posts).toEqual([{ version: "0.5.1" }])

    fireEvent.click(screen.getByRole("button", { name: "Update anyway" }))
    await waitFor(() =>
      expect(posts).toEqual([{ version: "0.5.1" }, { version: "0.5.1", force: true }])
    )
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    expect(await screen.findByRole("button", { name: "Updating daemon…" })).toBeDisabled()
  })

  it("Cancel leaves the daemon running and reports no failure", async () => {
    const posts = renderWithDaemon(1)
    fireEvent.click(await screen.findByRole("button", { name: "Update daemon 0.5.1" }))
    await screen.findByRole("dialog")

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    expect(posts).toEqual([{ version: "0.5.1" }])
    expect(screen.queryByText("Daemon update failed")).toBeNull()
    expect(screen.getByRole("button", { name: "Update daemon 0.5.1" })).toBeEnabled()
  })

  it("asks nothing when no task is running", async () => {
    const posts = renderWithDaemon(0)
    fireEvent.click(await screen.findByRole("button", { name: "Update daemon 0.5.1" }))
    await waitFor(() => expect(posts).toEqual([{ version: "0.5.1" }]))
    expect(screen.queryByRole("dialog")).toBeNull()
  })

  it("speaks of one task in the singular", () => {
    render(<UpdateInterruptDialog running={1} onCancel={() => undefined} onConfirm={() => undefined} />)
    expect(screen.getByRole("dialog")).toHaveTextContent(
      "1 task is running. Updating restarts the Wisp daemon, which interrupts its turn."
    )
  })
})
