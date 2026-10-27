import type { QueryClient } from "@tanstack/react-query"

import { moveProject, reorderRepos } from "@/lib/projects"
import type { ConnectionQueryKeys } from "@/lib/query"
import { ApiError, type DaemonTransport } from "@/lib/transport"
import type { RepoInfo } from "@/lib/types"

/** One project's move: a step up (-1) or down (1), or straight to an index of the configured order. */
export type ProjectMove = { step: -1 | 1 } | { to: number }

export interface ProjectOrderState {
  /** the configured order the sidebar shows while a save is out; null once the daemon's list is read again */
  pending: readonly string[] | null
  /** why the last save was refused, until dismissed or the next move */
  error: string | null
}

const IDLE: ProjectOrderState = Object.freeze({ pending: null, error: null })

/** The repos list as the sidebar shows it: the daemon's, with a pending order laid over its configured projects. */
export function shownRepos(repos: readonly RepoInfo[], pending: readonly string[] | null): RepoInfo[] {
  return pending ? reorderRepos(repos, pending) : [...repos]
}

function configuredPaths(repos: readonly RepoInfo[]): string[] {
  return repos.filter((repo) => repo.configured).map((repo) => repo.path)
}

/**
 * One connection's project reorders, saved with PUT /api/repos/order one at
 * a time. It never writes the repos cache: that always holds what the daemon
 * last said, and the order a save is waiting on lives here, as `pending`,
 * for the sidebar to lay over it (`shownRepos`). A project added meanwhile
 * goes after the ordered ones; one removed is simply gone.
 *
 * A move made while a save is out becomes the queued order, and a later one
 * replaces it, so the daemon only hears the latest. When the queue drains the
 * repos list is read again once, and `pending` clears when that read is in.
 * A refusal clears `pending`, drops the queued order, says why, and reads
 * the list again. Each move works from what the sidebar shows now, not the
 * last render, so two moves inside one frame build on each other.
 */
export class ProjectOrderQueue {
  readonly #client: QueryClient
  readonly #reposKey: ConnectionQueryKeys["repos"]
  #transport: DaemonTransport
  #state: ProjectOrderState = IDLE
  #queued: string[] | null = null
  #inFlight = false
  readonly #listeners = new Set<() => void>()

  constructor(client: QueryClient, qk: Pick<ConnectionQueryKeys, "repos">, transport: DaemonTransport) {
    this.#client = client
    this.#reposKey = qk.repos
    this.#transport = transport
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  readonly getState = (): ProjectOrderState => this.#state

  /** `transport` is the connection's current one: a later save goes out on it. */
  move(path: string, move: ProjectMove, transport: DaemonTransport): void {
    this.#transport = transport
    const order = this.#shown()
    if (!order) return
    const from = order.indexOf(path)
    const to = "step" in move ? from + move.step : move.to
    if (from < 0 || to < 0 || to >= order.length || to === from) return
    const next = moveProject(order, from, to)
    this.#set({ pending: next, error: null })
    if (this.#inFlight) this.#queued = next
    else void this.#send(next)
  }

  dismissError(): void {
    if (this.#state.error !== null) this.#set({ ...this.#state, error: null })
  }

  /** The configured projects in the order the sidebar shows them; undefined before the list is read. */
  #shown(): string[] | undefined {
    const data = this.#client.getQueryData<{ repos: RepoInfo[] }>(this.#reposKey)
    return data && configuredPaths(shownRepos(data.repos, this.#state.pending))
  }

  async #send(paths: string[]): Promise<void> {
    this.#inFlight = true
    try {
      await this.#transport.request<{ paths: string[] }>("/api/repos/order", { method: "PUT", body: { paths } })
    } catch (error) {
      this.#inFlight = false
      this.#queued = null
      this.#set({ pending: null, error: refusal(error) })
      void this.#client.invalidateQueries({ queryKey: this.#reposKey })
      return
    }
    const queued = this.#queued
    this.#queued = null
    // the queued order was picked against the list as it was; a project
    // added or removed since is folded in, rather than refused for it
    if (queued) return this.#send(this.#shown() ?? queued)
    this.#inFlight = false
    const saved = this.#state.pending
    // "all": with the sidebar unmounted (another connection showing) the
    // read still lands before `pending` clears, so coming back shows no stale order
    await this.#client.invalidateQueries({ queryKey: this.#reposKey, refetchType: "all" })
    // a move made while the list was being read owns `pending` now
    if (!this.#inFlight && this.#state.pending === saved) this.#set({ ...this.#state, pending: null })
  }

  #set(state: ProjectOrderState): void {
    this.#state = state
    for (const listener of this.#listeners) listener()
  }
}

function refusal(error: unknown): string {
  if (error instanceof ApiError && error.status === 409) {
    return "the project list changed while it was being saved (a project was added or removed), so the new order was not kept. Move it again."
  }
  return error instanceof Error ? error.message : String(error)
}

const queues = new WeakMap<QueryClient, Map<string, ProjectOrderQueue>>()

/**
 * The connection's one queue. It belongs to the QueryClient whose cache it
 * reads, not to a component: switching connections remounts the sidebar,
 * and coming back must find the save still in flight rather than start a
 * second queue beside it.
 */
export function projectOrderQueue(
  client: QueryClient,
  connectionId: string,
  qk: Pick<ConnectionQueryKeys, "repos">,
  transport: DaemonTransport,
): ProjectOrderQueue {
  let byConnection = queues.get(client)
  if (!byConnection) queues.set(client, (byConnection = new Map()))
  let queue = byConnection.get(connectionId)
  if (!queue) byConnection.set(connectionId, (queue = new ProjectOrderQueue(client, qk, transport)))
  return queue
}
