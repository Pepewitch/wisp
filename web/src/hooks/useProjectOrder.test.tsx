import { QueryClient } from "@tanstack/react-query"
import { act, renderHook, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { useRepos } from "./queries"
import { useProjectOrder } from "./useProjectOrder"
import type { ProjectMove } from "@/lib/project-order-queue"
import { reorderRepos } from "@/lib/projects"
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

interface Deferred<T> {
  value: T
  resolve: () => void
  reject: (error: unknown) => void
}

/**
 * A daemon that answers nothing until the test says so: every PUT and every
 * repos read waits in a list, so responses can land in any order. A PUT the
 * test resolves becomes the daemon's order; a read answers with the order the
 * daemon has when it is resolved.
 */
function setup(enabled = true) {
  let server = REPOS
  const puts: Deferred<string[]>[] = []
  const gets: Deferred<null>[] = []
  const request = vi.fn((path: string, init?: { method?: string; body?: unknown }) => {
    if (path === "/api/repos/order" && init?.method === "PUT") {
      const paths = (init.body as { paths: string[] }).paths
      return new Promise((resolve, reject) =>
        puts.push({
          value: paths,
          resolve: () => {
            server = reorderRepos(server, paths)
            resolve({ paths })
          },
          reject,
        }),
      )
    }
    return new Promise((resolve, reject) => gets.push({ value: null, resolve: () => resolve({ repos: server }), reject }))
  })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(reposKey, { repos: REPOS })
  const transport = fakeDaemonTransport("test-connection", { request: request as DaemonTransport["request"] })
  const { result } = renderHook(() => ({ order: useProjectOrder(enabled), repos: useRepos() }), {
    wrapper: runtimeWrapper(transport, client),
  })
  /** the configured projects as the observed query renders them */
  const shown = () => result.current.repos.data!.filter((r) => r.configured).map((r) => r.path)
  const sent = () => puts.map((put) => put.value)
  const answerReads = () => settle(() => gets.splice(0).forEach((get) => get.resolve()))
  const move = (path: string, to: ProjectMove) => settle(() => result.current.order!.onReorder(path, to))
  return { result, client, puts, gets, shown, sent, answerReads, move }
}

/** Run `fn`, then let the query's observers re-render: TanStack notifies them on a timeout. */
async function settle(fn: () => void): Promise<void> {
  await act(async () => {
    fn()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

describe("useProjectOrder", () => {
  it("offers nothing when the daemon cannot save an order", () => {
    expect(setup(false).result.current.order).toBeUndefined()
  })

  it("moves the sidebar at once, saves the order, then reads the list again", async () => {
    const { result, puts, gets, shown, sent, answerReads, move } = setup()

    await move("/src/gamma", { to: 0 })

    expect(shown()).toEqual(["/src/gamma", "/src/alpha", "/src/beta"])
    expect(sent()).toEqual([["/src/gamma", "/src/alpha", "/src/beta"]])
    expect(gets).toHaveLength(0)
    await settle(() => puts[0]!.resolve())
    await waitFor(() => expect(gets).toHaveLength(1))
    await answerReads()
    expect(shown()).toEqual(["/src/gamma", "/src/alpha", "/src/beta"])
    expect(result.current.order!.error).toBeNull()
  })

  it("two moves in one frame build on each other", async () => {
    const { result, shown } = setup()

    await settle(() => {
      result.current.order!.onReorder("/src/gamma", { step: -1 })
      result.current.order!.onReorder("/src/gamma", { step: -1 })
    })

    expect(shown()).toEqual(["/src/gamma", "/src/alpha", "/src/beta"])
  })

  it("moves made while a save is in flight queue, and only the latest is sent", async () => {
    const { puts, gets, shown, sent, answerReads, move } = setup()

    await move("/src/gamma", { step: -1 })
    await move("/src/gamma", { step: -1 })
    await move("/src/alpha", { step: 1 })

    expect(shown()).toEqual(["/src/gamma", "/src/beta", "/src/alpha"])
    expect(sent()).toEqual([["/src/alpha", "/src/gamma", "/src/beta"]])

    await settle(() => puts[0]!.resolve())
    expect(sent()).toEqual([
      ["/src/alpha", "/src/gamma", "/src/beta"],
      ["/src/gamma", "/src/beta", "/src/alpha"],
    ])
    expect(shown()).toEqual(["/src/gamma", "/src/beta", "/src/alpha"])
    expect(gets).toHaveLength(0)

    await settle(() => puts[1]!.resolve())
    await waitFor(() => expect(gets).toHaveLength(1))
    await answerReads()
    expect(shown()).toEqual(["/src/gamma", "/src/beta", "/src/alpha"])
  })

  it("a repos read that lands mid-save does not put the old order back", async () => {
    const { client, puts, gets, shown, answerReads, move } = setup()

    // a read already in flight when the move happens, as an SSE event's refetch would be
    void client.invalidateQueries({ queryKey: reposKey })
    await waitFor(() => expect(gets).toHaveLength(1))
    await move("/src/beta", { to: 0 })
    await answerReads()
    expect(shown()).toEqual(["/src/beta", "/src/alpha", "/src/gamma"])

    // and one started after it, answered while the save is still out
    await settle(() => void client.invalidateQueries({ queryKey: reposKey }))
    await waitFor(() => expect(gets).toHaveLength(1))
    await answerReads()
    expect(shown()).toEqual(["/src/beta", "/src/alpha", "/src/gamma"])

    await settle(() => puts[0]!.resolve())
    await waitFor(() => expect(gets).toHaveLength(1))
    await answerReads()
    expect(shown()).toEqual(["/src/beta", "/src/alpha", "/src/gamma"])
  })

  it("a refusal puts back the order the daemon last accepted, drops the queued move, and says why", async () => {
    const { result, puts, gets, shown, sent, answerReads, move } = setup()

    await move("/src/beta", { to: 0 })
    await settle(() => puts[0]!.resolve())
    await waitFor(() => expect(gets).toHaveLength(1))
    await answerReads()

    await move("/src/gamma", { to: 0 })
    await move("/src/alpha", { to: 0 })
    expect(shown()).toEqual(["/src/alpha", "/src/gamma", "/src/beta"])
    await settle(() =>
      puts[1]!.reject(new ApiError("The project list changed since it was loaded. Reload and try again. (missing: /src/delta)", 409)),
    )

    expect(shown()).toEqual(["/src/beta", "/src/alpha", "/src/gamma"])
    expect(sent()).toHaveLength(2)
    expect(result.current.order!.error).toBe(
      "Could not save the project order: The project list changed since it was loaded. Reload and try again. (missing: /src/delta)",
    )
    await waitFor(() => expect(gets).toHaveLength(1))
    await answerReads()
    expect(shown()).toEqual(["/src/beta", "/src/alpha", "/src/gamma"])
    expect(sent()).toHaveLength(2)

    act(() => result.current.order!.onDismissError())
    expect(result.current.order!.error).toBeNull()
  })
})
