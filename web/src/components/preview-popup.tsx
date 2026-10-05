import { Dialog } from "@base-ui/react/dialog"
import type { ReactNode } from "react"

import { useOpenOrigin } from "@/lib/open-origin"
import { cn } from "@/lib/utils"

/**
 * The centred 80vw/80vh reading popup: a worktree file from Changes, or a text
 * attachment from the transcript. Escape and backdrop dismiss come from the
 * primitive, on the same `z-(--z-backdrop)` / `z-(--z-modal)` pair every
 * dialog uses. It grows out of what you clicked (`lib/open-origin.ts`). Tabs
 * sit above the code surface; one muted caption line sits under it.
 *
 * `flush` drops the surface's padding for content that draws its own edges,
 * like a table whose header rule should meet the border.
 */
export function PreviewPopup({
  open,
  onClose,
  title,
  testId,
  tabs,
  flush = false,
  footer,
  children,
}: {
  open: boolean
  onClose: () => void
  title: string
  testId: string
  tabs?: ReactNode
  flush?: boolean
  footer: ReactNode
  children: ReactNode
}) {
  const origin = useOpenOrigin(open)
  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-(--z-backdrop) bg-scrim" />
        <Dialog.Popup
          data-testid={testId}
          style={origin}
          className="wisp-zoom fixed top-1/2 left-1/2 z-(--z-modal) flex max-h-[80vh] w-[80vw] -translate-x-1/2 -translate-y-1/2 flex-col gap-2 outline-none"
        >
          <Dialog.Title className="sr-only">{title}</Dialog.Title>
          {tabs}
          <div
            className={cn(
              "scroll-slim min-h-0 flex-1 overflow-auto rounded-md border border-border bg-code",
              !flush && "px-4 py-3",
            )}
          >
            {children}
          </div>
          {footer}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

/** The caption line under a preview: name, size, and whatever the view adds. */
export function PreviewFooter({ children }: { children: ReactNode }) {
  return (
    <div className="flex shrink-0 items-center gap-2 text-[11.5px] text-muted-foreground">{children}</div>
  )
}

/** A right-aligned footer action — Reveal in Finder, Download. */
export const PREVIEW_FOOTER_ACTION =
  "ml-auto flex shrink-0 items-center gap-1 transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none [&_svg]:size-3.5"
