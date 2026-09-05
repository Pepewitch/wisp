import type { ReactNode } from "react"

import { Dismiss } from "@/components/icons"
import { POPOVER_SURFACE } from "@/components/primitives"
import { cn } from "@/lib/utils"

export function ReportPanel({
  testId,
  title,
  source,
  aside,
  onClose,
  className,
  children,
}: {
  testId: string
  title: string
  source: string
  aside?: ReactNode
  onClose: () => void
  className?: string
  children: ReactNode
}) {
  return (
    <div
      data-testid={testId}
      className={cn(POPOVER_SURFACE, "scroll-slim max-h-[60vh] overflow-y-auto rounded-lg p-3", className)}
    >
      <div className="mb-2 flex items-center gap-2">
        <span className="font-mono text-[12px] text-foreground">{title}</span>
        <span className="text-[11px] text-muted-foreground">{source}</span>
        <span className="flex-1" />
        {aside}
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          className="shrink-0 rounded-sm p-0.5 text-faint transition-colors hover:text-foreground"
        >
          <Dismiss className="size-3" />
        </button>
      </div>
      {children}
    </div>
  )
}
