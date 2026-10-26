import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react"

import { readConnectionStorage, writeConnectionStorage } from "@/lib/connection-storage"
import { isApplePlatform, isPanelChord, isTerminalToggleChord } from "@/lib/terminal"
import { availableTools, TOOL_NAMES, type PanelTool, type ToolName } from "@/lib/tools"
import { uiIntentsFor } from "@/lib/ui-intents"

export type { PanelTool, ToolName } from "@/lib/tools"

/** What the panel shows for one task: one tool, the Terminal, both (docked), or neither. */
export interface ToolLayout {
  tool: PanelTool | null
  terminal: boolean
}

export const CLOSED: ToolLayout = { tool: null, terminal: false }

/** One task's memory: what is open now, and what ⌘\ reopens. */
interface TaskTools {
  open: ToolLayout
  last: ToolLayout | null
}

const STORAGE_NAME = "tool_panel"
/** Enough tasks for anyone's week; the least recently touched go first. */
const KEEP = 200

const isOpen = (layout: ToolLayout) => layout.tool !== null || layout.terminal

function layoutOf(value: unknown): ToolLayout | null {
  if (!value || typeof value !== "object") return null
  const { tool, terminal } = value as Record<string, unknown>
  const named = TOOL_NAMES.includes(tool as ToolName) && tool !== "terminal" ? (tool as PanelTool) : null
  return { tool: named, terminal: terminal === true }
}

function readMemory(connectionId: string): Map<string, TaskTools> {
  const memory = new Map<string, TaskTools>()
  try {
    const value: unknown = JSON.parse(readConnectionStorage(connectionId, STORAGE_NAME, null) ?? "[]")
    if (!Array.isArray(value)) return memory
    for (const entry of value) {
      if (!Array.isArray(entry) || typeof entry[0] !== "string") continue
      const record = entry[1] as Record<string, unknown> | undefined
      memory.set(entry[0], { open: layoutOf(record?.open) ?? CLOSED, last: layoutOf(record?.last) })
    }
  } catch {
    // an unreadable record costs only the memory, never the panel
  }
  return memory
}

/** Re-inserted, so a Map's order is least-recently-touched first. */
function remember(memory: Map<string, TaskTools>, taskId: string, entry: TaskTools): Map<string, TaskTools> {
  const next = new Map(memory)
  next.delete(taskId)
  next.set(taskId, entry)
  return next
}

/**
 * Drop a tool this daemon does not have (an older daemon, or one whose
 * features have not answered yet reads as "has everything"), so a remembered
 * Autopilot never opens a panel with nothing in it.
 */
function availableLayout(layout: ToolLayout, available: readonly ToolName[] | null): ToolLayout {
  if (available === null || layout.tool === null || available.includes(layout.tool)) return layout
  return { ...layout, tool: null }
}

export interface ToolPanelControls {
  /** what is open for the selected task, with tools this daemon lacks already dropped */
  layout: ToolLayout
  /** the panel is showing anything at all */
  open: boolean
  /** the tools this daemon offers; null while its features are unknown */
  available: readonly ToolName[] | null
  /** the top bar's icons: open a tool, or close it when it is the one showing */
  toggle(name: ToolName): void
  /** the `/` palette's verbs: open a tool and leave it open */
  show(name: ToolName): void
  close(name: ToolName): void
  /** ⌘\: close everything, or reopen what this task last had open */
  togglePanel(): void
  /** close everything: the panel's divider was dragged shut */
  closePanel(): void
  /**
   * True once after the person opened the Terminal, so the shell takes the
   * keyboard then — and never when it is shown because a task switch landed
   * on a task that had it open, where a focused xterm would swallow Ctrl+Tab.
   */
  claimTerminalFocus(): boolean
}

/**
 * Which tool the right panel shows, per task.
 *
 * Remembered per task, per connection, in this browser (like
 * `useSubtaskDisclosure`), so switching tasks and coming back restores the
 * tool you left open. A task nobody has opened a tool on starts closed, and
 * NOTHING opens the panel except the person: a task that needs you changes
 * its dot and its notification, never the layout. The panel's width is not
 * here: it is one width for every task (`panes.tsx`).
 */
export function useToolPanel({
  connectionId,
  taskId,
  available,
}: {
  connectionId: string
  taskId: string | null
  available: readonly ToolName[] | null
}): ToolPanelControls {
  const [memory, setMemory] = useState(() => readMemory(connectionId))
  const terminalFocus = useRef(false)
  // a claim is for the task it was made on
  useEffect(() => {
    terminalFocus.current = false
  }, [connectionId, taskId])

  const remembered = taskId === null ? undefined : memory.get(taskId)
  const layout = useMemo(
    () => availableLayout(remembered?.open ?? CLOSED, available),
    [remembered, available],
  )

  // Read from the render's memory rather than a functional update: these run
  // from clicks and keys, one per render, and the focus hand-off below is a
  // side effect that must run once.
  const update = useCallback(
    (change: (current: TaskTools) => ToolLayout) => {
      if (taskId === null) return
      const current = memory.get(taskId) ?? { open: CLOSED, last: null }
      const open = change(current)
      if (open.tool === current.open.tool && open.terminal === current.open.terminal) return
      blurLeaving(current.open, open, connectionId)
      terminalFocus.current = open.terminal && !current.open.terminal
      const entry = { open, last: isOpen(open) ? open : current.open }
      setMemory(remember(memory, taskId, entry))
      // Saved by merging this one task into what is stored now, not by writing
      // this window's whole map: another window on the same daemon remembers
      // its own tasks, and the last writer must not erase them.
      writeConnectionStorage(
        connectionId,
        STORAGE_NAME,
        null,
        JSON.stringify([...remember(readMemory(connectionId), taskId, entry)].slice(-KEEP)),
      )
    },
    [connectionId, memory, taskId],
  )

  const offered = useCallback((name: ToolName) => available === null || available.includes(name), [available])

  const toggle = useCallback(
    (name: ToolName) => {
      if (!offered(name)) return
      update(({ open }) => {
        const shown = availableLayout(open, available)
        if (name === "terminal") return { ...shown, terminal: !shown.terminal }
        return { ...shown, tool: shown.tool === name ? null : name }
      })
    },
    [available, offered, update],
  )

  const show = useCallback(
    (name: ToolName) => {
      if (!offered(name)) return
      update(({ open }) => (name === "terminal" ? { ...open, terminal: true } : { ...open, tool: name }))
    },
    [offered, update],
  )

  const close = useCallback(
    (name: ToolName) => update(({ open }) => (name === "terminal" ? { ...open, terminal: false } : { ...open, tool: null })),
    [update],
  )

  const togglePanel = useCallback(
    () =>
      update(({ open, last }) => {
        if (isOpen(availableLayout(open, available))) return CLOSED
        const again = last ? availableLayout(last, available) : CLOSED
        // a task that never had a tool open opens on its changes
        return isOpen(again) ? again : { tool: "changes", terminal: false }
      }),
    [available, update],
  )

  const closePanel = useCallback(() => update(() => CLOSED), [update])

  const claimTerminalFocus = useCallback(() => {
    const claimed = terminalFocus.current
    terminalFocus.current = false
    return claimed
  }, [])

  return { layout, open: isOpen(layout), available, toggle, show, close, togglePanel, closePanel, claimTerminalFocus }
}

/**
 * A region about to be hidden must not take the keyboard with it: focus in a
 * `display: none` box is focus nowhere. It goes to the composer, the place a
 * person was most likely to type next — the way an editor's panel hands focus
 * back to the editor.
 */
function blurLeaving(before: ToolLayout, after: ToolLayout, connectionId: string): void {
  const focused = typeof document === "undefined" ? null : document.activeElement
  const region = focused?.closest?.("[data-tool-region]")?.getAttribute("data-tool-region")
  if (!region) return
  const leaving = region === "terminal" ? before.terminal && !after.terminal : before.tool !== null && after.tool === null
  if (leaving) uiIntentsFor(connectionId).focusComposer()
}

/**
 * The panel's two chords, installed once on the window:
 *
 * - ⌃` toggles the Terminal — VS Code's chord, on every platform. A focused
 *   xterm passes it through (`lib/terminal.ts`), so it closes the Terminal
 *   from inside it, where Esc belongs to the shell.
 * - ⌘\ (Ctrl+\ off Apple) toggles the whole panel. Off Apple a focused
 *   terminal keeps Ctrl+\, because it is the shell's SIGQUIT.
 *
 * Neither is a browser's or Wisp Desktop's: ⌘1–9 and the devtools chords are
 * the ones a page cannot take, and Desktop declares no menu accelerators.
 */
export function useToolPanelShortcuts(controls: ToolPanelControls | null, apple: boolean): void {
  const toggle = controls?.toggle
  const togglePanel = controls?.togglePanel
  useEffect(() => {
    if (!toggle || !togglePanel) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return
      if (isTerminalToggleChord(event)) {
        event.preventDefault()
        toggle("terminal")
        return
      }
      if (!isPanelChord(event, apple)) return
      const inShell = event.target instanceof Element && event.target.closest("[data-terminal]")
      if (inShell && !apple) return
      event.preventDefault()
      togglePanel()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [apple, toggle, togglePanel])
}

/**
 * The app's one call: which tools this daemon has, the selected task's
 * panel, and its chords while `shortcuts` (a pointer shell with a task open).
 */
export function useTaskToolPanel(
  connectionId: string,
  taskId: string | null,
  features: { data?: Parameters<typeof availableTools>[0]; isError: boolean },
  shortcuts: boolean,
): ToolPanelControls {
  const available = useMemo(() => availableTools(features.data, features.isError), [features.data, features.isError])
  const controls = useToolPanel({ connectionId, taskId, available })
  useToolPanelShortcuts(shortcuts ? controls : null, isApplePlatform())
  return controls
}

/** The selected task's tool controls, for the pointer shell only; null on touch, which has its own tabs. */
export const ToolPanelContext = createContext<ToolPanelControls | null>(null)

export function useToolPanelControls(): ToolPanelControls | null {
  return useContext(ToolPanelContext)
}
