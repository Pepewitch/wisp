import type { DesktopConnectionMetadata } from "./desktop-bridge"

export const CONNECTION_NAME_MAX = 48

export function validateConnectionName(
  name: string,
  connections: readonly { metadata: DesktopConnectionMetadata }[],
  excludingId?: string
): string | null {
  const cleaned = name.trim()
  if (!cleaned) return "Connection name is required"
  if (cleaned.length > CONNECTION_NAME_MAX)
    return `Connection name must be ${CONNECTION_NAME_MAX} characters or fewer`
  const duplicate = connections.some(
    ({ metadata }) =>
      metadata.id !== excludingId &&
      metadata.name.toLowerCase() === cleaned.toLowerCase()
  )
  return duplicate ? "Connection names must be unique" : null
}
