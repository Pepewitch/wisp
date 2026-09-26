import { useCallback, useEffect, useRef, useState } from "react"

import { Check, ClipboardPaste, Copy, Plus, type FluentIcon } from "@/components/icons"
import { ShellKillDialog, ShellMenu, ShellTab } from "@/components/shell-tab"
import { ShellView, type ShellHandle } from "@/components/shell-view"
import { MAX_SHELLS_PER_TASK, useShellTabs } from "@/hooks/useShellTabs"
import { useDaemonRuntime } from "@/lib/runtime"
import { isApplePlatform, shellTitle } from "@/lib/terminal"
import { bufferText, selectionWithin } from "@/lib/terminal-clipboard"
import { cn } from "@/lib/utils"

/**
 * The bottom-right pane: as many shells in the task's worktree as you want,
 * tabbed. Each tab owns its own websocket to /api/tasks/:id/terminal?shell=N
 * and connects only while it is the active tab; an inactive tab's xterm stays
 * mounted (so its scrollback survives) but its socket is disposed.
 *
 * NOTHING here owns a shell. The daemon does, keyed by (task, shell), and a
 * shell outlives every socket the pane opens — so a tab switch, a task switch
 * and a browser reload all REATTACH to a still-running process and replay what
 * it printed while nobody was watching.
 *
 * The daemon also keeps the TAB LIST (`useShellTabs`), so every window shows
 * the same tabs and closing one is what hangs its shell up — the way closing
 * a terminal window or dropping an SSH session does.
 *
 * The strip is `shell-tab.tsx`; one tab's xterm and socket are `shell-view.tsx`.
 */

/**
 * Whether this browser will hand the app the clipboard at all.
 *
 * Read per capability rather than once for "clipboard": Safari and Chrome give
 * both halves, Firefox gives only `writeText`, and a page served over plain
 * http — a LAN address rather than the documented HTTPS one — is not a secure
 * context and gets neither. Asking separately is what lets the two controls
 * disable themselves honestly instead of failing silently on the tap.
 */
function clipboardCan(verb: "readText" | "writeText"): boolean {
  return typeof navigator !== "undefined" && typeof navigator.clipboard?.[verb] === "function"
}

export function TerminalSection({
  taskId,
  worktreePath,
  archived,
  touch = false,
}: {
  taskId: string | null
  /**
   * null until the daemon has created the worktree. A task is selected the
   * instant POST /api/tasks returns, which is BEFORE its worktree exists —
   * connecting then gets a 409 the browser reports as a bare 1006 close, and
   * the pane used to sit dead until you opened a second tab by hand.
   */
  worktreePath: string | null
  archived: boolean
  /** thumb-sized shell tabs below the md breakpoint */
  touch?: boolean
}) {
  const runtime = useDaemonRuntime()
  const apple = isApplePlatform()

  const unavailable =
    taskId === null
      ? "No task selected"
      : archived
        ? "Terminals are unavailable for archived tasks."
        : worktreePath === null
          ? "Preparing the worktree…"
          : null

  /**
   * The live xterm behind each tab, so the strip's controls can act on the one
   * in front of the user.
   *
   * A ref rather than state: a terminal arriving or leaving changes nothing
   * about what is painted, and putting it in state would re-render the pane —
   * and therefore every mounted shell — on mount and unmount.
   */
  const handles = useRef(new Map<number, ShellHandle>())
  // Must stay referentially stable: a tab's terminal is created and disposed by
  // an effect that depends on this, so a `register` that changed identity would
  // tear down live shells — scrollback, socket and all — to rebuild them.
  const register = useCallback((id: number, handle: ShellHandle | null) => {
    if (handle) handles.current.set(id, handle)
    else handles.current.delete(id)
  }, [])

  const tabs = useShellTabs({
    taskId,
    available: unavailable === null,
    reconnect: (id) => handles.current.get(id)?.reconnect(),
  })
  const { shells, activeId, labelOf } = tabs

  const [copied, setCopied] = useState(false)
  const copiedReset = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      if (copiedReset.current) clearTimeout(copiedReset.current)
    }
  }, [])

  const [findState, setFinding] = useState<{ id: number; token: number } | null>(null)
  // a closed tab takes its find bar with it
  const finding = findState && shells.includes(findState.id) ? findState : null
  const [renaming, setRenaming] = useState<number | null>(null)

  const find = (id: number) => {
    if (id !== activeId) tabs.activate(id)
    setFinding((current) => ({ id, token: (current?.token ?? 0) + 1 }))
  }
  const closeFind = (id: number) => {
    setFinding((current) => (current?.id === id ? null : current))
    handles.current.get(id)?.terminal.focus()
  }
  const clear = (id: number) => {
    if (id !== activeId) tabs.activate(id)
    handles.current.get(id)?.clear()
  }

  /**
   * Copy whichever selection exists, or the whole buffer when none does.
   *
   * The ORDER is the substance here, and `lib/terminal-clipboard.ts` explains
   * why: a phone's only selection is the platform's, made by long press and
   * held in the DOM where xterm cannot see it, so asking xterm first would
   * ignore the one selection a finger can actually make and copy the entire
   * buffer over the top of it.
   */
  const copy = async () => {
    const terminal = handles.current.get(activeId)?.terminal
    if (!terminal) return
    const root = terminal.element ?? null
    const text =
      selectionWithin(root, root?.ownerDocument.getSelection() ?? null) ||
      (terminal.hasSelection() ? terminal.getSelection() : "") ||
      bufferText(terminal.buffer.active)
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
      if (!mounted.current) return
      setCopied(true)
      if (copiedReset.current) clearTimeout(copiedReset.current)
      copiedReset.current = setTimeout(() => setCopied(false), 1_200)
    } catch {
      setCopied(false)
    }
  }

  /**
   * Paste into the active shell.
   *
   * `Terminal.paste` rather than an input frame of our own: it normalizes line
   * endings and applies bracketed-paste mode, so a shell that asked to be told
   * a paste is a paste still gets told.
   */
  const paste = async () => {
    const terminal = handles.current.get(activeId)?.terminal
    if (!terminal) return
    try {
      const text = await navigator.clipboard.readText()
      if (text) terminal.paste(text)
      terminal.focus()
    } catch {
      // A refused permission or an empty clipboard is not an error worth a
      // surface; the control stays where it is and the shell is untouched.
    }
  }

  return (
    // h-full for the desktop resizable panel, flex-1 for the mobile flex
    // column: without the latter this collapses to its tab strip and xterm
    // opens one row tall. `data-terminal` tells the app-wide ⌘F that a key
    // pressed in here belongs to the shell.
    <div data-terminal="" className="flex h-full min-h-0 flex-1 flex-col bg-background">
      <div className={cn("flex shrink-0 items-center gap-1 pr-2.5 pl-2", touch ? "h-12" : "h-8")}>
        {/* The tab list SCROLLS and the clipboard controls do not.
            Everything here is `shrink-0`, and the pane allows eight shells, so
            on a phone a second tab was already enough to push what follows it
            off the right edge — with no way to reach it, because the mobile
            shell refuses overscroll. Giving the tabs their own scroller is
            what keeps the controls on screen at any shell count. */}
        <div className="scroll-slim flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {shells.map((id) => {
            const info = tabs.infoOf(id)
            const label = labelOf(id)
            const closeable = shells.length > 1
            return (
              <ShellTab
                key={id}
                label={label}
                title={info ? shellTitle(info, label) : undefined}
                active={id === activeId}
                closeable={closeable}
                renaming={renaming === id}
                renameValue={info?.name ?? label}
                onActivate={() => tabs.activate(id)}
                onClose={() => void tabs.closeTab(id)}
                onRename={tabs.daemonTabs ? () => setRenaming(id) : undefined}
                onRenameCommit={(name, byKey) => {
                  setRenaming(null)
                  void tabs.renameTab(id, name)
                  // a click elsewhere put focus where it was wanted; a key did not
                  if (byKey) handles.current.get(id)?.terminal.focus()
                }}
                onRenameCancel={() => {
                  setRenaming(null)
                  handles.current.get(id)?.terminal.focus()
                }}
                menu={
                  <ShellMenu
                    label={label}
                    apple={apple}
                    daemonTabs={tabs.daemonTabs}
                    closeable={closeable}
                    touch={touch}
                    onOpen={() => {
                      if (id !== activeId) tabs.activate(id)
                    }}
                    onRename={() => setRenaming(id)}
                    onFind={() => find(id)}
                    onClear={() => clear(id)}
                    onRestart={() => void tabs.restartTab(id)}
                    onClose={() => void tabs.closeTab(id)}
                  />
                }
                touch={touch}
              />
            )
          })}
          <ShellControl
            icon={Plus}
            label="New shell"
            title="New shell in this worktree"
            onAct={() => void tabs.openTab()}
            disabled={unavailable !== null || !tabs.featuresKnown || shells.length >= MAX_SHELLS_PER_TASK}
            touch={touch}
          />
          {tabs.failure && (
            <span className="min-w-0 truncate text-[11px] text-muted-foreground" title={tabs.failure}>
              {tabs.failure}
            </span>
          )}
        </div>

        {/* Outside that scroller, and in this order: a control that empties the
            clipboard into a live shell does not share an edge with the one
            that closes a tab. */}
        <ShellControl
          icon={copied ? Check : Copy}
          label={copied ? "Copied" : "Copy"}
          title="Copy the selection, or everything this shell has printed"
          onAct={() => void copy()}
          disabled={unavailable !== null || !clipboardCan("writeText")}
          touch={touch}
        />
        <ShellControl
          icon={ClipboardPaste}
          label="Paste"
          title="Paste the clipboard into this shell"
          onAct={() => void paste()}
          disabled={unavailable !== null || !clipboardCan("readText")}
          touch={touch}
        />
      </div>

      <div className="relative min-h-0 flex-1">
        {unavailable ? (
          <div className="px-3.5 pt-1 font-mono text-[11px] text-faint">{unavailable}</div>
        ) : (
          shells.map((id) => (
            <ShellView
              key={`${runtime.connectionId}:${taskId}:${id}`}
              transport={runtime.transport}
              taskId={taskId!}
              shellId={id}
              active={id === activeId}
              register={register}
              apple={apple}
              daemonScreen={tabs.daemonTabs}
              finding={finding?.id === id ? finding.token : null}
              onFind={() => find(id)}
              onFindClose={() => closeFind(id)}
              touch={touch}
            />
          ))
        )}
      </div>

      <ShellKillDialog pending={tabs.pendingKill} onCancel={tabs.cancelKill} onConfirm={tabs.confirmKill} />
    </div>
  )
}

/**
 * One icon control in the tab strip — `+`, copy, paste.
 *
 * Extracted the moment there were three of them: the strip's controls are one
 * shape at two sizes, and §6b's 44px floor is about the hit box, so `touch`
 * grows the BOX rather than the glyph.
 */
function ShellControl({
  icon: Icon,
  label,
  title,
  onAct,
  disabled,
  touch = false,
}: {
  icon: FluentIcon
  label: string
  title: string
  onAct: () => void
  disabled: boolean
  touch?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onAct}
      disabled={disabled}
      aria-label={label}
      title={title}
      className={cn(
        "flex shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors",
        "hover:bg-hover hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent",
        touch ? "size-11" : "size-[22px]",
      )}
    >
      <Icon className={touch ? "size-4" : "size-3"} />
    </button>
  )
}
