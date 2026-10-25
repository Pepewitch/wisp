import { QueryClient } from "@tanstack/react-query"
import { act, render, screen, waitFor } from "@testing-library/react"
import { useState } from "react"
import { describe, expect, it, vi } from "vitest"

import { createConnectionQueryKeys } from "@/lib/query"
import type { ApiTask } from "@/lib/types"
import { fakeDaemonTransport, runtimeWrapper } from "@/test/runtime"

import { useLiveTasks, useTasks } from "./queries"

/**
 * A reader of the live list (a parent's title, a subtask count) shares the
 * list's query. Re-rendering only the reader must not leave that query
 * unable to refetch: the next refresh still asks the daemon and lands.
 */
describe("a reader of the live task list", () => {
  it("never stops the list's own refresh, and never fetches on its own", async () => {
    let rows: ApiTask[] = [{ id: "t1", title: "first" } as ApiTask]
    const request = vi.fn(async (path: string) => (path === "/api/tasks?cleanup=1" ? rows : {}))
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    let bump = () => {}
    function Owner() {
      const tasks = useTasks(false)
      return <div data-testid="owner">{tasks.error ? `error: ${String(tasks.error)}` : (tasks.data ?? []).map((t) => t.title).join(",")}</div>
    }
    function Reader() {
      const [n, setN] = useState(0)
      bump = () => setN((x) => x + 1)
      const count = useLiveTasks((tasks) => tasks.length).data
      return <div data-testid="reader">{`${count ?? "-"}:${n}`}</div>
    }
    render(<><Owner /><Reader /></>, { wrapper: runtimeWrapper(fakeDaemonTransport("test-connection", { request: request as never }), client) })
    await waitFor(() => expect(screen.getByTestId("owner")).toHaveTextContent("first"))
    expect(request).toHaveBeenCalledTimes(1)
    // only the reader re-renders, then the list is invalidated (an SSE task event)
    act(() => bump())
    rows = [{ id: "t1", title: "first" } as ApiTask, { id: "t2", title: "second" } as ApiTask]
    await act(() => client.invalidateQueries({ queryKey: createConnectionQueryKeys("test-connection").tasksList(false) }))
    await waitFor(() => expect(screen.getByTestId("owner")).toHaveTextContent("first,second"))
    expect(screen.getByTestId("reader")).toHaveTextContent("2:1")
    expect(request).toHaveBeenCalledTimes(2)
  })
})
