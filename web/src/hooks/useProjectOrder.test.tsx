import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, renderHook } from "@testing-library/react"
import type { ReactNode } from "react"
import { describe, expect, it, vi } from "vitest"

import { useRepos } from "./queries"
import { useProjectOrder } from "./useProjectOrder"
import { shownRepos, type ProjectMove } from "@/lib/project-order-queue"
import { reorderRepos } from "@/lib/projects"
import { createConnectionQueryKeys } from "@/lib/query"
import { DaemonRuntimeProvider } from "@/lib/runtime"
import { ApiError, type DaemonTransport } from "@/lib/transport"
import type { RepoInfo } from "@/lib/types"
import { fakeDaemonTransport } from "@/test/runtime"

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
const configured = (repos: readonly RepoInfo[]) => repos.filter((r) => r.configured).map((r) => r.path)

interface Deferred<T> {
  value: T
  resolve: () => void
  reject: (error: unknown) => void
}

/**
 * A daemon that answers nothing until the test says so: every PUT and every
 * repos read waits in a list, so responses can land in any order. A PUT the
 * test resolves becomes the daemon's order; a read answers with the list the
 * daemon has when it is resolved, which the test can change (`server`).
 */
function fakeDaemon(connectionId: string, repos = REPOS) {
  const daemon = {
    server: repos,
    puts: [] as Deferred<string[]>[],
    gets: [] as Deferred<null>[],
    sent: () => daemon.puts.map((put) => put.value),
    transport: null as unknown as DaemonTransport,
  }
  const request = vi.fn((path: string, init?: { method?: string; body?: unknown }) => {
    if (path === "/api/repos/order" && init?.method === "PUT") {
      const paths = (init.body as { paths: string[] }).paths
      return new Promise((resolve, reject) =>
        daemon.puts.push({
          value: paths,
          resolve: () => {
            daemon.server = reorderRepos(daemon.server, paths)
            resolve({ paths })
          },
          reject,
        }),
      )
    }
    return new Promise((resolve, reject) =>
      daemon.gets.push({ value: null, resolve: () => resolve({ repos: daemon.server }), reject }),
    )
  })
  daemon.transport = fakeDaemonTransport(connectionId, { request: request as DaemonTransport["request"] })
  return daemon
}

/** Run `fn`, then let the query's observers re-render: TanStack notifies them on a timeout. */
async function settle(fn: () => void = () => {}): Promise<void> {
  await act(async () => {
    fn()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

/**
 * The hook beside an observed repos query, under the real runtime provider,
 * with the sidebar's own derivation of what is on screen. `active` picks the
 * connection; `rerender` after changing it switches, remounting as Desktop does.
 */
function mount(daemons: ReturnType<typeof fakeDaemon>[], enabled = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  for (const daemon of daemons) {
    client.setQueryData(createConnectionQueryKeys(daemon.transport.connectionId).repos, { repos: daemon.server })
  }
  const view = { active: daemons[0]! }
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <DaemonRuntimeProvider transport={view.active.transport}>{children}</DaemonRuntimeProvider>
    </QueryClientProvider>
  )
  const { result, rerender } = renderHook(() => ({ order: useProjectOrder(enabled), repos: useRepos() }), { wrapper })
  const shown = () => configured(shownRepos(result.current.repos.data!, result.current.order!.pending))
  const cached = () => configured(client.getQueryData<{ repos: RepoInfo[] }>(createConnectionQueryKeys(view.active.transport.connectionId).repos)!.repos)
  const move = (path: string, to: ProjectMove) => settle(() => result.current.order!.onReorder(path, to))
  const answerReads = (daemon = view.active) => settle(() => daemon.gets.splice(0).forEach((get) => get.resolve()))
  const switchTo = async (daemon: ReturnType<typeof fakeDaemon>) => {
    view.active = daemon
    await settle(() => rerender())
  }
  return { result, client, shown, cached, move, answerReads, switchTo }
}

const refetch = (client: QueryClient, connectionId = "a") =>
  settle(() => void client.invalidateQueries({ queryKey: createConnectionQueryKeys(connectionId).repos }))

describe("useProjectOrder", () => {
  it("offers nothing when the daemon cannot save an order", () => {
    expect(mount([fakeDaemon("a")], false).result.current.order).toBeUndefined()
  })

  it("shows a move at once, saves it, then reads the list again once", async () => {
    const daemon = fakeDaemon("a")
    const { result, shown, cached, move, answerReads } = mount([daemon])

    await move("/src/gamma", { to: 0 })

    expect(shown()).toEqual(["/src/gamma", "/src/alpha", "/src/beta"])
    // the cache holds what the daemon last said, never the order being saved
    expect(cached()).toEqual(["/src/alpha", "/src/beta", "/src/gamma"])
    expect(daemon.sent()).toEqual([["/src/gamma", "/src/alpha", "/src/beta"]])
    expect(daemon.gets).toHaveLength(0)

    await settle(() => daemon.puts[0]!.resolve())
    expect(daemon.gets).toHaveLength(1)
    expect(result.current.order!.pending).not.toBeNull()
    await answerReads()
    expect(result.current.order!.pending).toBeNull()
    expect(cached()).toEqual(["/src/gamma", "/src/alpha", "/src/beta"])
    expect(shown()).toEqual(["/src/gamma", "/src/alpha", "/src/beta"])
    expect(result.current.order!.error).toBeNull()
  })

  it("two moves in one frame build on each other", async () => {
    const { result, shown } = mount([fakeDaemon("a")])

    await settle(() => {
      result.current.order!.onReorder("/src/gamma", { step: -1 })
      result.current.order!.onReorder("/src/gamma", { step: -1 })
    })

    expect(shown()).toEqual(["/src/gamma", "/src/alpha", "/src/beta"])
  })

  it("moves made while a save is in flight queue, and only the latest is sent", async () => {
    const daemon = fakeDaemon("a")
    const { shown, move, answerReads } = mount([daemon])

    await move("/src/gamma", { step: -1 })
    await move("/src/gamma", { step: -1 })
    await move("/src/alpha", { step: 1 })

    expect(shown()).toEqual(["/src/gamma", "/src/beta", "/src/alpha"])
    expect(daemon.sent()).toEqual([["/src/alpha", "/src/gamma", "/src/beta"]])

    await settle(() => daemon.puts[0]!.resolve())
    expect(daemon.sent()).toEqual([
      ["/src/alpha", "/src/gamma", "/src/beta"],
      ["/src/gamma", "/src/beta", "/src/alpha"],
    ])
    expect(shown()).toEqual(["/src/gamma", "/src/beta", "/src/alpha"])
    expect(daemon.gets).toHaveLength(0)

    await settle(() => daemon.puts[1]!.resolve())
    expect(daemon.gets).toHaveLength(1)
    await answerReads()
    expect(shown()).toEqual(["/src/gamma", "/src/beta", "/src/alpha"])
  })

  it("a repos read that lands mid-save leaves the shown order alone", async () => {
    const daemon = fakeDaemon("a")
    const { client, shown, cached, move, answerReads } = mount([daemon])

    // one read already out when the move happens, as an SSE event's refetch would be
    await refetch(client)
    expect(daemon.gets).toHaveLength(1)
    await move("/src/beta", { to: 0 })
    await answerReads()
    expect(shown()).toEqual(["/src/beta", "/src/alpha", "/src/gamma"])

    // and one started after it, answered while the save is still out
    await refetch(client)
    await answerReads()
    expect(cached()).toEqual(["/src/alpha", "/src/beta", "/src/gamma"])
    expect(shown()).toEqual(["/src/beta", "/src/alpha", "/src/gamma"])

    await settle(() => daemon.puts[0]!.resolve())
    await answerReads()
    expect(shown()).toEqual(["/src/beta", "/src/alpha", "/src/gamma"])
  })

  it("a project added and one removed mid-save settle without a loop, and the queued order folds them in", async () => {
    const daemon = fakeDaemon("a")
    const { client, shown, move, answerReads } = mount([daemon])

    await move("/src/gamma", { to: 0 })
    await move("/src/alpha", { to: 2 })
    expect(shown()).toEqual(["/src/gamma", "/src/beta", "/src/alpha"])

    // another client adds delta and removes beta; the project event's refetch lands
    daemon.server = [repo("/src/alpha"), repo("/src/gamma"), repo("/src/delta"), repo("/elsewhere/history", false)]
    await refetch(client)
    await answerReads()
    expect(shown()).toEqual(["/src/gamma", "/src/alpha", "/src/delta"])

    await settle(() => daemon.puts[0]!.resolve())
    expect(daemon.sent()[1]).toEqual(["/src/gamma", "/src/alpha", "/src/delta"])
    await settle(() => daemon.puts[1]!.resolve())
    await answerReads()
    expect(shown()).toEqual(["/src/gamma", "/src/alpha", "/src/delta"])
  })

  it("a refusal clears the shown order, drops the queued move, says why and reads the list again", async () => {
    const daemon = fakeDaemon("a")
    const { result, shown, move, answerReads } = mount([daemon])

    await move("/src/gamma", { to: 0 })
    await move("/src/alpha", { to: 0 })
    expect(shown()).toEqual(["/src/alpha", "/src/gamma", "/src/beta"])
    await settle(() => daemon.puts[0]!.reject(new ApiError("The project list changed since it was loaded.", 409)))

    expect(result.current.order!.pending).toBeNull()
    expect(shown()).toEqual(["/src/alpha", "/src/beta", "/src/gamma"])
    expect(result.current.order!.error).toBe(
      "Could not save the project order: the project list changed while it was being saved (a project was added or removed), so the new order was not kept. Move it again.",
    )
    expect(daemon.gets).toHaveLength(1)
    await answerReads()
    expect(daemon.sent()).toHaveLength(1)

    await settle(() => result.current.order!.onDismissError())
    expect(result.current.order!.error).toBeNull()
  })

  it("any other refusal says what the daemon said", async () => {
    const daemon = fakeDaemon("a")
    const { result, move } = mount([daemon])

    await move("/src/gamma", { to: 0 })
    await settle(() => daemon.puts[0]!.reject(new ApiError("path must be absolute: gamma", 400)))

    expect(result.current.order!.error).toBe("Could not save the project order: path must be absolute: gamma")
  })

  it("switching connections away and back mid-save finds the same queue, and the next move waits its turn", async () => {
    const a = fakeDaemon("a")
    const b = fakeDaemon("b", [repo("/b/one"), repo("/b/two")])
    const { result, shown, move, answerReads, switchTo } = mount([a, b])

    await move("/src/gamma", { to: 0 })
    await switchTo(b)
    expect(shown()).toEqual(["/b/one", "/b/two"])
    await switchTo(a)
    expect(shown()).toEqual(["/src/gamma", "/src/alpha", "/src/beta"])

    await move("/src/beta", { to: 1 })
    expect(shown()).toEqual(["/src/gamma", "/src/beta", "/src/alpha"])
    expect(a.sent()).toHaveLength(1)

    await settle(() => a.puts[0]!.resolve())
    expect(a.sent()).toEqual([
      ["/src/gamma", "/src/alpha", "/src/beta"],
      ["/src/gamma", "/src/beta", "/src/alpha"],
    ])
    await settle(() => a.puts[1]!.resolve())
    await answerReads()
    expect(result.current.order!.pending).toBeNull()
    expect(shown()).toEqual(["/src/gamma", "/src/beta", "/src/alpha"])
    expect(b.sent()).toHaveLength(0)
  })
})
