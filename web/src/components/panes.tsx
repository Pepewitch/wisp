import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react"
import * as Resizable from "react-resizable-panels"
import { useDefaultLayout, usePanelRef, type Layout } from "react-resizable-panels"

import {
  DOCK_LAYOUT_ID,
  MAIN_LAYOUT_ID,
  migrateSavedLayouts,
  PANEL_MIN_WIDTH,
  readPanelWidth,
  writePanelWidth,
} from "@/lib/pane-layouts"
import { cn } from "@/lib/utils"

/**
 * Every divider in the shell is draggable, and every divider SAYS so: a
 * hairline with a 3px grip in the middle. Flow 7 made them draggable but
 * nothing told you, so nobody dragged them.
 *
 * Panes carry no border toward a handle — the handle IS the divider. A
 * `disabled` handle is one whose neighbour is closed: it is not drawn, and
 * it cannot drag a closed panel open.
 */
function Handle({ className, disabled = false }: { className?: string; disabled?: boolean }) {
  return (
    <Resizable.Separator
      disabled={disabled}
      className={cn(
        "group/handle relative flex shrink-0 items-center justify-center bg-border",
        // widen the hit area past the 1px line without moving the pixels
        "w-px after:absolute after:inset-y-0 after:left-1/2 after:w-2 after:-translate-x-1/2",
        "aria-[orientation=horizontal]:h-px aria-[orientation=horizontal]:w-full",
        "aria-[orientation=horizontal]:after:inset-x-0 aria-[orientation=horizontal]:after:left-0",
        "aria-[orientation=horizontal]:after:h-2 aria-[orientation=horizontal]:after:w-full",
        "aria-[orientation=horizontal]:after:translate-x-0 aria-[orientation=horizontal]:after:-translate-y-1/2",
        "focus-visible:outline-none data-[dragging]:bg-accent-dim",
        disabled && "hidden",
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

/**
 * sidebar | centre | tool panel — px mins, layout persisted by the library.
 *
 * The tool panel is collapsible and closed by default, so the reading column
 * has the room. `panelOpen` drives it: opening glides it out to the width the
 * person last dragged it to (one width for every task), closing glides it
 * shut, quicker. Dragging its divider past the minimum closes it too, and
 * `onPanelDraggedShut` tells the owner so the top bar agrees.
 */
export function Shell({
  sidebar,
  centre,
  panel,
  panelOpen,
  onPanelDraggedShut,
  onSidebarResize,
}: {
  sidebar: ReactNode
  centre: ReactNode
  panel: ReactNode
  panelOpen: boolean
  onPanelDraggedShut?: () => void
  /** the sidebar's width in px, on every change — the top bar lines its task up with the centre */
  onSidebarResize?: (px: number) => void
}) {
  // before the library's first read of its new id
  useState(() => migrateSavedLayouts())
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({ id: MAIN_LAYOUT_ID })
  const panelRef = usePanelRef()
  const [glide, endGlide] = usePanelGlide(panelOpen)
  const shut = useRef(onPanelDraggedShut)
  useEffect(() => {
    shut.current = onPanelDraggedShut
  }, [onPanelDraggedShut])

  useLayoutEffect(() => {
    const handle = panelRef.current
    if (!handle) return
    if (panelOpen && handle.isCollapsed()) handle.resize(readPanelWidth())
    else if (!panelOpen && !handle.isCollapsed()) handle.collapse()
  }, [panelOpen, panelRef])

  const layoutChanged = (layout: Layout, meta: { isUserInteraction: boolean }) => {
    onLayoutChanged(layout, meta)
    if (!meta.isUserInteraction) return
    if ((layout.tool ?? 0) > 0) {
      const px = panelRef.current?.getSize().inPixels
      if (px && px >= PANEL_MIN_WIDTH) writePanelWidth(px)
    } else if (panelOpen) {
      shut.current?.()
    }
  }

  return (
    <Resizable.Group
      orientation="horizontal"
      defaultLayout={defaultLayout}
      onLayoutChanged={layoutChanged}
      data-glide={glide ?? undefined}
      onTransitionEnd={(event) => {
        if (event.propertyName === "flex-grow") endGlide()
      }}
      className="flex min-h-0 flex-1"
    >
      <Resizable.Panel
        id="sidebar"
        minSize={220}
        maxSize={380}
        defaultSize={268}
        onResize={(size) => onSidebarResize?.(size.inPixels)}
      >
        {sidebar}
      </Resizable.Panel>
      <Handle />
      <Resizable.Panel id="centre" minSize={420}>
        {centre}
      </Resizable.Panel>
      <Handle disabled={!panelOpen} />
      <Resizable.Panel
        id="tool"
        panelRef={panelRef}
        collapsible
        collapsedSize={0}
        minSize={PANEL_MIN_WIDTH}
        defaultSize={0}
        // clip rather than scroll while it glides: the content keeps its own scrollers
        style={{ overflow: "hidden" }}
      >
        {panel}
      </Resizable.Panel>
    </Resizable.Group>
  )
}

/**
 * Mark the group while the panel opens or closes, so `index.css` animates the
 * panels' flex-grow for exactly that long and no longer: a divider drag must
 * follow the pointer, not ease after it. Set in the same render as the change
 * it animates — a transition takes its timing from the style it changes to —
 * and cleared when the transition ends, or after a beat when there is none
 * (`prefers-reduced-motion`). The first render never glides: a reload
 * restores the layout, it does not perform it.
 */
function usePanelGlide(open: boolean): readonly ["in" | "out" | null, () => void] {
  const [seen, setSeen] = useState(open)
  const [glide, setGlide] = useState<"in" | "out" | null>(null)
  if (seen !== open) {
    setSeen(open)
    setGlide(open ? "in" : "out")
  }
  useEffect(() => {
    if (glide === null) return
    const timer = setTimeout(() => setGlide(null), GLIDE_FALLBACK_MS)
    return () => clearTimeout(timer)
  }, [glide])
  return [glide, () => setGlide(null)] as const
}

/** Longer than either glide token, so the transition always ends first when there is one. */
const GLIDE_FALLBACK_MS = 400

/**
 * The tool panel's content: one tool, the Terminal, or the tool with the
 * Terminal docked below it, split by a draggable divider. The dock is the
 * one exception to one-tool-at-a-time, because watching tests while reading
 * the diff is the common pair (it was the always-open column's split).
 *
 * Closing hides; it never unmounts. Every tool stays mounted, so a diff
 * keeps its scroll and a shell keeps running with its scrollback. The
 * Terminal alone waits to mount until it is first shown for a task, so
 * selecting a task does not start a shell nobody asked for.
 *
 * Esc closes the tool when focus is in it and nothing inside wanted the key.
 * Inside the Terminal, Esc is the shell's; ⌃` closes it there.
 */
export function ToolPanel({
  tool,
  terminal,
  terminalKey,
  toolOpen,
  terminalOpen,
  onCloseTool,
  onCloseTerminal,
}: {
  tool: ReactNode
  terminal: ReactNode
  /** whose terminal this is: a new key waits for its first showing before it mounts */
  terminalKey: string
  toolOpen: boolean
  terminalOpen: boolean
  onCloseTool: () => void
  onCloseTerminal: () => void
}) {
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({ id: DOCK_LAYOUT_ID })
  const toolRef = usePanelRef()
  const terminalRef = usePanelRef()
  const docked = toolOpen && terminalOpen

  const [mountedFor, setMountedFor] = useState<string | null>(null)
  if (terminalOpen && mountedFor !== terminalKey) setMountedFor(terminalKey)

  useLayoutEffect(() => {
    const toolPanel = toolRef.current
    const terminalPanel = terminalRef.current
    if (!toolPanel || !terminalPanel || (!toolOpen && !terminalOpen)) return
    // expand first, so a collapse never leaves the group with nothing to fill it
    if (toolOpen) toolPanel.expand()
    if (terminalOpen) terminalPanel.expand()
    if (!terminalOpen) terminalPanel.collapse()
    if (!toolOpen) toolPanel.collapse()
  }, [toolOpen, terminalOpen, toolRef, terminalRef])

  const toolRegion = useRef<HTMLDivElement>(null)
  const close = useRef(onCloseTool)
  useEffect(() => {
    close.current = onCloseTool
  }, [onCloseTool])
  useEffect(() => {
    // native, not React's onKeyDown: a menu portalled out of a pane must not
    // close the pane with the Esc that was closing the menu
    const element = toolRegion.current
    if (!element) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return
      const target = event.target
      if (target instanceof HTMLElement && (target.isContentEditable || target.closest("input, textarea, select"))) return
      close.current()
    }
    element.addEventListener("keydown", onKeyDown)
    return () => element.removeEventListener("keydown", onKeyDown)
  }, [])

  return (
    <Resizable.Group
      orientation="vertical"
      defaultLayout={defaultLayout}
      onLayoutChanged={(layout, meta) => {
        const toolShut = (layout.tool ?? 0) === 0
        const terminalShut = (layout.terminal ?? 0) === 0
        // only the docked split is worth remembering; a collapsed half is a mode, not a size
        if (!toolShut && !terminalShut) onLayoutChanged(layout, meta)
        // A person who drags (or Home/End-keys) the divider to an end has
        // closed that half, so the top bar and the next pick must agree: a
        // tool still counted open while it has no height would leave the
        // next tool selected with no height either.
        if (!meta.isUserInteraction || !docked) return
        if (toolShut) onCloseTool()
        else if (terminalShut) onCloseTerminal()
      }}
      className="flex min-h-0 flex-1 flex-col bg-sidebar"
    >
      <Resizable.Panel id="tool" panelRef={toolRef} collapsible collapsedSize={0} minSize={160}>
        <div ref={toolRegion} data-tool-region="tool" className={cn("h-full min-h-0 flex-col", toolOpen ? "flex" : "hidden")}>
          {tool}
        </div>
      </Resizable.Panel>
      <Handle disabled={!docked} />
      <Resizable.Panel id="terminal" panelRef={terminalRef} collapsible collapsedSize={0} minSize={120} defaultSize={244}>
        <div data-tool-region="terminal" className={cn("h-full min-h-0 flex-col", terminalOpen ? "flex" : "hidden")}>
          {mountedFor === terminalKey && terminal}
        </div>
      </Resizable.Panel>
    </Resizable.Group>
  )
}
