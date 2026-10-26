import { ConnectionTab, ConnectionTabList, TAB_ACTION_SIZE } from "@/components/connection-chrome"
import { More, Plus } from "@/components/icons"
import { Button, Eyebrow, Rule } from "@/components/primitives"
import type { DesktopConnectionMetadata } from "@/lib/desktop-bridge"

export function ConnectionGallerySpecimen() {
  return (
    <section className="mt-9">
      <div className="mb-4 flex items-center gap-3">
        <Eyebrow>
          Desktop connections — identity, selection and health
        </Eyebrow>
        <Rule />
      </div>
      <div className="rounded-xl border border-border bg-surface p-5">
        <ConnectionChromeSpecimen />
        <p className="mt-3 text-[11.5px] leading-relaxed text-muted-foreground">
          Local is always first and uses a computer; remotes use a cloud.
          Selection stays neutral. The connection dot is green while the server
          and live updates work, rings green while updates connect, and turns
          to a hollow grey ring when updates are delayed. When the server
          cannot be reached, a red crossed-out cloud replaces the dot. Click
          either to reconnect. The tab says nothing about tasks: one mark, one
          meaning, whether or not the tab is selected.
        </p>
      </div>
    </section>
  )
}

/** The gallery's static rendering of the production tab and action components. */
export function ConnectionChromeSpecimen() {
  return (
    <div className="flex h-9 items-center gap-1 rounded-lg border border-border bg-surface px-2">
      <ConnectionTabsSpecimen connections={SPECIMEN_CONNECTIONS} />
    </div>
  )
}

const SPECIMEN_CONNECTIONS: readonly DesktopConnectionMetadata[] = [
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

/**
 * The connection chips and the add button as Desktop draws them, for the
 * gallery. The first connection is the active one; the third is offline.
 */
export function ConnectionTabsSpecimen({
  connections,
}: {
  connections: readonly DesktopConnectionMetadata[]
}) {
  return (
    <div className="flex min-w-0 items-center gap-1">
      <ConnectionTabList>
        {connections.map((connection, index) => (
          <ConnectionTab
            key={connection.id}
            connection={connection}
            active={index === 0}
            reachability={index === 2 ? "offline" : "online"}
            onSelect={() => undefined}
            onReconnect={() => undefined}
            actions={
              index === 0 ? (
                <Button
                  size="sm"
                  icon
                  aria-label={`Manage ${connection.name}`}
                  className={TAB_ACTION_SIZE}
                >
                  <More />
                </Button>
              ) : undefined
            }
          />
        ))}
      </ConnectionTabList>
      <Button size="sm" icon aria-label="Add remote connection">
        <Plus />
      </Button>
    </div>
  )
}
