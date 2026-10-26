import { useState, type CSSProperties } from "react"

import { ConnectionPicker } from "@/components/connection-picker"
import { Eyebrow, Rule } from "@/components/primitives"
import { TopBarLeft, TopBarTask } from "@/components/top-bar-task"
import type { ConnectionAttention } from "@/lib/connection-attention"
import type { ConnectionReachability } from "@/lib/connection-reachability"
import type { DesktopConnectionMetadata } from "@/lib/desktop-bridge"
import { TASKS } from "@/lib/fixtures"

export function ConnectionGallerySpecimen() {
  return (
    <section className="mt-9">
      <div className="mb-4 flex items-center gap-3">
        <Eyebrow>
          Desktop connections — one picker, the sidebar&apos;s width
        </Eyebrow>
        <Rule />
      </div>
      <div className="space-y-5">
        {BARS.map((bar) => (
          <div key={bar.label}>
            <Eyebrow>{bar.label}</Eyebrow>
            <ConnectionBarSpecimen {...bar} />
          </div>
        ))}
      </div>
      <p className="mt-3 text-[11.5px] leading-relaxed text-muted-foreground">
        Desktop&apos;s top bar, as wide as the window, over a stand-in sidebar.
        The left end is the traffic lights&apos; 80px, then the connection
        picker: the current connection&apos;s mark, its name and a chevron. It
        is exactly the sidebar&apos;s width, so its hairline continues the
        sidebar&apos;s divider whatever the number of connections; a long name
        truncates instead. The mark is the connection&apos;s health and nothing
        else: green while the server and live updates work, a green ring while
        updates connect, a hollow grey ring when they are delayed, and a red
        crossed-out cloud when the server cannot be reached. The menu lists
        every connection with its mark and its problem or busiest task, then
        the current connection&apos;s verbs, a reconnect for any other that is
        down, and Add connection. ←/→ on the picker steps through them.
      </p>
    </section>
  )
}

function connection(index: number, name: string): DesktopConnectionMetadata {
  return {
    id: `specimen-${index}`,
    kind: index === 0 ? "local" : "remote",
    name,
    url: index === 0 ? null : `https://host-${index}.example.test`,
    instanceId: `wisp-instance-${index}`,
    ready: true,
  }
}

const TWO = [connection(0, "Local"), connection(1, "Build host")]
const FOUR = [
  connection(0, "Local"),
  connection(1, "Staging build host in the west region"),
  connection(2, "Research workstation under the stairs"),
  connection(3, "Release qualification runner"),
]

interface Bar {
  label: string
  connections: DesktopConnectionMetadata[]
  activeId: string
  /** the sidebar's width in px: the app's default 268, or its 220 minimum */
  sidebar: number
  offline?: string[]
  attention?: [string, ConnectionAttention][]
}

const BARS: Bar[] = [
  { label: "One connection", connections: TWO.slice(0, 1), activeId: "specimen-0", sidebar: 268 },
  {
    label: "Two connections · a remote down",
    connections: TWO,
    activeId: "specimen-0",
    sidebar: 268,
    offline: ["specimen-1"],
  },
  {
    label: "Four long names · the sidebar at its 220px minimum",
    connections: FOUR,
    activeId: "specimen-1",
    sidebar: 220,
    offline: ["specimen-3"],
    attention: [["specimen-2", "needs-input"]],
  },
  {
    label: "The current connection is down",
    connections: TWO,
    activeId: "specimen-1",
    sidebar: 268,
    offline: ["specimen-1"],
  },
]

/** The real left end, picker and task title, as wide as the viewport, over a stand-in sidebar. */
function ConnectionBarSpecimen({ connections, activeId, sidebar, offline = [], attention = [] }: Bar) {
  const [active, setActive] = useState(activeId)
  const reachability = new Map<string, ConnectionReachability>(
    connections.map((entry) => [entry.id, offline.includes(entry.id) ? "offline" : "online"])
  )
  return (
    <div
      data-connection-bar={connections.length}
      style={{ "--sidebar-width": `${sidebar}px` } as CSSProperties}
      // out of the gallery's column, so the bar is the window's width as in the app
      className="relative left-1/2 mt-2 w-dvw -translate-x-1/2 border-y border-border"
    >
      <div className="flex h-9 items-center border-b border-border bg-surface pr-3">
        <TopBarLeft desktop>
          <ConnectionPicker
            connections={connections}
            activeId={active}
            reachability={reachability}
            attention={new Map(attention)}
            onSelect={setActive}
            onReconnect={() => undefined}
            onDialog={() => undefined}
          />
        </TopBarLeft>
        <div className="flex h-full min-w-0 flex-1 items-center pl-4.5">
          <TopBarTask task={TASKS[0]!} dragRegion={false} />
        </div>
      </div>
      <div className="flex h-12">
        <div data-sidebar-standin className="w-(--sidebar-width) shrink-0 bg-sidebar" />
        <div className="w-px shrink-0 bg-border" />
        <div className="flex-1 bg-background" />
      </div>
    </div>
  )
}
