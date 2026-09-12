import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react"

import { Code, Flowchart, Refresh, ZoomIn, ZoomOut } from "@/components/icons"
import { useDebouncedValue } from "@/hooks/useDebouncedValue"
import {
  clampDiagramHeight,
  MAX_DIAGRAM_HEIGHT,
  MIN_DIAGRAM_HEIGHT,
  readDiagramHeight,
  writeDiagramHeight,
} from "@/lib/diagram-height"
import { mermaidThemeVariables } from "@/lib/mermaid-theme"
import { useTheme } from "@/lib/theme"
import { cn } from "@/lib/utils"

/**
 * A ```mermaid fence.
 *
 * A diagram is what the fence MEANT, so a diagram is what it shows — but only
 * once there is one. A fence still arriving, or one mermaid cannot parse, is
 * left as the source it already is: an agent writes a diagram a character at
 * a time, and flashing a parse error at someone mid-turn to announce that the
 * second half has not arrived yet is worse than showing them the text. The
 * corner switch pins either view once a person picks one.
 *
 * `mermaid` itself is behind a dynamic import (the plugin statically pulls the
 * real package), so its cost is paid by the first fence that appears and never
 * by a transcript that has none. Zoom, pan and height are ours: wheel to zoom,
 * drag to move, drag the bottom edge for room — no editor, just a viewer.
 */

const ZOOM_STEP = 0.15
const MIN_ZOOM = 0.5
const MAX_ZOOM = 3

/** How long a fence has to stop changing before it is worth parsing. */
const SETTLE_MS = 200

/** Mermaid requires a fresh id per render; collisions leak stale SVGs. */
let MERMAID_SEQ = 0
const nextMermaidId = () => `wisp-mermaid-${(MERMAID_SEQ += 1)}`

/** The fence, with its corner switch. `children` is the code surface. */
export function MermaidFence({ code, children }: { code: string; children: ReactNode }) {
  const [choice, setChoice] = useState<"source" | "diagram" | null>(null)
  const [render, retry] = useMermaidRender(code)

  // Nobody has chosen yet: follow the fence. It becomes a diagram the moment
  // one exists, and stays source until then.
  const showDiagram = choice === null ? render.status === "ready" : choice === "diagram"

  return (
    <div className="group relative mt-2.5">
      {showDiagram ? <MermaidDiagram render={render} onRetry={retry} /> : children}
      <button
        type="button"
        onClick={() => setChoice(showDiagram ? "source" : "diagram")}
        aria-pressed={showDiagram}
        aria-label={showDiagram ? "Show source" : "Render diagram"}
        title={showDiagram ? "Show source" : "Render diagram"}
        className={cn(
          "absolute top-2 right-2 z-10 flex cursor-pointer items-center justify-center rounded-md border border-border bg-card/80 p-1.5",
          "text-fg-secondary transition-opacity hover:text-foreground",
          "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
          "supports-[backdrop-filter]:bg-card/70 supports-[backdrop-filter]:backdrop-blur"
        )}
      >
        {showDiagram ? <Code className="size-3" /> : <Flowchart className="size-3" />}
      </button>
    </div>
  )
}

type MermaidRender =
  | { status: "loading" }
  | { status: "ready"; svg: string }
  | { status: "error"; message: string }

/**
 * The SVG for a fence, re-rendered whenever its source, the app's theme, or a
 * retry moves.
 *
 * Mermaid bakes the palette INTO the SVG it returns — there is no token a
 * stylesheet can move afterwards — so the theme is a render input like the
 * source is, and a diagram left over from the other end of the scale is a
 * diagram in the wrong colours. That is the whole reason this reads
 * `useTheme()` rather than the `dark` class it used to sample once, inside an
 * effect that never ran again.
 *
 * Two rules about what the caller sees while an attempt is in flight:
 *
 * - A newer FENCE shows nothing. The previous SVG is a picture of text that
 *   is no longer on screen, so it would be a lie for as long as it hung around.
 * - A newer THEME keeps the picture. It is the same diagram either way, and
 *   holding the old colours for a frame beats blanking a diagram someone has
 *   panned and zoomed — which is what unmounting the viewer would cost them.
 *
 * `code` is debounced because a fence arrives a chunk at a time and
 * `mermaid.render` is not cheap: without it every chunk parses a broken
 * diagram on the way to the whole one.
 */
function useMermaidRender(code: string): [MermaidRender, () => void] {
  const theme = useTheme()
  const [attempt, setAttempt] = useState(0)
  const settled = useDebouncedValue(code, SETTLE_MS)
  const key = `${theme}\u0000${attempt}\u0000${settled}`

  // The inputs that produced a result are carried with it, so no effect ever
  // has to write state synchronously to clear a stale one.
  const [done, setDone] = useState<
    { key: string; code: string; svg: string } | { key: string; code: string; message: string } | null
  >(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        // Dynamic, and the only reference to the plugin: its module loads the
        // mermaid package eagerly, so a static import here would evaluate the
        // whole library on every app start.
        const { mermaid: plugin } = await import("@streamdown/mermaid")
        const mermaid = plugin.getMermaid({
          startOnLoad: false,
          securityLevel: "strict",
          suppressErrorRendering: true,
          // `base` is mermaid's "derive it from what I give you"; the stock
          // themes are palettes to fight rather than extend.
          theme: "base",
          themeVariables: mermaidThemeVariables(theme),
        })
        const { svg } = await mermaid.render(nextMermaidId(), settled)
        if (!cancelled) setDone({ key, code: settled, svg })
      } catch (error) {
        if (!cancelled) setDone({ key, code: settled, message: renderError(error) })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [key, settled, theme])

  const current =
    done === null
      ? null
      : done.key === key
        ? done
        : // same fence, a newer theme or retry still rendering: hold the picture
          "svg" in done && done.code === settled
          ? done
          : null

  const retry = useCallback(() => setAttempt((value) => value + 1), [])
  if (current === null) return [{ status: "loading" }, retry]
  return ["svg" in current ? { status: "ready", svg: current.svg } : { status: "error", message: current.message }, retry]
}

/** The diagram's three faces, in the frame whose height a person owns. */
function MermaidDiagram({ render, onRetry }: { render: MermaidRender; onRetry: () => void }) {
  return (
    <DiagramFrame>
      {render.status === "loading" ? (
        <div className="flex h-full items-center justify-center rounded-md border border-border bg-code">
          <div className="size-4 animate-spin rounded-full border-2 border-fg-secondary border-t-transparent" />
        </div>
      ) : render.status === "error" ? (
        <div className="flex h-full flex-col items-center justify-center gap-3 rounded-md border border-border bg-code px-4 text-center">
          <p className="line-clamp-3 font-mono text-[11px] text-fg-secondary">{render.message}</p>
          <button
            type="button"
            onClick={onRetry}
            className={cn(
              "cursor-pointer rounded-md border border-border bg-card px-2 py-1 text-[11px] text-fg-secondary",
              "hover:text-foreground"
            )}
          >
            Retry
          </button>
        </div>
      ) : (
        <PanZoom svg={render.svg} />
      )}
    </DiagramFrame>
  )
}

function renderError(error: unknown): string {
  // Mermaid throws strings and `{ str }` objects as readily as Errors, and a
  // parse failure quotes the offending line — enough to fix the diagram.
  const message =
    typeof error === "string"
      ? error
      : error instanceof Error
        ? error.message
        : typeof error === "object" && error !== null && "str" in error && typeof error.str === "string"
          ? error.str
          : "The diagram could not be rendered."
  return message.length > 300 ? `${message.slice(0, 300)}…` : message
}

/**
 * The box the diagram lives in, as tall as the last one someone chose.
 *
 * Its bottom edge drags, like every other divider in the shell — a hairline
 * grip that appears with the corner switch. A height change is a layout, so
 * the frame is written directly while the pointer is down and React commits
 * the result once, on release, rather than re-rendering the diagram sixty
 * times a second.
 */
function DiagramFrame({ children }: { children: ReactNode }) {
  const [height, setHeight] = useState(readDiagramHeight)
  const frame = useRef<HTMLDivElement>(null)
  const drag = useRef<{ pointer: number; from: number; height: number; next: number } | null>(null)

  const show = (next: number) => {
    const element = frame.current
    if (element) element.style.height = `${next}px`
  }

  const commit = (next: number) => {
    setHeight(next)
    writeDiagramHeight(next)
  }

  const end = (event: ReactPointerEvent<HTMLDivElement>, keep: boolean) => {
    const state = drag.current
    if (!state || state.pointer !== event.pointerId) return
    drag.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId)
    if (keep) commit(state.next)
    else show(height)
  }

  return (
    <div ref={frame} className="relative" style={{ height }}>
      {children}
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize diagram"
        aria-valuenow={height}
        aria-valuemin={MIN_DIAGRAM_HEIGHT}
        aria-valuemax={MAX_DIAGRAM_HEIGHT}
        tabIndex={0}
        onPointerDown={(event) => {
          if (event.button !== 0) return
          event.preventDefault()
          event.currentTarget.setPointerCapture(event.pointerId)
          drag.current = { pointer: event.pointerId, from: event.clientY, height, next: height }
        }}
        onPointerMove={(event) => {
          const state = drag.current
          if (!state || state.pointer !== event.pointerId) return
          state.next = clampDiagramHeight(state.height + (event.clientY - state.from))
          show(state.next)
        }}
        onPointerUp={(event) => end(event, true)}
        onPointerCancel={(event) => end(event, false)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") commit(clampDiagramHeight(height + 24))
          else if (event.key === "ArrowUp") commit(clampDiagramHeight(height - 24))
          else return
          event.preventDefault()
        }}
        className={cn(
          "group/grip absolute inset-x-0 bottom-0 z-10 flex h-2 touch-none items-end justify-center",
          "cursor-ns-resize focus-visible:outline-none"
        )}
      >
        <span
          aria-hidden
          className={cn(
            "mb-[3px] h-[3px] w-[26px] rounded-sm bg-border-strong transition-[opacity,background-color]",
            "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100",
            "group-hover/grip:bg-muted-foreground"
          )}
        />
      </div>
    </div>
  )
}

type View = { zoom: number; x: number; y: number }

const IDENTITY: View = { zoom: 1, x: 0, y: 0 }
const clampZoom = (zoom: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom))

/**
 * Wheel zooms, drag pans, and the corner buttons nudge — a viewer, not an
 * editor.
 *
 * The transform is NOT React state, and it carries no CSS transition while a
 * pointer is driving it. Both used to be true, and together they made a drag
 * visibly shake: every pointer event re-rendered the subtree and re-aimed a
 * 150ms eased transition that had not finished the last one, so the diagram
 * lurched forward and snapped back tens of pixels several times a second.
 * Input-driven motion is written straight to the node, once per frame; only
 * the discrete button nudges — a step a person asked for, not a position they
 * are holding — are allowed to ease.
 */
function PanZoom({ svg }: { svg: string }) {
  const surface = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const view = useRef<View>({ ...IDENTITY })
  const eased = useRef(false)
  const frame = useRef<number | null>(null)
  const drag = useRef<{ pointer: number; x: number; y: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  // The only thing React still renders about the view: which buttons are dead.
  const [limits, setLimits] = useState({ min: false, max: false, moved: false })

  const paint = useCallback(() => {
    frame.current = null
    const node = content.current
    if (!node) return
    const { zoom, x, y } = view.current
    node.style.transition = eased.current ? "transform 150ms ease-out" : "none"
    node.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${zoom})`
  }, [])

  const apply = useCallback(
    (next: View, ease = false) => {
      view.current = next
      eased.current = ease
      if (frame.current === null) frame.current = requestAnimationFrame(paint)
      setLimits((shown) => {
        const wanted = {
          min: next.zoom <= MIN_ZOOM,
          max: next.zoom >= MAX_ZOOM,
          moved: next.zoom !== 1 || next.x !== 0 || next.y !== 0,
        }
        // same object when nothing changed, so a drag re-renders nothing
        return shown.min === wanted.min && shown.max === wanted.max && shown.moved === wanted.moved ? shown : wanted
      })
    },
    [paint]
  )

  useLayoutEffect(() => {
    paint()
    return () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current)
    }
  }, [paint])

  // React registers wheel passively at the root; preventing the browser's
  // scroll-zoom needs our own listener.
  useEffect(() => {
    const element = surface.current
    if (!element) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      apply({ ...view.current, zoom: clampZoom(view.current.zoom + (event.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP)) })
    }
    element.addEventListener("wheel", onWheel, { passive: false })
    return () => element.removeEventListener("wheel", onWheel)
  }, [apply])

  return (
    <div
      ref={surface}
      role="application"
      aria-label="Mermaid diagram"
      onPointerDown={(event) => {
        if (event.button !== 0) return
        event.currentTarget.setPointerCapture(event.pointerId)
        // the drag lives in a ref, so the first move after the press is not
        // dropped waiting for a render to say it started
        drag.current = { pointer: event.pointerId, x: event.clientX, y: event.clientY }
        setDragging(true)
      }}
      onPointerMove={(event) => {
        const state = drag.current
        if (!state || state.pointer !== event.pointerId) return
        const dx = event.clientX - state.x
        const dy = event.clientY - state.y
        state.x = event.clientX
        state.y = event.clientY
        apply({ ...view.current, x: view.current.x + dx, y: view.current.y + dy })
      }}
      onPointerUp={(event) => {
        drag.current = null
        setDragging(false)
        if (event.currentTarget.hasPointerCapture(event.pointerId))
          event.currentTarget.releasePointerCapture(event.pointerId)
      }}
      onPointerCancel={() => {
        drag.current = null
        setDragging(false)
      }}
      style={{ cursor: dragging ? "grabbing" : "grab" }}
      className={cn("relative h-full touch-none overflow-hidden rounded-md border border-border bg-code", "select-none")}
    >
      <div
        ref={content}
        className="flex h-full w-full items-center justify-center [&>svg]:h-auto [&>svg]:max-w-full"
        style={{ transformOrigin: "center center", willChange: "transform" }}
        dangerouslySetInnerHTML={{ __html: svg }}
      />
      <div
        className={cn(
          "absolute bottom-2 left-2 flex flex-col gap-1 rounded-md border border-border bg-card/80 p-1",
          "supports-[backdrop-filter]:bg-card/70 supports-[backdrop-filter]:backdrop-blur"
        )}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <ZoomButton
          label="Zoom in"
          icon={ZoomIn}
          disabled={limits.max}
          onClick={() => apply({ ...view.current, zoom: clampZoom(view.current.zoom + ZOOM_STEP) }, true)}
        />
        <ZoomButton
          label="Zoom out"
          icon={ZoomOut}
          disabled={limits.min}
          onClick={() => apply({ ...view.current, zoom: clampZoom(view.current.zoom - ZOOM_STEP) }, true)}
        />
        <ZoomButton
          label="Reset zoom and pan"
          icon={Refresh}
          disabled={!limits.moved}
          onClick={() => apply({ ...IDENTITY }, true)}
        />
      </div>
    </div>
  )
}

function ZoomButton({
  label,
  icon: Icon,
  disabled,
  onClick,
}: {
  label: string
  icon: typeof ZoomIn
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex cursor-pointer items-center justify-center rounded p-1 text-fg-secondary transition-colors",
        "hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
      )}
    >
      <Icon className="size-3.5" />
    </button>
  )
}
