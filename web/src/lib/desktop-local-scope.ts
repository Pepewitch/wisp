import { clearRememberedAttachments } from "@/lib/attachments"
import { synchronizeLocalRouteRevision } from "@/lib/connection-storage"
import type { DesktopBootstrap } from "@/lib/desktop-bridge"
import { clearConnectionDrafts } from "@/lib/drafts"
import { queryClient } from "@/lib/query"

/** Clear stale Local state before a replacement runtime can read any of it. */
export function prepareLocalScope(bootstrap: DesktopBootstrap): void {
  const revision = bootstrap.connections.find(
    (connection) => connection.id === "local"
  )?.routeRevision
  if (revision !== undefined && synchronizeLocalRouteRevision(revision)) {
    queryClient.removeQueries({ queryKey: ["local"] })
    clearConnectionDrafts("local")
    clearRememberedAttachments("local")
  }
}
