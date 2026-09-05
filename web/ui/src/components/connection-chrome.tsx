import { useMemo, useState } from "react"

import {
  ConnectionDialogs,
  ConnectionErrorDialog,
  type ConnectionDialogMode,
} from "@/components/connection-dialogs"

import {
  Local,
  More,
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
import {
  MAX_DESKTOP_CONNECTIONS,
  type DesktopConnectionMetadata,
} from "@/lib/desktop-bridge"
import { useDesktopConnections } from "@/lib/desktop-connections"
import { STATE_LABEL } from "@/lib/state"
import type { TaskState } from "@/lib/types"

const DIRECT_CONNECTION_LIMIT = 4
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

export function ConnectionTab({
  connection,
  active,
  attention,
  onSelect,
}: {
  connection: DesktopConnectionMetadata
  active: boolean
  attention?: Exclude<TaskState, "done"> | null
  onSelect: () => void
}) {
  return (
    <Tab
      role="tab"
      aria-selected={active}
      tabIndex={active ? 0 : -1}
      active={active}
      onClick={onSelect}
      title={connection.name}
      className="max-w-40"
    >
      <span className="[&>svg]:size-3.5 [&>svg]:text-muted-foreground">
        <ConnectionGlyph kind={connection.kind} />
      </span>
      <span className="truncate">{connection.name}</span>
      {attention && <StateDot state={attention} className="ml-0.5" />}
      {attention && <span className="sr-only">{STATE_LABEL[attention]}</span>}
    </Tab>
  )
}

/** The gallery's static rendering of the production tab and action components. */
export function ConnectionChromeSpecimen() {
  const connections: readonly DesktopConnectionMetadata[] = [
    { id: "local", kind: "local", name: "Local", url: null },
    {
      id: "remote-alpha",
      kind: "remote",
      name: "Build host",
      url: "https://build.example.test",
    },
    {
      id: "remote-beta",
      kind: "remote",
      name: "Lab",
      url: "https://lab.example.test",
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
            onSelect={() => undefined}
          />
        ))}
      </div>
      <Button size="sm" icon aria-label="Add remote connection">
        <Plus />
      </Button>
      <Button size="sm" icon aria-label="Manage Local">
        <More />
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

function DesktopConnections() {
  const desktop = useDesktopConnections()!
  const [dialog, setDialog] = useState<ConnectionDialogMode>(null)
  const [actionError, setActionError] = useState<string | null>(null)
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
                onSelect={() => desktop.select(entry.metadata.id)}
              />
            )
          })}
        </div>

        {split.overflow.length > 0 && (
          <Menu label="More connections" icon={<More />} iconOnly>
            <MenuRadioGroup
              value={desktop.active.metadata.id}
              onValueChange={desktop.select}
            >
              {split.overflow.map((entry) => (
                <MenuRadioItem
                  key={entry.metadata.id}
                  value={entry.metadata.id}
                  hint={
                    desktop.attention.get(entry.metadata.id)
                      ? STATE_LABEL[desktop.attention.get(entry.metadata.id)!]
                      : undefined
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
        <ActiveConnectionActions
          onDialog={setDialog}
          onError={setActionError}
          disabled={desktop.pendingAction !== null}
        />
      </div>
      <ConnectionDialogs dialog={dialog} onDialog={setDialog} />
      <ConnectionErrorDialog
        error={actionError}
        onClose={() => setActionError(null)}
      />
    </>
  )
}

function MobileConnections() {
  const desktop = useDesktopConnections()!
  const [dialog, setDialog] = useState<ConnectionDialogMode>(null)
  const [actionError, setActionError] = useState<string | null>(null)
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
              else desktop.select(value)
            }}
          >
            {desktop.connections.map((entry) => (
              <MenuRadioItem
                key={entry.metadata.id}
                value={entry.metadata.id}
                hint={
                  desktop.attention.get(entry.metadata.id)
                    ? STATE_LABEL[desktop.attention.get(entry.metadata.id)!]
                    : undefined
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
      <ConnectionDialogs dialog={dialog} onDialog={setDialog} />
      <ConnectionErrorDialog
        error={actionError}
        onClose={() => setActionError(null)}
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
  const run = (action: () => Promise<void>) => {
    void action().catch((error: unknown) => onError(errorMessage(error)))
  }
  return (
    <Menu
      label={`Manage ${active.name}`}
      icon={<More />}
      iconOnly
      disabled={disabled}
      align="end"
      className={mobile ? "size-11" : undefined}
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
          <MenuItem onClick={() => onDialog("remove")}>
            <span className="flex items-center gap-2 text-destructive [&>svg]:size-3.5">
              <Trash />
              Remove connection
            </span>
          </MenuItem>
        </>
      ) : (
        <MenuItem onClick={() => run(desktop.setupLocalWisp)}>
          <span className="flex items-center gap-2 [&>svg]:size-3.5">
            <Refresh />
            Set up local Wisp
          </span>
        </MenuItem>
      )}
    </Menu>
  )
}
