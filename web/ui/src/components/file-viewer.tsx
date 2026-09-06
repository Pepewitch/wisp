import { Dialog } from "@base-ui/react/dialog"
import { useCallback, useState, type ReactNode } from "react"

import { Prose } from "@/components/prose"
import { formatBytes } from "@/lib/attachments"
import { failureReason } from "@/lib/web-transport"
import { useWorktreeFile } from "@/hooks/queries"
import { cn } from "@/lib/utils"
import { resolveAgainst, WorktreeFileContext } from "@/lib/worktree-files"

/**
 * Reading one file out of the task's worktree without leaving the task — the
 * plan an agent just wrote, most of the time.
 *
 * The same centred 80vw/80vh popup as the image viewer, on the same
 * `z-(--z-backdrop)` / `z-(--z-modal)` pair, with Escape and backdrop dismiss
 * from the primitive: a fourth instance of a settled pattern rather than a new
 * one. The surrounding app stays visible, which is what makes this a look
 * rather than a mode.
 *
 * Markdown is rendered, because a plan is a document and reading it as source
 * defeats the point. Everything else is the file's own bytes in mono on the
 * code surface — a `.ts` is meant to be read as what it is.
 *
 * Fully controlled, like the image viewer: `path` lives with whoever opened it.
 */
export function FileViewer({
  taskId,
  path,
  onClose,
  onOpen,
  onReveal,
}: {
  taskId: string | null
  /** worktree-relative or absolute; null = closed */
  path: string | null
  onClose: () => void
  /** Follow a link inside a rendered document, in this same viewer. */
  onOpen?: (path: string) => void
  /**
   * Reveal the file in the machine's file manager, when the client can. Absent
   * in the browser, and on a remote connection whose paths are on another
   * machine — the button is simply not there rather than failing on click.
   */
  onReveal?: (path: string) => void
}) {
  const open = taskId !== null && path !== null
  const query = useWorktreeFile(open ? taskId : null, open ? path : null)
  const file = query.data

  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-(--z-backdrop) bg-black/70" />
        <Dialog.Popup
          data-testid="file-viewer"
          className="fixed top-1/2 left-1/2 z-(--z-modal) flex max-h-[80vh] w-[80vw] -translate-x-1/2 -translate-y-1/2 flex-col gap-2 outline-none"
        >
          <Dialog.Title className="sr-only">{file?.path ?? path ?? "File"}</Dialog.Title>
          <div className="scroll-slim min-h-0 flex-1 overflow-auto rounded-md border border-border bg-code px-4 py-3">
            {query.isPending ? (
              <p className="font-mono text-[11px] text-faint">reading…</p>
            ) : query.isError ? (
              <p className="font-mono text-[11px] text-faint">{failureReason(query.error)}</p>
            ) : file?.kind === "binary" ? (
              <p className="font-mono text-[11px] text-faint">
                {formatBytes(file.bytes)} of binary — nothing to read here.
              </p>
            ) : file ? (
              isMarkdown(file.path) ? (
                /**
                 * A document's own relative links mean "next to me", not "at
                 * the top of the worktree", so nested prose resolves against
                 * this file's directory and reuses the one open viewer.
                 */
                <WorktreeFileContext.Provider
                  value={(next) => onOpen?.(resolveAgainst(file.path, next))}
                >
                  <Prose text={file.text} />
                </WorktreeFileContext.Provider>
              ) : (
                <pre className="font-mono text-[11.5px] leading-[1.75] whitespace-pre-wrap text-foreground/85">
                  {file.text}
                </pre>
              )
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-2 text-[11.5px] text-muted-foreground">
            <span data-testid="file-viewer-path" className="truncate font-mono">
              {file?.path ?? path}
            </span>
            {file && (
              <>
                <span className="shrink-0 text-faint">·</span>
                <span className="shrink-0">{formatBytes(file.bytes)}</span>
              </>
            )}
            {file?.kind === "text" && file.truncated && (
              <span className="shrink-0 text-faint">· first {formatBytes(file.text.length)} shown</span>
            )}
            {onReveal && file && (
              <button
                type="button"
                onClick={() => onReveal(file.path)}
                className={cn(
                  "ml-auto shrink-0 transition-colors hover:text-foreground",
                  "focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
                )}
              >
                Reveal in Finder
              </button>
            )}
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

/** Rendered as a document, not as source. Extensions only — this is presentation. */
function isMarkdown(path: string): boolean {
  return /\.(?:md|markdown|mdx)$/i.test(path)
}

/**
 * Owns the one viewer for a task view, and hands `Prose` the ability to open
 * it. Anywhere without this provider — the gallery, the probe panel — a path
 * in prose stays text, which is the honest default: there is no worktree
 * behind that prose to read it out of.
 */
export function FileViewerProvider({
  taskId,
  onReveal,
  children,
}: {
  taskId: string | null
  onReveal?: (path: string) => void
  children: ReactNode
}) {
  const [path, setPath] = useState<string | null>(null)
  // Identity-stable so a transcript of prose is not re-rendered per keystroke
  // elsewhere; the viewer is keyed by `path`, not by this.
  const open = useCallback((next: string) => setPath(next), [])

  return (
    <WorktreeFileContext.Provider value={taskId === null ? null : open}>
      {children}
      <FileViewer
        taskId={taskId}
        path={path}
        onClose={() => setPath(null)}
        onOpen={open}
        onReveal={onReveal}
      />
    </WorktreeFileContext.Provider>
  )
}
