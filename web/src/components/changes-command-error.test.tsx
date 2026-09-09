import { render, screen, waitFor } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { sameOriginWebTransport } from "@/lib/web-transport"
import { createDesktopTransport } from "@/lib/desktop-transport"
import { runtimeWrapper } from "@/test/runtime"
import { ChangesPane } from "./changes-pane"

afterEach(() => vi.unstubAllGlobals())

it.each([
  ["browser", "git diff timed out after 20s and was stopped"],
  ["desktop", "git diff timed out after 20s and was stopped"],
  ["browser", "git diff: command cleanup incomplete: process termination could not be confirmed before the cleanup deadline"],
  ["desktop", "git diff: command cleanup incomplete: process termination could not be confirmed before the cleanup deadline"],
] as const)("replaces loading with a command failure through %s: %s", async (runtime, message) => {
  let answer!: (response: Response) => void
  const fetcher = vi.fn<typeof fetch>(() => new Promise(resolve => { answer = resolve }))
  vi.stubGlobal("fetch", fetcher)
  const transport = runtime === "browser" ? sameOriginWebTransport
    : createDesktopTransport("http://127.0.0.1:45678/fixture-capability", "remote-fixture", 1)
  render(<ChangesPane taskId="tfixture" archived={false} />, { wrapper: runtimeWrapper(transport) })
  expect(screen.getByText("Reading the worktree…")).toBeInTheDocument()
  await waitFor(() => expect(fetcher).toHaveBeenCalledOnce())
  expect(fetcher.mock.calls[0]?.[0]).toBe(runtime === "browser" ? "/api/tasks/tfixture/diff"
    : "http://127.0.0.1:45678/fixture-capability/connections/remote-fixture/1/api/tasks/tfixture/diff")
  answer(new Response(JSON.stringify({ error: message }), { status: 500 }))
  expect(await screen.findByText(message)).toHaveClass("text-destructive")
  expect(screen.queryByText("Reading the worktree…")).toBeNull()
  expect(screen.queryByText("No changes in this worktree yet")).toBeNull()
})
