import { hashKey, type QueryClient } from "@tanstack/react-query"

import { moveProject, reorderRepos } from "@/lib/projects"
import type { ConnectionQueryKeys } from "@/lib/query"
import type { DaemonTransport } from "@/lib/transport"
import type { RepoInfo } from "@/lib/types"

/** One project's move: a step up (-1) or down (1), or straight to an index of the configured order. */
export type ProjectMove = { step: -1 | 1 } | { to: number }

type ReposData = { repos: RepoInfo[] }

function configuredPaths(repos: readonly RepoInfo[]): string[] {
  return repos.filter((repo) => repo.configured).map((repo) => repo.path)
}

function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((path, index) => path === b[index])
}

/**
 * One connection's project reorders, saved with PUT /api/repos/order one at
 * a time. A move made while a save is in flight shows at once and waits as
 * the queued order; a later move replaces it, so the daemon only ever hears
 * the latest. Until the queue drains, any repos read that lands (an SSE
 * `project` event's refetch, a cancelled read reverting) gets the order the
 * sidebar shows put back over it, and nothing invalidates the list; once it
 * drains, the list is read again. A refused save puts back the last order the
 * daemon accepted, drops the queued one, and reports why.
 *
 * Every move is computed from the cached list, not from what was last
 * rendered, so two moves inside one frame build on each other.
 */
export class ProjectOrderQueue {
  readonly #client: QueryClient
  readonly #transport: DaemonTransport
  readonly #reposKey: ConnectionQueryKeys["repos"]
  readonly #onError: (message: string | null) => void
  /** the order the daemon last accepted; set while busy */
  #confirmed: string[] | null = null
  /** the order the sidebar shows; set while busy */
  #shown: string[] | null = null
  #queued: string[] | null = null
  #inFlight = false
  #release: (() => void) | null = null

  constructor(
    target: { client: QueryClient; transport: DaemonTransport; qk: Pick<ConnectionQueryKeys, "repos"> },
    onError: (message: string | null) => void,
  ) {
    this.#client = target.client
    this.#transport = target.transport
    this.#reposKey = target.qk.repos
    this.#onError = onError
  }

  move(path: string, move: ProjectMove): void {
    const data = this.#client.getQueryData<ReposData>(this.#reposKey)
    if (!data) return
    const order = configuredPaths(data.repos)
    const from = order.indexOf(path)
    const to = "step" in move ? from + move.step : move.to
    if (from < 0 || to < 0 || to >= order.length || to === from) return
    const next = moveProject(order, from, to)
    if (this.#shown === null) {
      this.#confirmed = order
      this.#hold()
    }
    this.#shown = next
    this.#onError(null)
    this.#show()
    void this.#client.cancelQueries({ queryKey: this.#reposKey })
    if (this.#inFlight) this.#queued = next
    else void this.#send(next)
  }

  async #send(paths: string[]): Promise<void> {
    this.#inFlight = true
    try {
      await this.#transport.request<{ paths: string[] }>("/api/repos/order", { method: "PUT", body: { paths } })
    } catch (error) {
      this.#inFlight = false
      this.#queued = null
      this.#shown = this.#confirmed
      this.#show()
      this.#drain()
      this.#onError(error instanceof Error ? error.message : String(error))
      return
    }
    this.#inFlight = false
    this.#confirmed = paths
    const queued = this.#queued
    this.#queued = null
    if (queued) return this.#send(queued)
    this.#drain()
  }

  /** Put the shown order over whatever the cached list now says. */
  #show(): void {
    const shown = this.#shown
    const data = this.#client.getQueryData<ReposData>(this.#reposKey)
    if (!shown || !data || sameOrder(configuredPaths(data.repos), shown)) return
    this.#client.setQueryData<ReposData>(this.#reposKey, { ...data, repos: reorderRepos(data.repos, shown) })
  }

  #hold(): void {
    const hash = hashKey(this.#reposKey)
    // A cache listener runs before the query's observers re-render, so a
    // stale read never reaches the screen.
    this.#release = this.#client.getQueryCache().subscribe((event) => {
      if (event.type === "updated" && event.query.queryHash === hash) this.#show()
    })
  }

  #drain(): void {
    this.#release?.()
    this.#release = null
    this.#shown = null
    this.#confirmed = null
    void this.#client.invalidateQueries({ queryKey: this.#reposKey })
  }
}
