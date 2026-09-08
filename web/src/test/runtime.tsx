import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactNode } from "react"

import { DaemonRuntimeProvider } from "@/lib/runtime"
import type { DaemonTransport } from "@/lib/transport"

export function fakeDaemonTransport(
  connectionId = "test-connection",
  overrides: Partial<DaemonTransport> = {},
): DaemonTransport {
  return {
    connectionId,
    request: async <T,>() => ({} as T),
    openEventStream: () => ({}) as EventSource,
    openWebSocket: () => ({}) as WebSocket,
    assetUrl: (path) => path,
    ensureReady: () => Promise.resolve(),
    ...overrides,
  }
}

export function runtimeWrapper(
  transport: DaemonTransport,
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
) {
  return function RuntimeTestWrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>
        <DaemonRuntimeProvider transport={transport}>{children}</DaemonRuntimeProvider>
      </QueryClientProvider>
    )
  }
}
