import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react"

import {
  ConnectionDialogs,
  ConnectionErrorDialog,
  type ConnectionDialogMode,
} from "@/components/connection-dialogs"

import {
  Local,
  More,
  Offline,
  Pencil,
  Plus,
  Refresh,
  Remote,
  Trash,
} from "@/components/icons"
import {
  Menu,
  MenuAction,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
} from "@/components/menu"
import { Button, StateDot, Tab } from "@/components/primitives"
import { connectionStore } from "@/lib/conn"
import {
  MAX_DESKTOP_CONNECTIONS,
  type DesktopConnectionMetadata,
} from "@/lib/desktop-bridge"
import {
  type ConnectionReachability,
} from "@/lib/connection-reachability"
import { useDesktopConnections } from "@/lib/desktop-connections"
import { STATE_LABEL } from "@/lib/state"
import { uiIntentsFor } from "@/lib/ui-intents"
import type { TaskState } from "@/lib/types"
import { cn } from "@/lib/utils"

const DIRECT_CONNECTION_LIMIT = 4
/** The trailing control inside a tab chip: shorter than the 26px standalone glyph. */
const TAB_ACTION_SIZE = "size-5 shrink-0 rounded-[5px]"
const ADD_CONNECTION_ACTION = "__add_connection__"

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function splitConnections<T extends { metadata: DesktopConnectionMetadata }>(
  connections: readonly T[],
  activeId: string
): { direct: readonly T[]; overflow: readonly T[] } {
  if (connections.length <= DIRECT_CONNECTION_LIMIT)
    return { direct: connections, overflow: [] }
  const local = connections[0]!
  const remotes = connections.slice(1)
  const directRemotes = remotes.slice(0, DIRECT_CONNECTION_LIMIT - 1)
  const active = remotes.find((entry) => entry.metadata.id === activeId)
  if (active && !directRemotes.includes(active))
    directRemotes[directRemotes.length - 1] = active
  const direct = [local, ...directRemotes]
  return {
    direct,
    overflow: connections.filter((entry) => !direct.includes(entry)),
  }
}

function ConnectionGlyph({
  kind,
}: {
  kind: DesktopConnectionMetadata["kind"]
}) {
  return kind === "local" ? <Local aria-hidden /> : <Remote aria-hidden />
}

function connectionIssue(
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

/**
 * One connection tab, its independent reconnect button, and — when selected —
 * its management menu, inside the same chip.
 *
 * The menu used to sit past the `+` button, two controls away from the tab it
 * acted on, so "…" beside a row of connections read as "more connections"
 * while it actually opened the ACTIVE one's settings. It belongs to the tab,
 * so it is drawn in the tab: the chip carries the selected background and the
 * tab button goes transparent inside it, which keeps one accent shape on
 * screen rather than a chip with a second button bolted to its side.
 *
 * Buttons cannot nest: reconnect and manage are SIBLINGS of the tab, and the
 * tablist's arrow keys still find `[role=tab]` alone.
 */
export function ConnectionTab({
  connection,
  active,
  attention,
  reachability = "unknown",
  onSelect,
  onReconnect,
  reconnectDisabled = false,
  actions,
}: {
  connection: DesktopConnectionMetadata
  active: boolean
  attention?: Exclude<TaskState, "done"> | null
  reachability?: ConnectionReachability
  onSelect: () => void
  onReconnect: () => void
  reconnectDisabled?: boolean
  /** The active tab's own menu; nothing at all on the others. */
  actions?: ReactNode
}) {
  const store = connectionStore(connection.id)
  const streamsLive = useSyncExternalStore(store.subscribe, store.isLive)
  const issue = connectionIssue(connection, reachability)
  const unavailable = issue !== null
  // Only the selected connection mounts both UI streams. Background connections
  // use their own daemon monitor instead of a stale/default stream snapshot.
  const live = connection.ready && reachability === "online" && (!active || streamsLive)
  return (
    <span
      data-testid="connection-tab-chip"
      className={cn(
        "flex min-w-0 shrink-0 items-center rounded-md pr-0.5",
        active && "bg-accent"
      )}
    >
      <Tab
        role="tab"
        aria-selected={active}
        tabIndex={active ? 0 : -1}
        active={active}
        onClick={onSelect}
        title={`${connection.name} · ${connection.kind === "local" ? "This Mac" : "Remote"}${issue ? ` · ${issue}` : ""}`}
        className={cn("min-w-0 max-w-40 pr-1", active && "bg-transparent")}
      >
        <span className="[&>svg]:size-3.5 [&>svg]:text-muted-foreground">
          <ConnectionGlyph kind={connection.kind} />
        </span>
        <span className="truncate">{connection.name}</span>
        {attention && <span className="sr-only">{STATE_LABEL[attention]}</span>}
        {unavailable && <span className="sr-only">{issue}</span>}
      </Tab>
      <button
        type="button"
        aria-label={`Reconnect ${connection.name}`}
        title={live ? "Live" : issue ?? "Reconnecting…"}
        disabled={reconnectDisabled}
        onClick={onReconnect}
        className="flex size-5 shrink-0 items-center justify-center rounded-[5px] hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-45"
      >
        <span
          data-live={live}
          className={cn(
            "size-1.5 rounded-full",
            live ? "bg-state-done" : "animate-pulse bg-state-needs-input"
          )}
        />
      </button>
      {attention && <StateDot state={attention} className="ml-0.5" />}
      {unavailable && (
        <span
          title={issue ?? undefined}
          className="ml-0.5 text-destructive [&>svg]:size-3"
        >
          <Offline aria-hidden />
        </span>
      )}
      {actions}
    </span>
  )
}

/** The gallery's static rendering of the production tab and action components. */
export function ConnectionChromeSpecimen() {
  const connections: readonly DesktopConnectionMetadata[] = [
    {
      id: "local",
      kind: "local",
      name: "Local",
      url: null,
      instanceId: "wisp-instance-local",
      ready: true,
    },
    {
      id: "remote-alpha",
      kind: "remote",
      name: "Build host",
      url: "https://build.example.test",
      instanceId: "wisp-instance-build",
      ready: true,
    },
    {
      id: "remote-beta",
      kind: "remote",
      name: "Lab",
      url: "https://lab.example.test",
      instanceId: "wisp-instance-lab",
      ready: true,
    },
  ]
  return (
    <div className="flex h-9 items-center gap-1 rounded-lg border border-border bg-surface px-2">
      <div
        role="tablist"
        aria-label="Daemon connections"
        className="flex items-center gap-0.5"
      >
        {connections.map((connection, index) => (
          <ConnectionTab
            key={connection.id}
            connection={connection}
            active={index === 0}
            attention={
              index === 1 ? "needs-input" : index === 2 ? "running" : null
            }
            reachability={index === 2 ? "offline" : "online"}
            onSelect={() => undefined}
            onReconnect={() => undefined}
            actions={
              index === 0 ? (
                <Button
                  size="sm"
                  icon
                  aria-label="Manage Local"
                  className={TAB_ACTION_SIZE}
                >
                  <More />
                </Button>
              ) : undefined
            }
          />
        ))}
      </div>
      <Button size="sm" icon aria-label="Add remote connection">
        <Plus />
      </Button>
    </div>
  )
}

export function DesktopConnectionChrome({
  mobile = false,
}: {
  mobile?: boolean
}) {
  const desktop = useDesktopConnections()
  if (!desktop) return null
  return mobile ? <MobileConnections /> : <DesktopConnections />
}

/**
 * The Local Wisp dialog has THREE callers and owns none of them: this menu,
 * the first-run panel's blocked step, and the sidebar's error row. The two
 * outside callers issue an intent rather than reaching for this component's
 * state — it is mounted once per shell and there are two shells.
 *
 * Requests older than the mount are history, so the seed captures the current
 * count. A request that arrives while a REMOTE tab is active is dropped: this
 * dialog diagnoses the local profile and has nothing to say about a remote.
 */
function useLocalSetupIntent(
  onDialog: (mode: ConnectionDialogMode) => void
): void {
  const desktop = useDesktopConnections()!
  const active = desktop.active.metadata
  const intents = uiIntentsFor(active.id)
  const requests = useSyncExternalStore(
    intents.subscribe,
    intents.localSetupRequests
  )
  const answered = useRef(requests)
  useEffect(() => {
    if (requests === answered.current) return
    answered.current = requests
    if (active.kind === "local") onDialog("local-setup")
  }, [active.kind, onDialog, requests])
}

function DesktopConnections() {
  const desktop = useDesktopConnections()!
  const [dialog, setDialog] = useState<ConnectionDialogMode>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  useLocalSetupIntent(setDialog)
  const split = useMemo(
    () => splitConnections(desktop.connections, desktop.active.metadata.id),
    [desktop.connections, desktop.active.metadata.id]
  )
  const canAdd = desktop.connections.length < MAX_DESKTOP_CONNECTIONS

  const activateByKeyboard = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (
      event.key !== "ArrowLeft" &&
      event.key !== "ArrowRight" &&
      event.key !== "Home" &&
      event.key !== "End"
    )
      return
    const tabs = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>("[role=tab]")
    )
    const current = tabs.indexOf(document.activeElement as HTMLButtonElement)
    if (tabs.length === 0 || current < 0) return
    event.preventDefault()
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? tabs.length - 1
          : event.key === "ArrowRight"
            ? (current + 1) % tabs.length
            : (current - 1 + tabs.length) % tabs.length
    tabs[next]?.focus()
    tabs[next]?.click()
  }

  return (
    <>
      <div className="flex min-w-0 items-center gap-1">
        <div
          role="tablist"
          aria-label="Daemon connections"
          className="flex min-w-0 items-center gap-0.5"
          onKeyDown={activateByKeyboard}
        >
          {split.direct.map((entry) => {
            const active = entry.metadata.id === desktop.active.metadata.id
            const attention = !active
              ? desktop.attention.get(entry.metadata.id)
              : null
            return (
              <ConnectionTab
                key={entry.metadata.id}
                connection={entry.metadata}
                active={active}
                attention={attention}
                reachability={desktop.reachability.get(entry.metadata.id)}
                onSelect={() => void desktop.select(entry.metadata.id)}
                onReconnect={() => {
                  void desktop
                    .reconnect({ connectionId: entry.metadata.id })
                    .catch((error: unknown) => setActionError(errorMessage(error)))
                }}
                reconnectDisabled={desktop.pendingAction !== null}
                actions={
                  active ? (
                    <ActiveConnectionActions
                      onDialog={setDialog}
                      onError={setActionError}
                      disabled={desktop.pendingAction !== null}
                    />
                  ) : undefined
                }
              />
            )
          })}
        </div>

        {split.overflow.length > 0 && (
          <Menu label="More connections" icon={<More />} iconOnly>
            <MenuRadioGroup
              value={desktop.active.metadata.id}
              onValueChange={(value) => void desktop.select(value)}
            >
              {split.overflow.map((entry) => (
                <MenuRadioItem
                  key={entry.metadata.id}
                  value={entry.metadata.id}
                  hint={
                    connectionIssue(
                      entry.metadata,
                      desktop.reachability.get(entry.metadata.id)
                    ) ??
                    (desktop.attention.get(entry.metadata.id)
                      ? STATE_LABEL[desktop.attention.get(entry.metadata.id)!]
                      : undefined)
                  }
                >
                  <span className="flex items-center gap-2 [&>svg]:size-3.5 [&>svg]:text-muted-foreground">
                    <ConnectionGlyph kind={entry.metadata.kind} />
                    {entry.metadata.name}
                  </span>
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </Menu>
        )}

        <Button
          size="sm"
          icon
          disabled={!canAdd || desktop.pendingAction !== null}
          aria-label={
            canAdd
              ? "Add remote connection"
              : `At most ${MAX_DESKTOP_CONNECTIONS} connections`
          }
          title={
            canAdd
              ? "Add remote connection"
              : `At most ${MAX_DESKTOP_CONNECTIONS} connections`
          }
          onClick={() => setDialog("add")}
        >
          <Plus />
        </Button>
      </div>
      <ConnectionDialogs
        dialog={dialog}
        onDialog={setDialog}
        onError={setActionError}
      />
      <ConnectionErrorDialog
        error={actionError ?? desktop.actionError}
        onClose={() => {
          setActionError(null)
          desktop.clearActionError()
        }}
      />
    </>
  )
}

function MobileConnections() {
  const desktop = useDesktopConnections()!
  const [dialog, setDialog] = useState<ConnectionDialogMode>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  useLocalSetupIntent(setDialog)
  const canAdd = desktop.connections.length < MAX_DESKTOP_CONNECTIONS
  return (
    <>
      <div className="flex min-w-0 items-center gap-1">
        <Menu
          label={desktop.active.metadata.name}
          icon={<ConnectionGlyph kind={desktop.active.metadata.kind} />}
          className="h-11 max-w-44 min-w-0"
        >
          <MenuRadioGroup
            value={desktop.active.metadata.id}
            onValueChange={(value) => {
              if (value === ADD_CONNECTION_ACTION && canAdd) setDialog("add")
              else void desktop.select(value)
            }}
          >
            {desktop.connections.map((entry) => (
              <MenuRadioItem
                key={entry.metadata.id}
                value={entry.metadata.id}
                hint={
                  connectionIssue(
                    entry.metadata,
                    desktop.reachability.get(entry.metadata.id)
                  ) ??
                  (desktop.attention.get(entry.metadata.id)
                    ? STATE_LABEL[desktop.attention.get(entry.metadata.id)!]
                    : undefined)
                }
              >
                <span className="flex items-center gap-2 [&>svg]:size-3.5 [&>svg]:text-muted-foreground">
                  <ConnectionGlyph kind={entry.metadata.kind} />
                  {entry.metadata.name}
                </span>
              </MenuRadioItem>
            ))}
            <MenuAction value={ADD_CONNECTION_ACTION} disabled={!canAdd}>
              {canAdd
                ? "Add remote connection"
                : `At most ${MAX_DESKTOP_CONNECTIONS} connections`}
            </MenuAction>
          </MenuRadioGroup>
        </Menu>
        <ActiveConnectionActions
          onDialog={setDialog}
          onError={setActionError}
          disabled={desktop.pendingAction !== null}
          mobile
        />
      </div>
      <ConnectionDialogs
        dialog={dialog}
        onDialog={setDialog}
        onError={setActionError}
      />
      <ConnectionErrorDialog
        error={actionError ?? desktop.actionError}
        onClose={() => {
          setActionError(null)
          desktop.clearActionError()
        }}
      />
    </>
  )
}

function ActiveConnectionActions({
  onDialog,
  onError,
  disabled,
  mobile = false,
}: {
  onDialog: (mode: ConnectionDialogMode) => void
  onError: (error: string) => void
  disabled: boolean
  mobile?: boolean
}) {
  const desktop = useDesktopConnections()!
  const active = desktop.active.metadata
  const run = (action: () => Promise<unknown>) => {
    void action().catch((error: unknown) => onError(errorMessage(error)))
  }
  return (
    <Menu
      label={`Manage ${active.name}`}
      icon={<More />}
      iconOnly
      disabled={disabled}
      // The trigger sits in the tab row now, not at the right edge of the
      // chrome: a menu that opened leftward from here would reach for an edge
      // that is no longer beside it.
      align={mobile ? "end" : "start"}
      className={mobile ? "size-11" : TAB_ACTION_SIZE}
    >
      <MenuItem onClick={() => onDialog("rename")}>
        <span className="flex items-center gap-2 [&>svg]:size-3.5">
          <Pencil />
          Rename
        </span>
      </MenuItem>
      {active.kind === "remote" ? (
        <>
          <MenuItem onClick={() => onDialog("edit")}>
            <span className="flex items-center gap-2 [&>svg]:size-3.5">
              <Pencil />
              Edit connection
            </span>
          </MenuItem>
          <MenuItem onClick={() => onDialog("edit")}>
            <span className="flex items-center gap-2 [&>svg]:size-3.5">
              <Refresh />
              Reconnect
            </span>
          </MenuItem>
          <MenuItem onClick={() => onDialog("remove")}>
            <span className="flex items-center gap-2 text-destructive [&>svg]:size-3.5">
              <Trash />
              Remove connection
            </span>
          </MenuItem>
        </>
      ) : (
        <>
          <MenuItem
            onClick={() =>
              run(() => desktop.reconnect({ connectionId: active.id }))
            }
          >
            <span className="flex items-center gap-2 [&>svg]:size-3.5">
              <Refresh />
              Reconnect
            </span>
          </MenuItem>
          <MenuItem onClick={() => onDialog("local-setup")}>
            <span className="flex items-center gap-2 [&>svg]:size-3.5">
              <Local />
              Diagnose local Wisp
            </span>
          </MenuItem>
        </>
      )}
      <MenuItem onClick={() => onDialog("reset")}>
        <span className="flex items-center gap-2 text-destructive [&>svg]:size-3.5">
          <Trash />
          Reset desktop data
        </span>
      </MenuItem>
    </Menu>
  )
}
