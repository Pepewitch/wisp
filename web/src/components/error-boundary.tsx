import { Component, type ErrorInfo, type ReactNode } from "react"

import { ChevronRight } from "@/components/icons"
import { Button } from "@/components/primitives"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { cn } from "@/lib/utils"

/**
 * One render exception used to unmount the whole React root — no sidebar, no
 * header, nothing to switch away from a task whose one bad turn broke the
 * page. `AppErrorBoundary` (`main.tsx`, around the whole app) and
 * `PaneErrorBoundary` (one per pane below it) are the same class with a
 * different fallback, so a crash anywhere degrades the smallest surface that
 * actually broke rather than the page it happened to be inside.
 *
 * Both are keyed by the caller: `key={taskId}` on a `PaneErrorBoundary` is
 * what resets it on a task switch — React remounts the boundary (and clears
 * whatever it caught) the moment the key changes, the same way any other
 * per-task subtree already resets.
 */
type Fallback = (info: { error: Error; onRetry: () => void }) => ReactNode

interface BoundaryProps {
  children: ReactNode
  fallback: Fallback
}

interface BoundaryState {
  error: Error | null
}

class Boundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { error: null }

  static getDerivedStateFromError(error: unknown): BoundaryState {
    return { error: error instanceof Error ? error : new Error(String(error)) }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // The one place this is logged. The root's own `onCaughtError` is a no-op
    // (see main.tsx) so an operator sees this line once, not twice.
    console.error(error, info.componentStack)
  }

  retry = () => this.setState({ error: null })

  render() {
    const { error } = this.state
    if (error) return this.props.fallback({ error, onRetry: this.retry })
    return this.props.children
  }
}

/** No stack, ever — a message is enough for a bug report and cannot leak a path a user didn't paste in. */
function ErrorDetails({ error, className }: { error: Error; className?: string }) {
  const message = error.message || String(error)
  return (
    <Collapsible defaultOpen={false} className={cn("w-full", className)}>
      <CollapsibleTrigger className="group mx-auto flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground">
        <ChevronRight
          aria-hidden
          className="size-3 shrink-0 transition-transform group-data-panel-open:rotate-90"
        />
        Error details
      </CollapsibleTrigger>
      <CollapsibleContent>
        <p className="scroll-slim mt-1.5 max-h-28 overflow-auto rounded-md border border-border bg-code px-2.5 py-2 text-left font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words text-fg-secondary">
          {message}
        </p>
      </CollapsibleContent>
    </Collapsible>
  )
}

function AppFallback({ error, onRetry }: { error: Error; onRetry: () => void }) {
  return (
    <div
      role="alert"
      className="flex h-dvh flex-col items-center justify-center gap-2.5 bg-background p-6 text-center text-foreground"
    >
      <p className="max-w-sm text-[13px] text-destructive">
        Wisp hit a problem it could not recover from on its own.
      </p>
      <div className="flex items-center gap-2">
        <Button tone="outline" size="md" onClick={onRetry}>
          Try again
        </Button>
        <Button tone="primary" size="md" onClick={() => window.location.reload()}>
          Reload
        </Button>
      </div>
      <ErrorDetails error={error} className="max-w-xs" />
    </div>
  )
}

/** The app's one catch-all, around everything `main.tsx` renders. */
export function AppErrorBoundary({ children }: { children: ReactNode }) {
  return <Boundary fallback={(info) => <AppFallback {...info} />}>{children}</Boundary>
}

function PaneFallback({
  label,
  error,
  onRetry,
  fill,
}: {
  label: string
  error: Error
  onRetry: () => void
  fill: boolean
}) {
  return (
    <div
      role="alert"
      className={cn(
        "flex flex-col items-center gap-2 text-center",
        fill
          ? "h-full min-h-0 w-full flex-1 justify-center bg-background p-6"
          : "w-full max-w-md gap-1.5 rounded-lg border border-border bg-background px-3 py-3.5",
      )}
    >
      <p className="text-[12.5px] text-destructive">Something went wrong showing {label}.</p>
      <Button tone="outline" size="sm" onClick={onRetry}>
        Try again
      </Button>
      <ErrorDetails error={error} className="max-w-xs" />
    </div>
  )
}

/**
 * One pane's own boundary, so a bad turn, diagram, diff or shell degrades
 * only the pane that rendered it. `label` completes "Something went wrong
 * showing …" in plain words — "the conversation", "this content", "the
 * terminal", "this file", "the changes".
 *
 * `fill` is false for a boundary sitting inside flowing content rather than
 * owning a whole pane (prose's own, per rendered block): the fallback then
 * reads as a small card in the flow instead of claiming the full pane height.
 */
export function PaneErrorBoundary({
  label,
  fill = true,
  children,
}: {
  label: string
  fill?: boolean
  children: ReactNode
}) {
  return (
    <Boundary fallback={(info) => <PaneFallback {...info} label={label} fill={fill} />}>
      {children}
    </Boundary>
  )
}
