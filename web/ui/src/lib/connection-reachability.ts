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
