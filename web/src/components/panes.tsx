import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react"
import * as Resizable from "react-resizable-panels"
import { useDefaultLayout, useGroupRef, usePanelRef, type Layout, type PanelImperativeHandle } from "react-resizable-panels"

import {
  DOCK_LAYOUT_ID,
  MAIN_LAYOUT_ID,
  migrateSavedLayouts,
  PANEL_MIN_WIDTH,
  readPanelWidth,
  writePanelWidth,
} from "@/lib/pane-layouts"
import { prefersReducedMotion } from "@/lib/motion"
import { cn } from "@/lib/utils"

/**
 * Every divider in the shell is draggable, and every divider SAYS so: a
 * hairline with a 3px grip in the middle. Flow 7 made them draggable but
 * nothing told you, so nobody dragged them.
 *
 * Panes carry no border toward a handle — the handle IS the divider. A
 * `disabled` handle is one whose neighbour is closed: it is not drawn, and
 * it cannot drag a closed panel open.
 *
 * Not drawn means zero size and invisible, never `display: none`: the library
 * orders a group's children by where they sit (`offsetLeft`), and an
 * undisplayed handle sits at 0, first. Its disabled flag then carried over to
 * the next divider along, the sidebar's, which was left with no panels to
 * move: "Matching panels not found" on every key, and drags that did nothing.
 *
 * Keyed on `disabled`, so enabling one MOUNTS it anew: the library maps each
 * divider to its panels once, when it registers, and leaves a disabled one
 * out. A divider merely flipped to enabled kept that stale map, and keyboard
 * resizing then threw "Matching panels not found".
 */
function Handle({ className, disabled = false }: { className?: string; disabled?: boolean }) {
  return (
    <Resizable.Separator
      key={disabled ? "disabled" : "enabled"}
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
        disabled && "invisible w-0 aria-[orientation=horizontal]:h-0",
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
 *
 * While it glides, the panel's content keeps one width (`--tool-pin`): it
 * slides in and out with the divider instead of rewrapping on every frame,
 * and a Terminal in it refits once, when the size settles. Closing keeps the
 * tool on screen until the panel is shut (`PanelClosing`), so what slides out
 * is the tool, not an empty box. `onCentreSettling` hands the owner the centre
 * pane's width at the glide's END, then null once it lands, so whatever the
 * centre decides by its width (the summary card's fold) decides once, not
 * each time the moving edge crosses a line.
 */
export function Shell({
  sidebar,
  centre,
  panel,
  panelOpen,
  onPanelDraggedShut,
  onSidebarResize,
  onCentreSettling,
}: {
  sidebar: ReactNode
  centre: ReactNode
  panel: ReactNode
  panelOpen: boolean
  onPanelDraggedShut?: () => void
  /** the sidebar's width in px, on every change — the top bar lines its task up with the centre */
  onSidebarResize?: (px: number) => void
  /** the centre's width in px once the panel's glide lands; null when nothing glides */
  onCentreSettling?: (px: number | null) => void
}) {
  // before the library's first read of its new id
  useState(() => migrateSavedLayouts())
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({ id: MAIN_LAYOUT_ID })
  const groupRef = useGroupRef()
  const groupElement = useRef<HTMLDivElement>(null)
  const panelRef = usePanelRef()
  const [glide, endGlide] = usePanelGlide(panelOpen)
  const shut = useRef(onPanelDraggedShut)
  const settling = useRef(onCentreSettling)
  // the content is pinned from a glide's start until it lands, through a reversal
  const pinned = useRef(false)
  useEffect(() => {
    shut.current = onPanelDraggedShut
    settling.current = onCentreSettling
  }, [onPanelDraggedShut, onCentreSettling])
  useEffect(() => {
    if (glide !== null) return
    pinned.current = false
    settling.current?.(null)
  }, [glide])

  useLayoutEffect(() => {
    const handle = panelRef.current
    const group = groupElement.current
    if (!handle || !group) return
    const opening = panelOpen && handle.isCollapsed()
    if (!opening && (panelOpen || handle.isCollapsed())) return
    // the glide was set in this same commit; a restored layout is not glided
    const gliding = group.hasAttribute("data-glide")
    // a panel shut mid-glide keeps the width its content was already pinned at
    if (gliding && !opening && !pinned.current) group.style.setProperty("--tool-pin", `${handle.getSize().inPixels}px`)
    // the library's percentages are of the panels' own pixels, which a glide never changes in sum
    const total = [...group.children].reduce((px, child) => px + (child.hasAttribute("data-panel") ? (child as HTMLElement).offsetWidth : 0), 0)
    if (opening) handle.resize(readPanelWidth())
    else handle.collapse()
    const layout = groupRef.current?.getLayout()
    if (!gliding || !layout) return
    if (opening) group.style.setProperty("--tool-pin", `${((layout.tool ?? 0) / 100) * total}px`)
    pinned.current = true
    settling.current?.(((layout.centre ?? 0) / 100) * total)
  }, [panelOpen, panelRef, groupRef])

  const layoutChanged = (layout: Layout, meta: { isUserInteraction: boolean }) => {
    onLayoutChanged(layout, meta)
    if (!meta.isUserInteraction) return
    if ((layout.tool ?? 0) > 0) {
      // The library measures the panel's pixels in the DOM, and it reports a
      // keypress before React has laid that press out: read them a frame later.
      requestAnimationFrame(() => {
        const px = panelRef.current?.getSize().inPixels
        if (px && px >= PANEL_MIN_WIDTH) writePanelWidth(px)
      })
    } else if (panelOpen) {
      shut.current?.()
    }
  }

  return (
    <Resizable.Group
      orientation="horizontal"
      groupRef={groupRef}
      elementRef={groupElement}
      defaultLayout={defaultLayout}
      onLayoutChanged={layoutChanged}
      data-glide={glide ?? undefined}
      onTransitionEnd={(event) => {
        // the group's own panels, not a transition bubbling up from inside one
        if (event.propertyName === "flex-grow" && event.target instanceof Element && event.target.parentElement === event.currentTarget) endGlide()
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
        {/* a tool sliding out is on its way off the screen, not something to click */}
        <div data-tool-pin className="flex h-full min-w-0" inert={glide === "out"}>
          <PanelClosing.Provider value={glide === "out"}>{panel}</PanelClosing.Provider>
        </div>
      </Resizable.Panel>
    </Resizable.Group>
  )
}

/** The panel is gliding shut: its content stays as it was until it is (`Shell`). */
const PanelClosing = createContext(false)

/**
 * Mark the group while the panel opens or closes, so `index.css` animates the
 * panels' flex-grow for exactly that long and no longer: a divider drag must
 * follow the pointer, not ease after it. Set in the same render as the change
 * it animates — a transition takes its timing from the style it changes to —
 * and cleared when the tool panel's transition ends, or after a beat when
 * there is none (a panel the divider already shut). The first render never
 * glides: a reload restores the layout, it does not perform it. Nor does a
 * screen that asks for reduced motion: there the panel snaps, and nothing
 * waits on it.
 */
function usePanelGlide(open: boolean): readonly ["in" | "out" | null, () => void] {
  const [seen, setSeen] = useState(open)
  const [glide, setGlide] = useState<"in" | "out" | null>(null)
  if (seen !== open) {
    setSeen(open)
    setGlide(prefersReducedMotion() ? null : open ? "in" : "out")
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
 *
 * While the whole panel glides shut it goes on showing what it showed, so the
 * tool slides out with the divider; it hides once the panel is closed.
 */
export function ToolPanel({
  tool,
  terminal,
  terminalKey,
  toolOpen: toolAsked,
  terminalOpen: terminalAsked,
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
  const closing = useContext(PanelClosing)
  const [held, setHeld] = useState({ tool: toolAsked, terminal: terminalAsked })
  if (!closing && (held.tool !== toolAsked || held.terminal !== terminalAsked)) setHeld({ tool: toolAsked, terminal: terminalAsked })
  const toolOpen = closing ? held.tool : toolAsked
  const terminalOpen = closing ? held.terminal : terminalAsked
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({ id: DOCK_LAYOUT_ID })
  const toolRef = usePanelRef()
  const terminalRef = usePanelRef()
  const docked = toolOpen && terminalOpen
  // The docked split each half reopens to. The library's own expand() returns
  // a half to its size only after an imperative collapse; one the divider
  // closed (a drag, Home or End) would come back at its minimum.
  const split = useRef<Layout | undefined>(defaultLayout)

  const [mountedFor, setMountedFor] = useState<string | null>(null)
  if (terminalOpen && mountedFor !== terminalKey) setMountedFor(terminalKey)

  useLayoutEffect(() => {
    const toolPanel = toolRef.current
    const terminalPanel = terminalRef.current
    if (!toolPanel || !terminalPanel || (!toolOpen && !terminalOpen)) return
    const reopen = (panel: PanelImperativeHandle, id: "tool" | "terminal") => {
      if (!panel.isCollapsed()) return
      const size = toolOpen && terminalOpen ? split.current?.[id] : undefined
      if (size) panel.resize(`${size}%`)
      else panel.expand()
    }
    // expand first, so a collapse never leaves the group with nothing to fill it
    if (toolOpen) reopen(toolPanel, "tool")
    if (terminalOpen) reopen(terminalPanel, "terminal")
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
        if (!toolShut && !terminalShut) {
          onLayoutChanged(layout, meta)
          split.current = layout
        }
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
