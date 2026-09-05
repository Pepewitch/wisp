import { QueryClient } from "@tanstack/react-query";

import { ApiError } from "./api";

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
        if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false;
        return failureCount < 2;
      },
    },
  },
});

/** Query keys. The bridge invalidates by prefix: ["tasks"] hits both archived variants. */
export const qk = {
  tasks: ["tasks"] as const,
  tasksList: (archived: boolean) => ["tasks", { archived }] as const,
  status: ["status"] as const,
  task: (id: string) => ["task", id] as const,
  pullRequest: (id: string) => ["pull-request", id] as const,
  pullRequests: ["pull-requests"] as const,
  diff: (id: string) => ["diff", id] as const,
  skills: (id: string) => ["skills", id] as const,
  repos: ["repos"] as const,
  suffixPrompts: ["suffix-prompts"] as const,
  harnesses: ["harnesses"] as const,
  update: ["update"] as const,
};
