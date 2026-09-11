import { useCallback, useEffect, useId, useRef, useState, type RefObject } from "react"
import { FitAddon } from "@xterm/addon-fit"
import { Terminal, type ITheme } from "@xterm/xterm"
import xtermCss from "@xterm/xterm/css/xterm.css?inline"

import { Check, ClipboardPaste, Copy, Dismiss, Plus, type FluentIcon } from "@/components/icons"
import { useDaemonRuntime } from "@/lib/runtime"
import {
  loadShellTabs,
  saveShellTabs,
  terminalOriginRefusal,
  TerminalConnection,
  type ShellTabs,
} from "@/lib/terminal"
import { bufferText, selectionWithin } from "@/lib/terminal-clipboard"
import { cellHeightOf, TouchScrollGesture } from "@/lib/terminal-touch"
import { themeStore, useTheme, type Theme } from "@/lib/theme"
import type { DaemonTransport } from "@/lib/transport"
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
 * it printed while nobody was watching. This component therefore holds only
 * two things: which tabs exist (persisted per task) and which one is active.
 *
 * The active tab is a background pill — no underline, no hue (CONVENTIONS §1).
 */

/** Matches MAX_SHELLS_PER_TASK in src/terminal.ts — the daemon rejects a higher id. */
const MAX_SHELLS_PER_TASK = 8

/**
 * The app's one licensed hex block outside index.css: xterm paints to a canvas
 * and takes JS colours, so it cannot read a CSS token. Both scales live here
 * together for exactly that reason — keep them in step with the theme blocks
 * in `web/src/index.css`.
 *
 * The grayscale ends are not mirrored blindly. A program that prints in bright
 * white means EMPHASIS, so on paper bright white becomes the darkest ink
 * rather than an invisible line, and ANSI yellow darkens to an amber that is
 * still a word on white.
 */
const TERMINAL_THEME: Record<Theme, ITheme> = {
  dark: {
    background: "#141418",
    foreground: "#b5b5bf",
    cursor: "#af87f1",
    selectionBackground: "#303038",
    black: "#141418",
    brightBlack: "#a0a0ab",
    white: "#eaeaee",
    brightWhite: "#ffffff",
    green: "#6bc48d",
    red: "#de6f6b",
    yellow: "#ddb055",
    blue: "#7c92b4",
    magenta: "#af87f1",
    cyan: "#7fc9c0",
  },
  light: {
    background: "#ffffff",
    foreground: "#4f4f5a",
    cursor: "#6d3fd0",
    selectionBackground: "#dcdce6",
    black: "#1a1a1f",
    brightBlack: "#8a8a96",
    white: "#55555f",
    brightWhite: "#1a1a1f",
    green: "#157f4c",
    red: "#b83a34",
    yellow: "#8a600c",
    blue: "#3a5b8f",
    magenta: "#6d3fd0",
    cyan: "#136f69",
  },
}

function labelFor(id: number): string {
  return `Shell ${id + 1}`
}

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
  const taskIdentity = `${runtime.connectionId}:${taskId ?? ""}`
  // The tab list per task, restored from storage. A task switch swaps it during
  // RENDER, so no tab ever paints pointed at the previous task's worktree.
  const [tabs, setTabsState] = useState<ShellTabs>(() =>
    taskId ? loadShellTabs(runtime.connectionId, taskId) : { ids: [0], active: 0 },
  )
  const [seenTask, setSeenTask] = useState(taskIdentity)
  if (seenTask !== taskIdentity) {
    setSeenTask(taskIdentity)
    setTabsState(taskId ? loadShellTabs(runtime.connectionId, taskId) : { ids: [0], active: 0 })
  }

  // one writer, so no code path can change the tabs without recording them
  const setTabs = (next: ShellTabs) => {
    setTabsState(next)
    if (taskId) saveShellTabs(runtime.connectionId, taskId, next)
  }

  const shells = tabs.ids
  const activeId = tabs.active

  /**
   * The live xterm behind each tab, so the strip's controls can act on the one
   * in front of the user.
   *
   * A ref rather than state: a terminal arriving or leaving changes nothing
   * about what is painted, and putting it in state would re-render the pane —
   * and therefore every mounted shell — on mount and unmount.
   */
  const terminals = useRef(new Map<number, Terminal>())
  // Must stay referentially stable: a tab's terminal is created and disposed by
  // an effect that depends on this, so a `register` that changed identity would
  // tear down live shells — scrollback, socket and all — to rebuild them.
  const register = useCallback((id: number, terminal: Terminal | null) => {
    if (terminal) terminals.current.set(id, terminal)
    else terminals.current.delete(id)
  }, [])
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
    const terminal = terminals.current.get(activeId)
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
    const terminal = terminals.current.get(activeId)
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

  // The next id is the smallest FREE one, not max+1: ids address daemon-side
  // shells, and reusing a closed tab's id reattaches to the shell still
  // running under it — which is the behaviour you want after a stray close.
  const open = () => {
    let id = 0
    while (shells.includes(id)) id++
    if (id >= MAX_SHELLS_PER_TASK) return
    setTabs({ ids: [...shells, id], active: id })
  }

  const close = (id: number) => {
    const rest = shells.filter((x) => x !== id)
    if (rest.length === 0) return // never leave the pane shell-less
    setTabs({ ids: rest, active: id === activeId ? rest[rest.length - 1]! : activeId })
  }

  const unavailable =
    taskId === null
      ? "No task selected"
      : archived
        ? "Terminals are unavailable for archived tasks."
        : worktreePath === null
          ? "Preparing the worktree…"
          : null

  return (
    // h-full for the desktop resizable panel, flex-1 for the mobile flex
    // column: without the latter this collapses to its tab strip and xterm
    // opens one row tall
    <div className="flex h-full min-h-0 flex-1 flex-col bg-background">
      <div className={cn("flex shrink-0 items-center gap-1 pr-2.5 pl-2", touch ? "h-12" : "h-8")}>
        {/* The tab list SCROLLS and the clipboard controls do not.
            Everything here is `shrink-0`, and the pane allows eight shells, so
            on a phone a second tab was already enough to push what follows it
            off the right edge — with no way to reach it, because the mobile
            shell refuses overscroll. Giving the tabs their own scroller is
            what keeps the controls on screen at any shell count. */}
        <div className="scroll-slim flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {shells.map((id) => (
            <ShellTab
              key={id}
              label={labelFor(id)}
              active={id === activeId}
              closeable={shells.length > 1}
              onActivate={() => setTabs({ ids: shells, active: id })}
              onClose={() => close(id)}
              touch={touch}
            />
          ))}
          <ShellControl
            icon={Plus}
            label="New shell"
            title="New shell in this worktree"
            onAct={open}
            disabled={unavailable !== null || shells.length >= MAX_SHELLS_PER_TASK}
            touch={touch}
          />
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
            />
          ))
        )}
      </div>
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

function ShellTab({
  label,
  active,
  closeable,
  onActivate,
  onClose,
  touch = false,
}: {
  label: string
  active: boolean
  closeable: boolean
  onActivate: () => void
  onClose: () => void
  touch?: boolean
}) {
  const self = useRef<HTMLSpanElement>(null)
  // The strip scrolls now, so the tab you just opened or switched to can be
  // sitting off its edge. `nearest` on both axes so a tab already in view is
  // left exactly where it is.
  useEffect(() => {
    if (active) self.current?.scrollIntoView?.({ block: "nearest", inline: "nearest" })
  }, [active])

  return (
    <span
      ref={self}
      className={cn(
        "group/tab flex shrink-0 items-center gap-1.5 rounded-md pr-1.5 pl-2.5 transition-colors",
        touch ? "h-11 gap-2 pr-2 pl-3.5" : "h-[22px]",
        active ? "bg-accent" : "hover:bg-hover",
      )}
    >
      <button
        type="button"
        onClick={onActivate}
        className={cn(
          // fills its row so the whole tab is the tap target, not just the glyphs
          "flex h-full items-center focus-visible:outline-none",
          touch ? "text-[13px]" : "text-[11.5px]",
          active ? "font-medium text-foreground" : "text-muted-foreground",
        )}
      >
        {label}
      </button>
      {closeable && (
        <button
          type="button"
          onClick={onClose}
          aria-label={`Close ${label}`}
          className={cn(
            "flex items-center justify-center text-muted-foreground transition-opacity hover:text-foreground",
            touch ? "size-8" : "",
            // hover cannot reveal anything on a touch screen
            active || touch ? "opacity-100" : "opacity-0 group-hover/tab:opacity-100",
          )}
        >
          <Dismiss className={touch ? "size-3.5" : "size-2.5"} />
        </button>
      )}
    </span>
  )
}

type Phase = "connecting" | "live" | "exited" | "error"

/**
 * A socket that dies BEFORE hello is a not-ready daemon, not a dead shell:
 * a worktree still being created, or a daemon mid-restart. Retry on a short
 * backoff rather than leaving a dead pane, and stop after this many tries so
 * a genuinely broken task reports instead of reconnecting forever.
 */
const RETRY_LIMIT = 6
const RETRY_DELAYS_MS = [400, 800, 1600, 3000, 3000, 3000]

/**
 * One xterm bound to one TerminalConnection. Kept mounted while inactive so
 * scrollback survives a tab switch; the socket is disposed on deactivate and
 * rebuilt on activate, so an idle tab costs nothing on the daemon.
 */
function ShellView({
  transport,
  taskId,
  shellId,
  active,
  register,
}: {
  transport: DaemonTransport
  taskId: string
  shellId: number
  active: boolean
  /** Publish this tab's terminal to the strip's controls; null on teardown. */
  register: (id: number, terminal: Terminal | null) => void
}) {
  const host = useRef<HTMLDivElement>(null)
  const term = useRef<Terminal | null>(null)
  const fit = useRef<FitAddon | null>(null)
  const conn = useRef<TerminalConnection | null>(null)
  /**
   * The last geometry the daemon was told. Every fit used to send a resize,
   * and a mount fires several — the initial fit, the ResizeObserver, and the
   * "connecting…" line disappearing, which changes the row count. Each one
   * SIGWINCHes the shell into redrawing its prompt, so unchanged sizes are
   * dropped here rather than turned into work at the other end.
   */
  const sentSize = useRef<{ cols: number; rows: number } | null>(null)
  const [phase, setPhase] = useState<Phase>("connecting")
  const [detail, setDetail] = useState<string | null>(null)
  /**
   * The daemon could not give this shell a pty and fell back to pipes. It is a
   * working shell, but one with no window size and no job control, so the
   * prompt is drawn for a terminal that does not exist and Ctrl-C goes
   * nowhere. Say so, rather than leaving it to look like the display bug this
   * pane used to have.
   */
  const [noPty, setNoPty] = useState(false)
  // bumping this re-runs the connect effect; the budget it spends is a ref, so
  // a successful hello can refill it without tearing the live socket back down
  const [attempt, setAttempt] = useState(0)
  const retries = useRef(0)
  const theme = useTheme()

  // xterm's stylesheet is imported as a string and injected once, so the
  // zero-CDN invariant holds and nothing reaches outside the bundle
  useXtermStyles()

  useEffect(() => {
    if (!host.current) return
    const t = new Terminal({
      fontFamily: "'Geist Mono Variable', ui-monospace, Menlo, monospace",
      fontSize: 11.5,
      lineHeight: 1.45,
      cursorBlink: true,
      allowProposedApi: true,
      // read off the store, not the hook: the terminal is built once, and a
      // theme in this effect's deps would tear down a live shell to repaint it
      theme: TERMINAL_THEME[themeStore.theme()],
    })
    const f = new FitAddon()
    t.loadAddon(f)
    t.open(host.current)
    term.current = t
    fit.current = f
    register(shellId, t)
    return () => {
      register(shellId, null)
      t.dispose()
      term.current = null
      fit.current = null
    }
  }, [register, shellId])

  // A theme switch repaints the live terminal in place — scrollback, the
  // socket and the running process are all untouched.
  useEffect(() => {
    if (term.current) term.current.options.theme = TERMINAL_THEME[theme]
  }, [theme])

  /**
   * Fit the xterm to its pane and report what that came to. Returns null when
   * the renderer has not measured a cell yet — an inactive tab is hidden, so
   * its terminal has no dimensions to propose.
   */
  const measure = (): { cols: number; rows: number } | null => {
    fit.current?.fit()
    const d = fit.current?.proposeDimensions()
    if (!d || !(d.cols > 0) || !(d.rows > 0)) return null
    return { cols: d.cols, rows: d.rows }
  }

  /** Tell the daemon a new geometry, but only when it actually is one. */
  const pushSize = (size: { cols: number; rows: number } | null): void => {
    if (!size) return
    const last = sentSize.current
    if (last && last.cols === size.cols && last.rows === size.rows) return
    sentSize.current = size
    conn.current?.sendResize(size.cols, size.rows)
  }

  // connect only while active
  useEffect(() => {
    const t = term.current
    if (!active || !t) return
    let live = true
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    // A named {type:"error"} the daemon sent before hello ("shell limit
    // reached", a worktree that vanished). It explains the close that follows,
    // and retrying past it would replace a real reason with a bare code.
    let refusal: string | null = null
    let sawHello = false
    setPhase("connecting")
    setDetail(null)
    setNoPty(false)

    // Measure BEFORE connecting. The daemon creates the shell while answering
    // this socket, so the size has to travel with the upgrade — a shell born
    // at a default width prints its first prompt for a terminal nobody has,
    // and a full-width prompt then survives every later redraw as a stale row.
    const measured = measure()
    if (measured) sentSize.current = measured

    const c = new TerminalConnection(
      taskId,
      shellId,
      {
        onHello: (hello) => {
          setPhase("live")
          setNoPty(!hello.pty)
          sawHello = true
          retries.current = 0 // a live shell refills the budget for the NEXT drop
          // RESET, then replay: this xterm may already hold what it rendered
          // before the socket was disposed, and appending the daemon's copy
          // on top of it would double every line. After this the screen is
          // exactly the daemon's buffer, whatever the tab held before.
          t.reset()
          if (hello.replay) t.write(hello.replay)
          // The daemon already sized the shell to what connect() measured, so
          // this only reports a pane that changed while the socket was opening.
          queueMicrotask(() => pushSize(measure()))
        },
        onOutput: (data) => t.write(data),
        onExit: (code) => {
          setPhase("exited")
          setDetail(`exit ${code}`)
        },
        onError: (message) => {
          if (!sawHello) refusal = message
          setPhase("error")
          setDetail(message)
        },
        onClose: (code, beforeHello) => {
          if (!beforeHello) {
            if (phaseIsOpen()) {
              setPhase("exited")
              setDetail("the shell closed")
            }
            return
          }
          // 1008 is the daemon's own reject (auth) — retrying cannot help
          if (code === 1008) {
            setPhase("error")
            setDetail("the daemon refused the connection")
            return
          }
          // The daemon answered, and said no. Keep its words.
          if (refusal !== null) {
            setPhase("error")
            setDetail(refusal)
            return
          }
          // A close with no frame behind it may still have a reason: the
          // daemon can refuse the upgrade at the HTTP layer, and a browser
          // never shows the page a failed handshake's response body. Ask for
          // that reason alongside the retry rather than before it, so a
          // daemon that is merely still starting up loses nothing — and when
          // an answer does come back, it replaces the retry with the sentence.
          void terminalOriginRefusal(transport).then((reason) => {
            if (!live || reason === null) return
            if (retryTimer !== null) {
              clearTimeout(retryTimer)
              retryTimer = null
            }
            setPhase("error")
            setDetail(reason)
          })
          if (retries.current >= RETRY_LIMIT) {
            setPhase("error")
            setDetail(`could not open a shell (${code}) — ${RETRY_LIMIT} attempts`)
            return
          }
          const delay = RETRY_DELAYS_MS[retries.current] ?? 3000
          retries.current += 1
          setPhase("connecting")
          setDetail(null)
          retryTimer = setTimeout(() => setAttempt((n) => n + 1), delay)
        },
      },
      transport,
      () => live,
      measured,
    )
    const phaseIsOpen = () => live
    conn.current = c
    c.connect()
    const input = t.onData((data) => c.sendInput(data))

    return () => {
      live = false
      if (retryTimer !== null) clearTimeout(retryTimer)
      input.dispose()
      c.dispose()
      conn.current = null
    }
  }, [transport, taskId, shellId, active, attempt])

  /**
   * Refit whenever the pane can actually be measured. An inactive tab is
   * `hidden`, so xterm opened at 0x0 and its renderer never sized itself —
   * without the fit on activation the terminal comes up blank with the
   * accessibility buffer leaking through. The observer then covers the
   * draggable divider above it on desktop.
   */
  useEffect(() => {
    if (!active || !host.current) return
    const refit = () => pushSize(measure())
    const raf = requestAnimationFrame(refit)
    const ro = new ResizeObserver(refit)
    ro.observe(host.current)
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
    }
  }, [active])

  useTouchScroll(host, term, active)

  return (
    <div className={cn("absolute inset-0 flex flex-col", !active && "pointer-events-none invisible")}>
      <div ref={host} className="min-h-0 flex-1 px-2.5 pb-1" />
      {(phase !== "live" || noPty) && (
        <div className="flex shrink-0 items-start gap-2.5 px-3.5 pb-1.5 font-mono text-[10.5px] text-faint">
          {/*
            A refusal can be a whole sentence — the daemon's origin
            explanation is the long one — and a single truncated line would
            hide the half that says what to change. Errors wrap instead, with
            the full text on the title for anything past three lines.
          */}
          <span
            className={cn("min-w-0", phase === "error" ? "line-clamp-3 break-words" : "truncate")}
            title={phase === "error" && detail ? detail : undefined}
          >
            {phase === "connecting"
              ? "connecting…"
              : phase === "live"
                ? "no pty — this shell has no window size or job control"
                : detail}
          </span>
          {phase !== "connecting" && (
            <button
              type="button"
              onClick={() => {
                retries.current = 0
                setAttempt((n) => n + 1)
              }}
              className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
            >
              retry
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * Swipe to scroll — the gesture xterm 6 dropped.
 *
 * `lib/terminal-touch.ts` has the why and the arithmetic; this is the wiring,
 * and it deliberately mirrors the shape of the listeners the 5.x line carried
 * on its terminal element.
 */
function useTouchScroll(
  host: RefObject<HTMLDivElement | null>,
  term: RefObject<Terminal | null>,
  active: boolean,
) {
  useEffect(() => {
    const element = host.current
    const t = term.current
    if (!active || !element || !t) return
    const gesture = new TouchScrollGesture()
    // xterm keeps cell metrics for its renderers alone, so the rows are
    // measured off the element the DOM renderer sizes to exactly `rows` of
    // them — the same DOM this app already addresses in index.css.
    const screen = () => element.querySelector(".xterm-screen")

    /**
     * Stand down for a program that turned mouse reporting on. xterm marks its
     * root and forwards the wheel to the program instead of scrolling its own
     * buffer; 5.x's touch handlers carried the same guard, and scrolling a
     * buffer that a full-screen app is redrawing is worse than not scrolling.
     */
    const reporting = () => t.element?.classList.contains("enable-mouse-events") === true

    /**
     * A selection in progress owns the finger. On touch the rows are handed
     * back to the platform (see index.css) so a long press can select and copy
     * — and dragging one of those handles also fires touchmove, so scrolling
     * underneath would fight the very gesture that was enabled.
     */
    const selecting = () => {
      const selection = element.ownerDocument.getSelection()
      const anchor = selection?.anchorNode ?? null
      return !!selection && !selection.isCollapsed && anchor !== null && element.contains(anchor)
    }

    // A second finger is a pinch, and pinch-zoom belongs to the browser.
    const single = (event: TouchEvent) => event.touches.length === 1 && !reporting()

    const onStart = (event: TouchEvent) => {
      // A finger JOINING mid-gesture ends it rather than being ignored: the
      // gesture must not still be following a finger through a pinch and then
      // cash the whole pinch out as one scroll when the other one lifts.
      if (!single(event)) gesture.end()
      else gesture.start(event.touches[0]!.clientY, event.touches[0]!.identifier)
    }
    const onMove = (event: TouchEvent) => {
      if (!single(event) || selecting()) return
      const touch = event.touches[0]!
      const step = gesture.move(touch.clientY, cellHeightOf(screen(), t.rows), touch.identifier)
      if (!step.claimed) return
      // Only once the gesture IS a scroll. Defaulting the touch any earlier
      // stops the browser synthesizing the mouse events that focus the
      // terminal, and tap-to-type is the one thing that already worked here.
      event.preventDefault()
      if (step.lines !== 0) t.scrollLines(step.lines)
    }
    const onEnd = () => gesture.end()

    element.addEventListener("touchstart", onStart, { passive: true })
    element.addEventListener("touchmove", onMove, { passive: false })
    element.addEventListener("touchend", onEnd, { passive: true })
    element.addEventListener("touchcancel", onEnd, { passive: true })
    return () => {
      element.removeEventListener("touchstart", onStart)
      element.removeEventListener("touchmove", onMove)
      element.removeEventListener("touchend", onEnd)
      element.removeEventListener("touchcancel", onEnd)
    }
    // host and term are refs; they are here only to satisfy the lint rule,
    // which cannot see that a ref passed as a parameter is stable.
  }, [active, host, term])
}

/**
 * Inject xterm's CSS once for the whole app.
 *
 * Load-bearing on the desktop's content policy, and so is xterm itself: its
 * DOM renderer delivers the terminal's font, cell metrics and every ANSI
 * color class through <style> elements it creates the same way. The daemon
 * serves this page with no CSP, so the browser can never catch a policy that
 * refuses them — see the webview content policy in desktop/README.md.
 */
function useXtermStyles() {
  const id = useId()
  useEffect(() => {
    const key = "wisp-xterm-css"
    if (document.getElementById(key)) return
    const style = document.createElement("style")
    style.id = key
    style.textContent = xtermCss
    document.head.append(style)
  }, [id])
}
