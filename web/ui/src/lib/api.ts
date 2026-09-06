/**
 * Compatibility facade for the existing single-daemon UI.
 *
 * New connection-aware code consumes the runtime transport directly. Keeping
 * these exports lets the current hooks migrate incrementally without changing
 * the daemon-served browser behavior.
 */
import type { DaemonRequestOptions } from "./transport"
import { sameOriginWebTransport } from "./web-transport"

export {
  ApiError,
  authStore,
  completeAuth,
  failureDisplay,
  failureReason,
  getToken,
  mintSession,
  requireAuth,
  type AuthState,
} from "./web-transport"

export function api<T>(
  path: string,
  options: DaemonRequestOptions = {}
): Promise<T> {
  return sameOriginWebTransport.request<T>(path, options)
}

export function ensureSession(): Promise<void> {
  return sameOriginWebTransport.ensureReady()
}
