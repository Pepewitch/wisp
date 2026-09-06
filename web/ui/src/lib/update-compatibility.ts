import type { UpdateStatus } from "@/lib/types"

export function daemonUpdateIsCompatible(
  status: UpdateStatus | undefined,
  supportedApiProtocols: readonly number[] | undefined
): boolean {
  if (!status || !supportedApiProtocols) return true
  return (
    supportedApiProtocols.includes(status.currentApiProtocolVersion) &&
    status.latestApiProtocolVersion !== null &&
    supportedApiProtocols.includes(status.latestApiProtocolVersion)
  )
}
