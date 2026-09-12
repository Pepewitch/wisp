import { Dialog } from "@base-ui/react/dialog"
import { memo, useCallback, useState, type ReactNode } from "react"

import { Prose } from "@/components/prose"
import { Tab } from "@/components/primitives"
import { formatBytes } from "@/lib/attachments"
import { fullFileDiff, type DiffFile, type FullFileDiffLine } from "@/lib/diff"
import { failureReason } from "@/lib/web-transport"
import { useWorktreeFile } from "@/hooks/queries"
import { cn } from "@/lib/utils"
import {
  resolveAgainst,
  WorktreeFileContext,
  type WorktreeFileOpenOptions,
} from "@/lib/worktree-files"
import { PROSE_HIGHLIGHT_LIMIT } from "@/lib/prose-highlight"
import type { WorktreeFileResponse } from "@/lib/types"

/** Rich Markdown creates an AST; larger documents stay one bounded text node. */
const DOCUMENT_PREVIEW_LIMIT = 100_000

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
 * code surface — a `.ts` is meant to be read as what it is. An extension that
 * names a language prose can highlight reads as source WITH colour: the bytes
 * are the same bytes, just wearing the `--syntax-*` palette a code fence in a
 * transcript already wears.
 *
 * Fully controlled, like the image viewer: `path` lives with whoever opened it.
 */
export function FileViewer({
  taskId,
  path,
  onClose,
  onOpen,
  onReveal,
  diff,
  diffTruncated = false,
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
  /** Present when Changes opened the file, enabling the full-file diff view. */
  diff?: DiffFile
  diffTruncated?: boolean
}) {
  const [mode, setMode] = useState<"file" | "diff">("file")
  const [seenPath, setSeenPath] = useState(path)
  if (seenPath !== path) {
    setSeenPath(path)
    setMode("file")
  }
  const open = taskId !== null && path !== null
  const query = useWorktreeFile(open ? taskId : null, open ? path : null)
  const file = query.data
  const canDiff = diff !== undefined && !diff.isBinary && !diff.isDeleted
  const effectiveMode = mode === "diff" && canDiff ? "diff" : "file"

  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-(--z-backdrop) bg-scrim" />
        <Dialog.Popup
          data-testid="file-viewer"
          className="fixed top-1/2 left-1/2 z-(--z-modal) flex max-h-[80vh] w-[80vw] -translate-x-1/2 -translate-y-1/2 flex-col gap-2 outline-none"
        >
          <Dialog.Title className="sr-only">{file?.path ?? path ?? "File"}</Dialog.Title>
          {canDiff && (
            <div role="tablist" aria-label="File view" className="flex shrink-0 items-center gap-0.5">
              <Tab role="tab" aria-selected={effectiveMode === "file"} active={effectiveMode === "file"} onClick={() => setMode("file")}>
                File
              </Tab>
              <Tab role="tab" aria-selected={effectiveMode === "diff"} active={effectiveMode === "diff"} onClick={() => setMode("diff")}>
                Diff
              </Tab>
            </div>
          )}
          <div className="scroll-slim min-h-0 flex-1 overflow-auto rounded-md border border-border bg-code px-4 py-3">
            <ViewerContent
              pending={query.isPending}
              error={query.isError ? query.error : null}
              file={file}
              mode={effectiveMode}
              diff={diff}
              diffTruncated={diffTruncated}
              onOpen={onOpen}
            />
          </div>
          <ViewerFooter
            path={file?.path ?? path}
            file={file}
            mode={effectiveMode}
            diffTruncated={diffTruncated}
            onReveal={onReveal}
          />
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function ViewerContent({
  pending,
  error,
  file,
  mode,
  diff,
  diffTruncated,
  onOpen,
}: {
  pending: boolean
  error: unknown
  file: WorktreeFileResponse | undefined
  mode: "file" | "diff"
  diff?: DiffFile
  diffTruncated: boolean
  onOpen?: (path: string) => void
}) {
  if (pending) return <p className="font-mono text-[11px] text-faint">reading…</p>
  if (error) return <p className="font-mono text-[11px] text-faint">{failureReason(error)}</p>
  if (!file) return null
  if (file.kind === "binary") {
    return (
      <p className="font-mono text-[11px] text-faint">
        {formatBytes(file.bytes)} of binary — nothing to read here.
      </p>
    )
  }
  if (mode === "diff" && diff) {
    return <FullFileDiff file={diff} text={file.text} patchTruncated={diffTruncated} />
  }
  if (!isMarkdown(file.path) || file.text.length > DOCUMENT_PREVIEW_LIMIT) {
    return <SourceFile path={file.path} text={file.text} />
  }
  /**
   * A document's own relative links mean "next to me", not "at the top of the
   * worktree", so nested prose resolves against this file's directory.
   */
  return (
    <WorktreeFileContext.Provider value={(next) => onOpen?.(resolveAgainst(file.path, next))}>
      <Prose text={file.text} />
    </WorktreeFileContext.Provider>
  )
}

function ViewerFooter({
  path,
  file,
  mode,
  diffTruncated,
  onReveal,
}: {
  path: string | null
  file: WorktreeFileResponse | undefined
  mode: "file" | "diff"
  diffTruncated: boolean
  onReveal?: (path: string) => void
}) {
  const highlightingSkipped = file?.kind === "text"
    && mode === "file"
    && sourceLanguage(file.path) !== null
    && file.text.length > PROSE_HIGHLIGHT_LIMIT
  const documentPreviewSkipped = file?.kind === "text"
    && mode === "file"
    && isMarkdown(file.path)
    && file.text.length > DOCUMENT_PREVIEW_LIMIT
  return (
    <div className="flex shrink-0 items-center gap-2 text-[11.5px] text-muted-foreground">
      <span data-testid="file-viewer-path" className="truncate font-mono">{path}</span>
      {file && (
        <>
          <span className="shrink-0 text-faint">·</span>
          <span className="shrink-0">{formatBytes(file.bytes)}</span>
        </>
      )}
      {file?.kind === "text" && file.truncated && (
        <span className="shrink-0 text-faint">· preview capped</span>
      )}
      {highlightingSkipped && (
        <span className="shrink-0 text-faint">· highlighting off for performance</span>
      )}
      {documentPreviewSkipped && (
        <span className="shrink-0 text-faint">· preview off for performance</span>
      )}
      {mode === "diff" && diffTruncated && (
        <span className="shrink-0 text-faint">· diff capped; unmarked lines may have changes</span>
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
  )
}

/** Editor-style inline diff: every current line stays visible; changed rows are inserted in place. */
const FullFileDiff = memo(function FullFileDiff({
  file,
  text,
  patchTruncated,
}: {
  file: DiffFile
  text: string
  patchTruncated: boolean
}) {
  const result = fullFileDiff(file, text, patchTruncated)
  if (result.lines.length === 0) {
    return <p className="font-mono text-[11px] text-faint">Empty file — nothing to show</p>
  }
  return (
    <div className="-mx-4 -my-3 font-mono text-[11.5px] leading-[1.75]">
      {result.lines.map((line, index) => (
        <FullFileDiffRow key={`${line.oldNo ?? ""}:${line.newNo ?? ""}:${index}`} line={line} />
      ))}
      {result.capped && (
        <p className="px-4 py-2 text-faint">
          Diff display stopped at {result.lines.length.toLocaleString()} lines for performance.
        </p>
      )}
    </div>
  )
})

function FullFileDiffRow({ line }: { line: FullFileDiffLine }) {
  return (
    <div
      data-diff-line={line.kind}
      data-diff-known={line.known || undefined}
      className={cn(
        "flex min-w-max",
        line.kind === "add" && "bg-diff-add-bg",
        line.kind === "del" && "bg-diff-del-bg",
      )}
    >
      <span className="w-[54px] shrink-0 pr-3 text-right text-faint select-none">
        {line.newNo ?? line.oldNo ?? ""}
      </span>
      <span
        aria-hidden="true"
        className={cn(
          "w-5 shrink-0 select-none",
          line.kind === "add" && "text-diff-add",
          line.kind === "del" && "text-diff-del",
          !line.known && "text-faint",
        )}
      >
        {line.kind === "add" ? "+" : line.kind === "del" ? "−" : !line.known ? "?" : " "}
      </span>
      <span
        className={cn(
          "min-w-0 flex-1 pr-4 whitespace-pre",
          line.kind === "add" && "text-diff-add",
          line.kind === "del" && "text-diff-del",
          line.kind === "context" && "text-foreground/85",
        )}
      >
        {line.text || " "}
      </span>
    </div>
  )
}

/** Rendered as a document, not as source. Extensions only — this is presentation. */
function isMarkdown(path: string): boolean {
  return /\.(?:md|markdown|mdx)$/i.test(path)
}

/**
 * A source file: the bytes verbatim, highlighted when the extension names a
 * language the prose highlighter knows.
 *
 * The highlighting IS prose's: the file goes through `Prose` as one fenced
 * block, so `rehype-highlight` colours it with the same `--syntax-*` tokens a
 * fence in a transcript gets, and the same 20 KB ceiling (prose-highlight.ts)
 * drops a huge file back to plain mono instead of stalling the popup. The
 * fence is one backtick longer than the file's own longest run, so nothing in
 * the file can close it early and leak out as markdown.
 *
 * The fence's own card comes off (`[&_pre]` overrides): this surface is the
 * viewer's, and a card inside it would read as a document, which a source
 * file is not. What survives is exactly the colour.
 *
 * An extension the map does not know — `.txt`, `.log`, `.env` — keeps the
 * plain pre it always had: guessing at a language is the thing
 * `detect: false` exists to refuse.
 */
function SourceFile({ path, text }: { path: string; text: string }) {
  const language = sourceLanguage(path)
  if (language === null) {
    return (
      <pre className="font-mono text-[11.5px] leading-[1.75] whitespace-pre-wrap text-foreground/85">
        {text}
      </pre>
    )
  }
  let longest = 0
  for (const run of text.matchAll(/`+/g)) longest = Math.max(longest, run[0].length)
  const fence = "`".repeat(Math.max(3, longest + 1))
  return (
    <Prose
      text={`${fence}${language}\n${text}\n${fence}`}
      className="[&_pre]:mt-0 [&_pre]:overflow-visible [&_pre]:rounded-none [&_pre]:border-0 [&_pre]:bg-transparent [&_pre]:p-0"
    />
  )
}

/**
 * Extension → a language lowlight's `common` set registers. An entry is a
 * promise the colour will come out; an extension NOT here renders plain,
 * never guessed (the same rule an unlabelled fence already lives by).
 */
const SOURCE_LANGUAGES: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  css: "css",
  html: "xml",
  xml: "xml",
  svg: "xml",
  py: "python",
  rb: "ruby",
  rs: "rust",
  go: "go",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  c: "c",
  h: "c",
  cpp: "cpp",
  hpp: "cpp",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  yml: "yaml",
  yaml: "yaml",
  toml: "ini",
  ini: "ini",
  sql: "sql",
  diff: "diff",
}

function sourceLanguage(path: string): string | null {
  const name = path.slice(path.lastIndexOf("/") + 1)
  const dot = name.lastIndexOf(".")
  if (dot <= 0) return null // extensionless, or a dotfile like `.env`
  return SOURCE_LANGUAGES[name.slice(dot + 1).toLowerCase()] ?? null
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
  const [opened, setOpened] = useState<{ path: string; options?: WorktreeFileOpenOptions } | null>(null)
  // Identity-stable so a transcript of prose is not re-rendered per keystroke
  // elsewhere; the viewer is keyed by `path`, not by this.
  const open = useCallback((next: string, options?: WorktreeFileOpenOptions) => {
    setOpened({ path: next, options })
  }, [])

  return (
    <WorktreeFileContext.Provider value={taskId === null ? null : open}>
      {children}
      <FileViewer
        taskId={taskId}
        path={opened?.path ?? null}
        onClose={() => setOpened(null)}
        onOpen={open}
        onReveal={onReveal}
        diff={opened?.options?.diff}
        diffTruncated={opened?.options?.diffTruncated}
      />
    </WorktreeFileContext.Provider>
  )
}
