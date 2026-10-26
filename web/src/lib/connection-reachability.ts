import type { DesktopConnectionMetadata } from "@/lib/desktop-bridge"
import { ApiError } from "@/lib/transport"

export type ConnectionReachability =
  | "unknown"
  | "online"
  | "offline"
  | "unauthorized"
  | "identity-changed"
  | "error"

export function classifyConnectionError(error: unknown): ConnectionReachability {
  if (error instanceof ApiError) {
    if (error.code === "identity-changed") return "identity-changed"
    if (
      error.status === 401 ||
      error.status === 403 ||
      error.code === "no-credential" ||
      error.code === "credential-unavailable"
    )
      return "unauthorized"
    if (
      error.code === "upstream" ||
      error.code === "upstream-timeout" ||
      error.code === "identity-unreachable"
    )
      return "offline"
    return "error"
  }
  return error instanceof TypeError ? "offline" : "error"
}

/** What is wrong with a connection, in words; null while it is ready and answering. */
export function connectionIssue(
  connection: DesktopConnectionMetadata,
  reachability: ConnectionReachability = "unknown"
): string | null {
  if (!connection.ready)
    return (
      connection.problem ??
      (connection.kind === "local"
        ? "Local Wisp needs setup"
        : "Connection needs attention")
    )
  if (reachability === "offline") return "Daemon unavailable"
  if (reachability === "unauthorized") return "Authentication required"
  if (reachability === "identity-changed") return "Daemon identity changed"
  if (reachability === "error") return "Daemon returned an error"
  return null
}
