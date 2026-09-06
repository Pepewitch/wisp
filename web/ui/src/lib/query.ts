import { QueryClient } from "@tanstack/react-query"

import { ApiError, LOCAL_CONNECTION_ID } from "./transport"

/**
 * One client for the app. Wisp-owned state is realtime through /api/events.
 * Provider-owned PR state and the daemon-cached release check are the
 * deliberate polling exceptions, and window focus still covers a slept laptop.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: true,
      retry: (failureCount, error) => {
        // 4xx is an honest answer (unknown task, archived diff) — retrying changes nothing
        if (
          error instanceof ApiError &&
          error.status >= 400 &&
          error.status < 500
        )
          return false
        return failureCount < 2
      },
    },
  },
})

/** Every daemon-owned cache key is rooted at its immutable connection ID. */
export interface ConnectionQueryKeys {
  readonly connection: readonly [string]
  readonly tasks: readonly [string, "tasks"]
  tasksList(
    archived: boolean
  ): readonly [string, "tasks", { readonly archived: boolean }]
  readonly status: readonly [string, "status"]
  task(id: string): readonly [string, "task", string]
  pullRequest(id: string): readonly [string, "pull-request", string]
  readonly pullRequests: readonly [string, "pull-requests"]
  diff(id: string): readonly [string, "diff", string]
  skills(id: string): readonly [string, "skills", string]
  readonly repos: readonly [string, "repos"]
  readonly suffixPrompts: readonly [string, "suffix-prompts"]
  readonly harnesses: readonly [string, "harnesses"]
  readonly update: readonly [string, "update"]
}

/** Pre-bind keys once when a connection runtime is created. */
export function createConnectionQueryKeys(
  connectionId: string
): Readonly<ConnectionQueryKeys> {
  return Object.freeze({
    connection: Object.freeze([connectionId] as const),
    tasks: Object.freeze([connectionId, "tasks"] as const),
    tasksList: (archived: boolean) =>
      Object.freeze([
        connectionId,
        "tasks",
        Object.freeze({ archived }),
      ] as const),
    status: Object.freeze([connectionId, "status"] as const),
    task: (id: string) => Object.freeze([connectionId, "task", id] as const),
    pullRequest: (id: string) =>
      Object.freeze([connectionId, "pull-request", id] as const),
    pullRequests: Object.freeze([connectionId, "pull-requests"] as const),
    diff: (id: string) => Object.freeze([connectionId, "diff", id] as const),
    skills: (id: string) =>
      Object.freeze([connectionId, "skills", id] as const),
    repos: Object.freeze([connectionId, "repos"] as const),
    suffixPrompts: Object.freeze([connectionId, "suffix-prompts"] as const),
    harnesses: Object.freeze([connectionId, "harnesses"] as const),
    update: Object.freeze([connectionId, "update"] as const),
  })
}

/** Compatibility binding for the existing single-daemon browser UI. */
export const qk = createConnectionQueryKeys(LOCAL_CONNECTION_ID)
