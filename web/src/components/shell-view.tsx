import { useCallback, useEffect, useId, useRef, useState, type RefObject } from "react"
import { FitAddon } from "@xterm/addon-fit"
import { SearchAddon, type ISearchOptions } from "@xterm/addon-search"
import { Terminal, type ITheme } from "@xterm/xterm"
import xtermCss from "@xterm/xterm/css/xterm.css?inline"

import { TerminalFindBar } from "@/components/terminal-find-bar"
import { isClearChord, isFindChord, terminalOriginRefusal, TerminalConnection } from "@/lib/terminal"
import { cellHeightOf, TouchScrollGesture } from "@/lib/terminal-touch"
import { themeStore, useTheme, type Theme } from "@/lib/theme"
import type { DaemonTransport } from "@/lib/transport"
import { cn } from "@/lib/utils"

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

/**
 * Find highlights, painted by xterm's search addon — which, like the theme
 * above, takes JS colours and so lives in this licensed hex block. They are
 * the transcript's `--find-match` pair from index.css, with the translucent
 * current-match violet flattened onto each terminal background, because the
 * addon accepts only `#RRGGBB`.
 */
const FIND_DECORATIONS: Record<Theme, NonNullable<ISearchOptions["decorations"]>> = {
  dark: {
    matchBackground: "#3a3a45",
    matchOverviewRuler: "#3a3a45",
    activeMatchBackground: "#5e4b80",
    activeMatchColorOverviewRuler: "#5e4b80",
  },
  light: {
    matchBackground: "#d6d6e4",
    matchOverviewRuler: "#d6d6e4",
    activeMatchBackground: "#bda8ea",
    activeMatchColorOverviewRuler: "#bda8ea",
  },
}

/** What the strip's controls may do to the xterm behind one tab. */
export interface ShellHandle {
  terminal: Terminal
  /** drop the scrollback, here and in the daemon's copy */
  clear(): void
  /** open a new socket, which starts a fresh shell if the last one is gone */
  reconnect(): void
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
export function ShellView({
  transport,
  taskId,
  shellId,
  active,
  register,
  apple,
  daemonScreen,
  finding,
  onFind,
  onFindClose,
  touch,
}: {
  transport: DaemonTransport
  taskId: string
  shellId: number
  active: boolean
  /** Publish this tab's controls to the strip; null on teardown. */
  register: (id: number, handle: ShellHandle | null) => void
  apple: boolean
  /** the daemon keeps a screen this pane can clear (`taskTerminals`) */
  daemonScreen: boolean
  /** the find bar's focus token while it is open for this shell, else null */
  finding: number | null
  onFind: () => void
  onFindClose: () => void
  touch: boolean
}) {
  const host = useRef<HTMLDivElement>(null)
  const term = useRef<Terminal | null>(null)
  const fit = useRef<FitAddon | null>(null)
  const [search, setSearch] = useState<SearchAddon | null>(null)
  const theme = useTheme()
  const { phase, detail, noPty, conn, measure, pushSize, retry } = useShellConnection({
    transport,
    taskId,
    shellId,
    active,
    // the terminal is built by an effect BELOW this hook, so the connect
    // effect first runs with `term` still empty; this flips it into a re-run
    ready: search !== null,
    term,
    fit,
  })

  // The key handler is installed once with the terminal; these change, so it
  // reads them through a ref rather than rebuilding a live shell to rebind.
  const keys = useRef({ apple, daemonScreen, onFind })
  useEffect(() => {
    keys.current = { apple, daemonScreen, onFind }
  })

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
    const s = new SearchAddon()
    t.loadAddon(f)
    t.loadAddon(s)
    t.open(host.current)
    term.current = t
    fit.current = f
    setSearch(s)

    const clear = () => {
      t.clear()
      if (keys.current.daemonScreen) conn.current?.sendClear()
    }
    // ⌘F and ⌘K reach the terminal first, because it has focus. Taken here,
    // they never become input; everything else — Ctrl+F and Ctrl+K on Linux
    // and Windows included — goes to the shell untouched.
    t.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown") return true
      if (isFindChord(event, keys.current.apple)) {
        event.preventDefault()
        keys.current.onFind()
        return false
      }
      if (isClearChord(event, keys.current.apple)) {
        event.preventDefault()
        clear()
        return false
      }
      return true
    })

    register(shellId, { terminal: t, clear, reconnect: retry })
    return () => {
      register(shellId, null)
      setSearch(null)
      t.dispose()
      term.current = null
      fit.current = null
    }
  }, [register, shellId, retry, conn])

  // A theme switch repaints the live terminal in place — scrollback, the
  // socket and the running process are all untouched.
  useEffect(() => {
    if (term.current) term.current.options.theme = TERMINAL_THEME[theme]
  }, [theme])

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
    // measure and pushSize read refs only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])

  useTouchScroll(host, term, active)

  return (
    <div className={cn("absolute inset-0 flex flex-col", !active && "pointer-events-none invisible")}>
      <div ref={host} className="min-h-0 flex-1 px-2.5 pb-1" />
      {active && finding !== null && search && (
        <TerminalFindBar
          search={search}
          decorations={FIND_DECORATIONS[theme]}
          focusToken={finding}
          apple={apple}
          onClose={onFindClose}
          touch={touch}
        />
      )}
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
              onClick={retry}
              className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
            >
              {/* reconnecting to a shell that ended starts a new one */}
              {phase === "exited" ? "restart" : "retry"}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * The socket behind one tab: open while the tab is active, retried while the
 * daemon is not ready yet, and reporting what state the shell is in.
 */
function useShellConnection({
  transport,
  taskId,
  shellId,
  active,
  ready,
  term,
  fit,
}: {
  transport: DaemonTransport
  taskId: string
  shellId: number
  active: boolean
  /** the xterm exists, so `term` is readable; the connect effect re-runs when it flips */
  ready: boolean
  term: RefObject<Terminal | null>
  fit: RefObject<FitAddon | null>
}) {
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
  const retry = useCallback(() => {
    retries.current = 0
    setAttempt((n) => n + 1)
  }, [])

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
    if (!active || !ready || !t) return
    let live = true
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    // A named {type:"error"} the daemon sent before hello ("shell limit
    // reached", a worktree that vanished). It explains the close that follows,
    // and retrying past it would replace a real reason with a bare code.
    let refusal: string | null = null
    let sawHello = false

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
      // The next socket starts from "connecting". Reset on the way out rather
      // than the way in, so opening one never renders twice.
      setPhase("connecting")
      setDetail(null)
      setNoPty(false)
    }
    // measure reads refs only; term is a ref
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transport, taskId, shellId, active, attempt, ready])

  return { phase, detail, noPty, conn, measure, pushSize, retry }
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
