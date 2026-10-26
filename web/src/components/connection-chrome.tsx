import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"

import {
  ConnectionDialogs,
  ConnectionErrorDialog,
  type ConnectionDialogMode,
} from "@/components/connection-dialogs"
import { ConnectionGlyph, ConnectionPicker } from "@/components/connection-picker"
import { Local, More, Pencil, Refresh, Trash } from "@/components/icons"
import {
  Menu,
  MenuAction,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
} from "@/components/menu"
import { connectionIssue } from "@/lib/connection-reachability"
import { MAX_DESKTOP_CONNECTIONS } from "@/lib/desktop-bridge"
import { useDesktopConnections } from "@/lib/desktop-connections"
import { STATE_LABEL } from "@/lib/state"
import { uiIntentsFor } from "@/lib/ui-intents"

const ADD_CONNECTION_ACTION = "__add_connection__"

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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
  const connections = useMemo(
    () => desktop.connections.map((entry) => entry.metadata),
    [desktop.connections]
  )

  return (
    <>
      <ConnectionPicker
        connections={connections}
        activeId={desktop.active.metadata.id}
        reachability={desktop.reachability}
        attention={desktop.attention}
        busy={desktop.pendingAction !== null}
        onSelect={(connectionId) => void desktop.select(connectionId)}
        onReconnect={(connectionId) => {
          void desktop
            .reconnect({ connectionId })
            .catch((error: unknown) => setActionError(errorMessage(error)))
        }}
        onDialog={setDialog}
      />
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

/** The touch shell's `⋯` beside its connection menu: the selected connection's verbs. */
function ActiveConnectionActions({
  onDialog,
  onError,
  disabled,
}: {
  onDialog: (mode: ConnectionDialogMode) => void
  onError: (error: string) => void
  disabled: boolean
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
      align="end"
      className="size-11"
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
