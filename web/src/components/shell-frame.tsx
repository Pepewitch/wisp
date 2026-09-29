import type { ReactNode, Ref } from "react"

import { cn } from "@/lib/utils"

/** What a tab says until its shell answers — and while its code is on the way. */
export const SHELL_CONNECTING = "connecting…"

/**
 * The box one shell tab paints in, kept apart from xterm so the browser can
 * draw it before the terminal code has arrived (`lazy-shell-view.tsx`). Both
 * the loaded tab and the waiting one use it, so waiting looks exactly like a
 * fresh tab connecting rather than like a second design.
 */
export function ShellFrame({
  active,
  host,
  children,
}: {
  active: boolean
  /** where xterm opens; absent while its code is still loading */
  host?: Ref<HTMLDivElement>
  children?: ReactNode
}) {
  return (
    <div className={cn("absolute inset-0 flex flex-col", !active && "pointer-events-none invisible")}>
      <div ref={host} className="min-h-0 flex-1 px-2.5 pb-1" />
      {children}
    </div>
  )
}

/** The one muted line under a shell that is not simply live, and what it offers. */
export function ShellStatus({
  children,
  wrap = false,
  title,
  actions,
}: {
  children: ReactNode
  /** an error can be a whole sentence: wrap it rather than truncate it */
  wrap?: boolean
  title?: string
  actions?: ReactNode
}) {
  return (
    <div className="flex shrink-0 items-start gap-2.5 px-3.5 pb-1.5 font-mono text-[10.5px] text-faint">
      <span className={cn("min-w-0", wrap ? "line-clamp-3 break-words" : "truncate")} title={title}>
        {children}
      </span>
      {actions}
    </div>
  )
}

export function ShellStatusAction({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
    >
      {children}
    </button>
  )
}
