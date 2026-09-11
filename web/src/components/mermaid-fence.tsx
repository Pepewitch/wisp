import { useEffect, useRef, useState, type ReactNode } from "react"

import { Code, Flowchart, Refresh, ZoomIn, ZoomOut } from "@/components/icons"
import { cn } from "@/lib/utils"

/**
 * A ```mermaid fence.
 *
 * Renders as code — Wisp's plain mono surface, deliberately untouched — until
 * the toggle in the corner asks for the diagram. The switch exists because a
 * diagram replaces the text that produced it, and an agent's output is read
 * far more often than it is visualised: the source must be the default, not
 * the casualty.
 *
 * `mermaid` itself is behind a dynamic import (the plugin statically pulls the
 * real package), so its cost is paid on first toggle and never for a
 * transcript that has no diagrams. Zoom and pan are ours: wheel to zoom,
 * drag to move, buttons to nudge — no editor, just a viewer.
 */

const ZOOM_STEP = 0.15
const MIN_ZOOM = 0.5
const MAX_ZOOM = 3

/** Mermaid requires a fresh id per render; collisions leak stale SVGs. */
let MERMAID_SEQ = 0
const nextMermaidId = () => `wisp-mermaid-${(MERMAID_SEQ += 1)}`

/** The fence, with its corner switch. `children` is the code surface. */
export function MermaidFence({ code, children }: { code: string; children: ReactNode }) {
  const [showDiagram, setShowDiagram] = useState(false)

  return (
    <div className="group relative mt-2.5">
      {showDiagram ? <MermaidDiagram code={code} /> : children}
      <button
        type="button"
        onClick={() => setShowDiagram((view) => !view)}
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

/** The rendered diagram: loading, error with retry, or the pan/zoom surface. */
function MermaidDiagram({ code }: { code: string }) {
  const [attempt, setAttempt] = useState(0)
  // The render that produced this state is carried alongside it: while a
  // newer `code` or retry has not landed yet, the old SVG would flash — so
  // it shows the loading surface instead, and no effect ever writes state
  // synchronously to "clear" it.
  const [render, setRender] = useState<
    { code: string; attempt: number; svg: string } | { code: string; attempt: number; error: string } | null
  >(null)
  const current = render !== null && render.code === code && render.attempt === attempt ? render : null

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        // Dynamic, and the only reference to the plugin: its module loads the
        // mermaid package eagerly, so a static import here would evaluate the
        // whole library on every app start.
        const { mermaid: plugin } = await import("@streamdown/mermaid")
        const dark = document.documentElement.classList.contains("dark")
        const mermaid = plugin.getMermaid({
          startOnLoad: false,
          securityLevel: "strict",
          suppressErrorRendering: true,
          theme: dark ? "dark" : "default",
        })
        const { svg } = await mermaid.render(nextMermaidId(), code)
        if (!cancelled) setRender({ code, attempt, svg })
      } catch (error) {
        if (!cancelled) setRender({ code, attempt, error: renderError(error) })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [code, attempt])

  if (current === null) {
    return (
      <div className="flex h-72 items-center justify-center rounded-md border border-border bg-code">
        <div className="size-4 animate-spin rounded-full border-2 border-fg-secondary border-t-transparent" />
      </div>
    )
  }

  if ("error" in current) {
    return (
      <div className="flex h-72 flex-col items-center justify-center gap-3 rounded-md border border-border bg-code px-4 text-center">
        <p className="line-clamp-3 font-mono text-[11px] text-fg-secondary">{current.error}</p>
        <button
          type="button"
          onClick={() => setAttempt((value) => value + 1)}
          className={cn(
            "cursor-pointer rounded-md border border-border bg-card px-2 py-1 text-[11px] text-fg-secondary",
            "hover:text-foreground"
          )}
        >
          Retry
        </button>
      </div>
    )
  }

  return <PanZoom svg={current.svg} />
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

/** Wheel zooms, drag pans, and the corner buttons nudge — a viewer, not an editor. */
function PanZoom({ svg }: { svg: string }) {
  const surface = useRef<HTMLDivElement>(null)
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [dragging, setDragging] = useState(false)
  const last = useRef({ x: 0, y: 0 })

  const zoomBy = (delta: number) => setZoom((current) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, current + delta)))

  // React registers wheel passively at the root; preventing the browser's
  // scroll-zoom needs our own listener.
  useEffect(() => {
    const element = surface.current
    if (!element) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      setZoom((current) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, current + (event.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP))))
    }
    element.addEventListener("wheel", onWheel, { passive: false })
    return () => element.removeEventListener("wheel", onWheel)
  }, [])

  return (
    <div
      ref={surface}
      role="application"
      aria-label="Mermaid diagram"
      onPointerDown={(event) => {
        if (event.button !== 0) return
        event.currentTarget.setPointerCapture(event.pointerId)
        setDragging(true)
        last.current = { x: event.clientX, y: event.clientY }
      }}
      onPointerMove={(event) => {
        if (!dragging) return
        const dx = event.clientX - last.current.x
        const dy = event.clientY - last.current.y
        last.current = { x: event.clientX, y: event.clientY }
        setPan((current) => ({ x: current.x + dx, y: current.y + dy }))
      }}
      onPointerUp={(event) => {
        setDragging(false)
        event.currentTarget.releasePointerCapture(event.pointerId)
      }}
      onPointerCancel={() => setDragging(false)}
      style={{ cursor: dragging ? "grabbing" : "grab", touchAction: "none" }}
      className={cn("relative h-72 touch-none overflow-hidden rounded-md border border-border bg-code", "select-none")}
    >
      <div
        className={cn(
          "flex h-full w-full items-center justify-center [&>svg]:h-auto [&>svg]:max-w-full",
          "transition-transform duration-150 ease-out"
        )}
        style={{
          transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
          transformOrigin: "center center",
          willChange: "transform",
        }}
        dangerouslySetInnerHTML={{ __html: svg }}
      />
      <div
        className={cn(
          "absolute bottom-2 left-2 flex flex-col gap-1 rounded-md border border-border bg-card/80 p-1",
          "supports-[backdrop-filter]:bg-card/70 supports-[backdrop-filter]:backdrop-blur"
        )}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <ZoomButton label="Zoom in" icon={ZoomIn} disabled={zoom >= MAX_ZOOM} onClick={() => zoomBy(ZOOM_STEP)} />
        <ZoomButton label="Zoom out" icon={ZoomOut} disabled={zoom <= MIN_ZOOM} onClick={() => zoomBy(-ZOOM_STEP)} />
        <ZoomButton
          label="Reset zoom and pan"
          icon={Refresh}
          disabled={zoom === 1 && pan.x === 0 && pan.y === 0}
          onClick={() => {
            setZoom(1)
            setPan({ x: 0, y: 0 })
          }}
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
