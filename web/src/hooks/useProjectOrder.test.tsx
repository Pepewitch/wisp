import { QueryClient } from "@tanstack/react-query"
import { act, renderHook, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { useProjectOrder } from "./useProjectOrder"
import { createConnectionQueryKeys } from "@/lib/query"
import { ApiError, type DaemonTransport } from "@/lib/transport"
import type { RepoInfo } from "@/lib/types"
import { fakeDaemonTransport, runtimeWrapper } from "@/test/runtime"

const repo = (path: string, configured = true): RepoInfo => ({
  path,
  name: null,
  exists: true,
  setupScript: "",
  archiveScript: "",
  copyFiles: [],
  baseBranch: "",
  configured,
})

const REPOS = [repo("/src/alpha"), repo("/src/beta"), repo("/src/gamma"), repo("/elsewhere/history", false)]
const reposKey = createConnectionQueryKeys("test-connection").repos

/** A daemon whose PUT waits for the test to answer it, so the optimistic order can be read first. */
function setup(enabled = true) {
  let answer!: { resolve: (value: unknown) => void; reject: (error: unknown) => void }
  const request = vi.fn(
    (path: string, init?: { method?: string }) =>
      path === "/api/repos/order" && init?.method === "PUT"
        ? new Promise((resolve, reject) => (answer = { resolve, reject }))
        : Promise.resolve({ repos: REPOS }),
  )
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(reposKey, { repos: REPOS })
  const transport = fakeDaemonTransport("test-connection", { request: request as DaemonTransport["request"] })
  const { result } = renderHook(() => useProjectOrder(enabled), { wrapper: runtimeWrapper(transport, client) })
  const order = () => client.getQueryData<{ repos: RepoInfo[] }>(reposKey)!.repos.map((r) => r.path)
  return { result, request, order, answer: () => answer }
}

describe("useProjectOrder", () => {
  it("offers nothing when the daemon cannot save an order", () => {
    expect(setup(false).result.current).toBeUndefined()
  })

  it("moves the sidebar at once, then saves the order with the daemon", async () => {
    const { result, request, order, answer } = setup()

    act(() => result.current!.onReorder(["/src/gamma", "/src/alpha", "/src/beta"]))

    await waitFor(() => expect(order()).toEqual(["/src/gamma", "/src/alpha", "/src/beta", "/elsewhere/history"]))
    expect(request).toHaveBeenCalledWith("/api/repos/order", {
      method: "PUT",
      body: { paths: ["/src/gamma", "/src/alpha", "/src/beta"] },
    })
    await act(async () => answer().resolve({ paths: ["/src/gamma", "/src/alpha", "/src/beta"] }))
    expect(result.current!.error).toBeNull()
  })

  it("a refusal puts the old order back and says why, until dismissed", async () => {
    const { result, order, answer } = setup()

    act(() => result.current!.onReorder(["/src/beta", "/src/alpha", "/src/gamma"]))
    await waitFor(() => expect(order()[0]).toBe("/src/beta"))
    await act(async () =>
      answer().reject(new ApiError("The project list changed since it was loaded. Reload and try again. (missing: /src/delta)", 409)),
    )

    await waitFor(() => expect(order()).toEqual(["/src/alpha", "/src/beta", "/src/gamma", "/elsewhere/history"]))
    expect(result.current!.error).toBe(
      "Could not save the project order: The project list changed since it was loaded. Reload and try again. (missing: /src/delta)",
    )
    act(() => result.current!.onDismissError())
    await waitFor(() => expect(result.current!.error).toBeNull())
  })
})
