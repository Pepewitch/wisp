import { useEffect, useId, useRef, useState } from "react"
import { FitAddon } from "@xterm/addon-fit"
import { Terminal } from "@xterm/xterm"
import xtermCss from "@xterm/xterm/css/xterm.css?inline"

import { Dismiss, Plus } from "@/components/icons"
import { useDaemonRuntime } from "@/lib/runtime"
import { loadShellTabs, saveShellTabs, TerminalConnection, type ShellTabs } from "@/lib/terminal"
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

function labelFor(id: number): string {
  return `Shell ${id + 1}`
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
        ? "The worktree is gone"
        : worktreePath === null
          ? "Preparing the worktree…"
          : null

  return (
    // h-full for the desktop resizable panel, flex-1 for the mobile flex
    // column: without the latter this collapses to its tab strip and xterm
    // opens one row tall
    <div className="flex h-full min-h-0 flex-1 flex-col bg-background">
      <div className={cn("flex shrink-0 items-center gap-1 pr-2.5 pl-2", touch ? "h-12" : "h-8")}>
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
        <button
          type="button"
          onClick={open}
          disabled={unavailable !== null || shells.length >= MAX_SHELLS_PER_TASK}
          aria-label="New shell"
          title="New shell in this worktree"
          className={cn(
            "flex shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors",
            "hover:bg-hover hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent",
            touch ? "size-11" : "size-[22px]",
          )}
        >
          <Plus className={touch ? "size-4" : "size-3"} />
        </button>
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
            />
          ))
        )}
      </div>
    </div>
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
  return (
    <span
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
}: {
  transport: DaemonTransport
  taskId: string
  shellId: number
  active: boolean
}) {
  const host = useRef<HTMLDivElement>(null)
  const term = useRef<Terminal | null>(null)
  const fit = useRef<FitAddon | null>(null)
  const conn = useRef<TerminalConnection | null>(null)
  const [phase, setPhase] = useState<Phase>("connecting")
  const [detail, setDetail] = useState<string | null>(null)
  // bumping this re-runs the connect effect; the budget it spends is a ref, so
  // a successful hello can refill it without tearing the live socket back down
  const [attempt, setAttempt] = useState(0)
  const retries = useRef(0)

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
      theme: {
        background: "#0b0b0d",
        foreground: "#a2a2ad",
        cursor: "#af87f1",
        selectionBackground: "#2b2b34",
        black: "#0b0b0d",
        brightBlack: "#55555f",
        white: "#eaeaee",
        brightWhite: "#ffffff",
        green: "#6bc48d",
        red: "#de6f6b",
        yellow: "#ddb055",
        blue: "#7c92b4",
        magenta: "#af87f1",
        cyan: "#7fc9c0",
      },
    })
    const f = new FitAddon()
    t.loadAddon(f)
    t.open(host.current)
    term.current = t
    fit.current = f
    return () => {
      t.dispose()
      term.current = null
      fit.current = null
    }
  }, [])

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

    const c = new TerminalConnection(
      taskId,
      shellId,
      {
        onHello: (hello) => {
          setPhase("live")
          sawHello = true
          retries.current = 0 // a live shell refills the budget for the NEXT drop
          // RESET, then replay: this xterm may already hold what it rendered
          // before the socket was disposed, and appending the daemon's copy
          // on top of it would double every line. After this the screen is
          // exactly the daemon's buffer, whatever the tab held before.
          t.reset()
          if (hello.replay) t.write(hello.replay)
          queueMicrotask(() => {
            fit.current?.fit()
            const d = fit.current?.proposeDimensions()
            if (d) c.sendResize(d.cols, d.rows)
          })
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
    const refit = () => {
      fit.current?.fit()
      const d = fit.current?.proposeDimensions()
      if (d && d.cols > 0 && d.rows > 0) conn.current?.sendResize(d.cols, d.rows)
    }
    const raf = requestAnimationFrame(refit)
    const ro = new ResizeObserver(refit)
    ro.observe(host.current)
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
    }
  }, [active])

  return (
    <div className={cn("absolute inset-0 flex flex-col", !active && "pointer-events-none invisible")}>
      <div ref={host} className="min-h-0 flex-1 px-2.5 pb-1" />
      {phase !== "live" && (
        <div className="flex shrink-0 items-center gap-2.5 px-3.5 pb-1.5 font-mono text-[10.5px] text-faint">
          <span className="min-w-0 truncate">{phase === "connecting" ? "connecting…" : detail}</span>
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

/** Inject xterm's CSS once for the whole app. */
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
