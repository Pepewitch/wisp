import type { KeyboardEvent } from "react"

import type { ConnectionDialogMode } from "@/components/connection-dialogs"
import {
  ChevronDown,
  Local,
  Offline,
  Pencil,
  Plus,
  Refresh,
  Remote,
  Trash,
} from "@/components/icons"
import {
  Menu,
  MenuGroup,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
} from "@/components/menu"
import { useConnectionStreamStatus } from "@/hooks/useConnectionStreamStatus"
import type { ConnectionAttention } from "@/lib/connection-attention"
import {
  connectionIssue,
  type ConnectionReachability,
} from "@/lib/connection-reachability"
import type { ConnectionStreamStatus } from "@/lib/conn"
import {
  MAX_DESKTOP_CONNECTIONS,
  type DesktopConnectionMetadata,
} from "@/lib/desktop-bridge"
import { STATE_LABEL } from "@/lib/state"
import { cn } from "@/lib/utils"

export function ConnectionGlyph({
  kind,
}: {
  kind: DesktopConnectionMetadata["kind"]
}) {
  return kind === "local" ? <Local aria-hidden /> : <Remote aria-hidden />
}

function connectionStatusTitle(
  issue: string | null,
  reachability: ConnectionReachability,
  streamStatus: ConnectionStreamStatus,
  live: boolean,
  opening: boolean
): string {
  if (issue) return issue
  if (reachability === "unknown") return "Checking server…"
  if (live) return "Live"
  if (opening) return "Server reachable · Connecting live updates…"
  return streamStatus === "failed"
    ? "Server reachable · Live updates disconnected"
    : "Server reachable · Live updates delayed"
}

/**
 * Delayed updates are a degraded connection, not a call to act, so they get a
 * hollow ring rather than the needs-input yellow the task list uses right below.
 */
function connectionDotColor(
  live: boolean,
  opening: boolean,
  updatesDown: boolean
): string {
  if (live || opening) return "bg-state-done"
  return updatesDown
    ? "border-2 border-muted-foreground bg-transparent"
    : "bg-muted-foreground/60"
}

/**
 * A connection's ONE status mark: the dot while the server answers, or the
 * crossed-out cloud when it does not. It is connection health and nothing
 * else; task state lives in the sidebar, the menu's hints and notifications.
 */
function ConnectionMark({
  connection,
  reachability = "unknown",
}: {
  connection: DesktopConnectionMetadata
  reachability?: ConnectionReachability
}) {
  const online = connection.ready && reachability === "online"
  const { status, delayed } = useConnectionStreamStatus(connection.id, online)
  const issue = connectionIssue(connection, reachability)
  const live = online && status === "live"
  const opening = online && status === "opening" && !delayed
  const title = connectionStatusTitle(issue, reachability, status, live, opening)
  if (issue)
    return (
      <span data-connection-mark data-offline title={title} className="flex size-3.5 shrink-0 items-center justify-center text-destructive [&>svg]:size-3.5">
        <Offline aria-hidden />
      </span>
    )
  return (
    // the same box as the cloud, so names line up whichever mark leads them
    <span data-connection-mark title={title} className="relative flex size-3.5 shrink-0 items-center justify-center">
      {opening && (
        <span className="absolute inset-px rounded-full border border-state-done/75 motion-safe:animate-pulse" />
      )}
      <span
        data-live={live}
        className={cn("size-1.5 rounded-full", connectionDotColor(live, opening, online && !live && !opening))}
      />
    </span>
  )
}

const ROW_LABEL = "flex min-w-0 items-center gap-2 [&>svg]:size-3.5 [&>svg]:shrink-0"

/**
 * Desktop's connection picker: `● Name ⌄` in the top bar's left end, after the
 * traffic lights (§5h). It replaced a strip of connection tabs whose width
 * grew with every connection and pushed the bar's divider past the sidebar's
 * edge; one control keeps that end exactly the sidebar's width.
 *
 * Its menu lists every connection with its mark, the current one checked, and
 * the hint the tabs used to hide: the problem, or the busiest task's state.
 * Under them sit the current connection's verbs (the old `⋯`), a reconnect for
 * any other connection that is down (the old chips' own button), Add
 * connection and Reset desktop data.
 *
 * ←/→ (Home/End) on the focused picker still step through the connections,
 * as they did through the tabs; ↓, Enter or Space opens the menu.
 */
export function ConnectionPicker({
  connections,
  activeId,
  reachability,
  attention,
  busy = false,
  onSelect,
  onReconnect,
  onDialog,
}: {
  connections: readonly DesktopConnectionMetadata[]
  activeId: string
  reachability: ReadonlyMap<string, ConnectionReachability>
  attention: ReadonlyMap<string, ConnectionAttention>
  /** a connection action is in flight: its verbs wait */
  busy?: boolean
  onSelect: (connectionId: string) => void
  onReconnect: (connectionId: string) => void
  onDialog: (mode: ConnectionDialogMode) => void
}) {
  const active =
    connections.find((connection) => connection.id === activeId) ?? connections[0]!
  const issue = connectionIssue(active, reachability.get(active.id))
  const canAdd = connections.length < MAX_DESKTOP_CONNECTIONS
  const downElsewhere = connections.filter(
    (connection) =>
      connection.id !== active.id &&
      connectionIssue(connection, reachability.get(connection.id)) !== null
  )

  const step = (event: KeyboardEvent<HTMLSpanElement>) => {
    // React bubbles the open menu's keys here through its portal; there ←/→
    // belong to the menu, and must never swap the daemon under a person
    if (!event.currentTarget.contains(event.target as Node)) return
    const index = connections.indexOf(active)
    const last = connections.length - 1
    const next =
      event.key === "ArrowRight" ? (index + 1) % connections.length
        : event.key === "ArrowLeft" ? (index - 1 + connections.length) % connections.length
          : event.key === "Home" ? 0
            : event.key === "End" ? last
              : null
    if (next === null || connections.length < 2) return
    event.preventDefault()
    if (next !== index) onSelect(connections[next]!.id)
  }

  return (
    // the wrapper only listens: it is the trigger's own size, so the left
    // end's empty stretch around it stays the window's drag region
    <span className="flex min-w-0" onKeyDown={step}>
      <Menu
        label={active.name}
        aria-label={`Connection: ${active.name}${issue ? `, ${issue}` : ""}`}
        className="-ml-1.5 min-w-0 shrink gap-2 px-1.5 text-[12.5px] font-medium text-foreground data-[popup-open]:bg-hover"
        trigger={
          <>
            <ConnectionMark connection={active} reachability={reachability.get(active.id)} />
            <span className="min-w-0 truncate" title={active.name}>{active.name}</span>
            <span className="flex shrink-0 items-center">
              <ChevronDown aria-hidden className="size-3 text-faint" />
            </span>
          </>
        }
      >
        <MenuRadioGroup value={active.id} onValueChange={onSelect}>
          {connections.map((connection) => (
            <MenuRadioItem
              key={connection.id}
              value={connection.id}
              hint={
                connectionIssue(connection, reachability.get(connection.id)) ??
                (attention.get(connection.id) ? STATE_LABEL[attention.get(connection.id)!] : undefined)
              }
            >
              <span className={ROW_LABEL}>
                <ConnectionMark connection={connection} reachability={reachability.get(connection.id)} />
                <span className="truncate">{connection.name}</span>
              </span>
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
        <MenuSeparator />
        <MenuGroup label={active.name}>
          <ActiveConnectionVerbs
            connection={active}
            busy={busy}
            onReconnect={onReconnect}
            onDialog={onDialog}
          />
        </MenuGroup>
        <MenuSeparator />
        {downElsewhere.map((connection) => (
          <MenuItem key={connection.id} disabled={busy} onClick={() => onReconnect(connection.id)}>
            <span className={ROW_LABEL}>
              <Refresh />
              <span className="truncate">Reconnect {connection.name}</span>
            </span>
          </MenuItem>
        ))}
        <MenuItem disabled={!canAdd || busy} onClick={() => onDialog("add")}>
          <span className={ROW_LABEL}>
            <Plus />
            {canAdd ? "Add connection" : `At most ${MAX_DESKTOP_CONNECTIONS} connections`}
          </span>
        </MenuItem>
        <MenuItem disabled={busy} onClick={() => onDialog("reset")}>
          <span className={cn(ROW_LABEL, "text-destructive")}>
            <Trash />
            Reset desktop data
          </span>
        </MenuItem>
      </Menu>
    </span>
  )
}

/** What the old `⋯` menu did to the selected connection. */
function ActiveConnectionVerbs({
  connection,
  busy,
  onReconnect,
  onDialog,
}: {
  connection: DesktopConnectionMetadata
  busy: boolean
  onReconnect: (connectionId: string) => void
  onDialog: (mode: ConnectionDialogMode) => void
}) {
  return (
    <>
      <MenuItem disabled={busy} onClick={() => onReconnect(connection.id)}>
        <span className={ROW_LABEL}>
          <Refresh />
          Reconnect
        </span>
      </MenuItem>
      <MenuItem disabled={busy} onClick={() => onDialog("rename")}>
        <span className={ROW_LABEL}>
          <Pencil />
          Rename
        </span>
      </MenuItem>
      {connection.kind === "remote" ? (
        <>
          <MenuItem disabled={busy} onClick={() => onDialog("edit")}>
            <span className={ROW_LABEL}>
              <Pencil />
              Edit connection
            </span>
          </MenuItem>
          <MenuItem disabled={busy} onClick={() => onDialog("remove")}>
            <span className={cn(ROW_LABEL, "text-destructive")}>
              <Trash />
              Remove connection
            </span>
          </MenuItem>
        </>
      ) : (
        <MenuItem disabled={busy} onClick={() => onDialog("local-setup")}>
          <span className={ROW_LABEL}>
            <Local />
            Diagnose local Wisp
          </span>
        </MenuItem>
      )}
    </>
  )
}
