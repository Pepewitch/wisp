import type { ReactNode } from "react"
import * as Resizable from "react-resizable-panels"
import { useDefaultLayout } from "react-resizable-panels"

import { cn } from "@/lib/utils"

/**
 * Every divider in the shell is draggable, and every divider SAYS so: a
 * hairline with a 3px grip in the middle. Flow 7 made them draggable but
 * nothing told you, so nobody dragged them.
 *
 * Panes carry no border toward a handle — the handle IS the divider.
 */
function Handle({ className }: { className?: string }) {
  return (
    <Resizable.Separator
      className={cn(
        "group/handle relative flex shrink-0 items-center justify-center bg-border",
        // widen the hit area past the 1px line without moving the pixels
        "w-px after:absolute after:inset-y-0 after:left-1/2 after:w-2 after:-translate-x-1/2",
        "aria-[orientation=horizontal]:h-px aria-[orientation=horizontal]:w-full",
        "aria-[orientation=horizontal]:after:inset-x-0 aria-[orientation=horizontal]:after:left-0",
        "aria-[orientation=horizontal]:after:h-2 aria-[orientation=horizontal]:after:w-full",
        "aria-[orientation=horizontal]:after:translate-x-0 aria-[orientation=horizontal]:after:-translate-y-1/2",
        "focus-visible:outline-none data-[dragging]:bg-accent-dim",
        className,
      )}
    >
      <span
        aria-hidden
        className={cn(
          "z-(--z-pane) rounded-sm bg-border-strong transition-colors",
          "h-[26px] w-[3px] group-aria-[orientation=horizontal]/handle:h-[3px] group-aria-[orientation=horizontal]/handle:w-[26px]",
          "group-hover/handle:bg-muted-foreground",
        )}
      />
    </Resizable.Separator>
  )
}

const MAIN_LAYOUT_ID = "wisp-ui-main"
const RIGHT_LAYOUT_ID = "wisp-ui-right"

/** sidebar | centre | right — px mins, layout persisted by the library. */
export function Shell({
  sidebar,
  centre,
  right,
}: {
  sidebar: ReactNode
  centre: ReactNode
  right: ReactNode
}) {
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({ id: MAIN_LAYOUT_ID })
  return (
    <Resizable.Group
      orientation="horizontal"
      defaultLayout={defaultLayout}
      onLayoutChanged={onLayoutChanged}
      className="flex min-h-0 flex-1"
    >
      <Resizable.Panel id="sidebar" minSize={220} maxSize={380} defaultSize={268}>
        {sidebar}
      </Resizable.Panel>
      <Handle />
      <Resizable.Panel id="centre" minSize={420}>
        {centre}
      </Resizable.Panel>
      <Handle />
      <Resizable.Panel id="right" minSize={320} defaultSize={420}>
        {right}
      </Resizable.Panel>
    </Resizable.Group>
  )
}

/**
 * The right column: Changes over Terminal, split by a draggable horizontal
 * divider. Terminal used to be a tab beside Changes, which meant you could
 * never watch a test run and read its diff at the same time.
 */
export function RightColumn({ changes, terminal }: { changes: ReactNode; terminal: ReactNode }) {
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({ id: RIGHT_LAYOUT_ID })
  return (
    <Resizable.Group
      orientation="vertical"
      defaultLayout={defaultLayout}
      onLayoutChanged={onLayoutChanged}
      className="flex min-h-0 flex-1 flex-col bg-sidebar"
    >
      <Resizable.Panel id="changes" minSize={160}>
        {changes}
      </Resizable.Panel>
      <Handle />
      <Resizable.Panel id="terminal" minSize={120} defaultSize={244}>
        {terminal}
      </Resizable.Panel>
    </Resizable.Group>
  )
}
