import { useState, type ReactNode } from "react"

import { Refresh } from "@/components/icons"
import { Button, DiffStat, PaneHeader } from "@/components/primitives"
import { useDiff, type DiffData } from "@/hooks/queries"
import { changedFileCount, hunkGaps, hunkSection, parseDiff, type DiffFile, type DiffLine } from "@/lib/diff"
import { cn, oneLine } from "@/lib/utils"
import { useWorktreeFileOpener } from "@/lib/worktree-files"

/**
 * File list first (skills/wisp-dev/references/frontend.md §7): one row per changed file, directory
 * muted and basename lit, the +adds/−dels pair the only thing on the right
 * edge. A full-branch wall of diff is never the entry point.
 *
 * "Changes" keeps a tab's shape because it now HAS a sibling: the right
 * column's strip is Changes · Workflows, and `header` is where that strip
 * arrives. Without one the pane draws its own label, which is what an older
 * daemon with no workflow support still sees — a label, no underline, no hue.
 */
export function ChangesPane({
  taskId,
  archived,
  onRefresh,
  header,
  hidden = false,
  touch = false,
}: {
  taskId: string | null
  archived: boolean
  onRefresh?: () => void
  /** the right column's tab strip, in place of this pane's own label */
  header?: ReactNode
  /** kept mounted while another tab is shown, so the open diff survives */
  hidden?: boolean
  touch?: boolean
}) {
  const query = useDiff(taskId, archived)
  const [selected, setSelected] = useState<string | null>(null)

  // a task switch must not leave the previous task's file selected. Adjusted
  // during render, not in an effect: this way the new task never paints once
  // holding the old task's selection.
  const [seenTask, setSeenTask] = useState(taskId)
  if (seenTask !== taskId) {
    setSeenTask(taskId)
    setSelected(null)
  }

  return (
    // h-full AND flex-1: this root has to fill a resizable panel (which sets a
    // height) as well as a flex column (which does not) — CONVENTIONS §6b.
    // With flex-1 alone the panel does not constrain it, so the file list grows
    // to its content and spills past the divider instead of scrolling.
    <div className={cn("h-full min-h-0 flex-1 flex-col", hidden ? "hidden" : "flex")} aria-hidden={hidden || undefined}>
      <Header
        count={counted(query.data)}
        onRefresh={onRefresh}
        disabled={taskId === null || archived}
        header={header}
        touch={touch}
      />
      <Body
        taskId={taskId}
        archived={archived}
        data={query.data}
        error={query.error}
        loading={query.isPending}
        selected={selected}
        onSelect={setSelected}
      />
    </div>
  )
}

function counted(data: DiffData | undefined): number | null {
  if (!data || data.kind !== "ok") return null
  return changedFileCount(parseDiff(data.diff).files, data.untracked)
}

function Header({
  count,
  onRefresh,
  disabled,
  header,
  touch,
}: {
  count: number | null
  onRefresh?: () => void
  disabled: boolean
  header?: ReactNode
  touch?: boolean
}) {
  return (
    <PaneHeader touch={touch} className={header ? "pl-2" : undefined}>
      {header ?? (
        <>
          <span className="text-[12.5px] font-medium text-foreground">Changes</span>
          {count !== null && <span className="font-mono text-[10.5px] text-muted-foreground">{count}</span>}
        </>
      )}
      <span className="flex-1" />
      <Button size={touch ? "touch" : "sm"} icon aria-label="Refresh diff" onClick={onRefresh} disabled={disabled}>
        <Refresh />
      </Button>
    </PaneHeader>
  )
}

/** Expected states are muted notes; only a real failure gets the destructive hue. */
function Note({ children, error }: { children: React.ReactNode; error?: boolean }) {
  return (
    <div className={cn("px-3.5 py-3 text-[12px]", error ? "text-destructive" : "text-faint")}>{children}</div>
  )
}

function Body({
  taskId,
  archived,
  data,
  error,
  loading,
  selected,
  onSelect,
}: {
  taskId: string | null
  archived: boolean
  data: DiffData | undefined
  error: unknown
  loading: boolean
  selected: string | null
  onSelect: (path: string | null) => void
}) {
  // a hook, so it sits above the early returns; null without a provider, and
  // the early-return states render no rows that could ask for it anyway
  const openFile = useWorktreeFileOpener()
  if (taskId === null) return <Note>No task selected</Note>
  if (archived) return <Note>Diff viewing is unavailable for archived tasks.</Note>
  // oneLine() on both: the daemon already sanitizes git's stderr, and the pane
  // caps what it renders REGARDLESS, so no future git failure can put a manpage
  // in this pane again (D1)
  if (error instanceof Error) return <Note error>{oneLine(error.message)}</Note>
  if (loading || !data) return <Note>Reading the worktree…</Note>
  // an unreadable worktree is the same register as an archived one: one muted
  // line saying why there is nothing here
  if (data.kind === "unavailable") return <Note>{oneLine(data.message)}</Note>

  const parsed = parseDiff(data.diff)
  const filesByPath = new Map(parsed.files.map((candidate) => [candidate.path, candidate]))
  const untrackedNames = new Set(data.untracked)
  const tracked = parsed.files.filter((f) => !untrackedNames.has(f.path))
  const total = changedFileCount(parsed.files, data.untracked)
  if (total === 0) return <Note>No changes in this worktree yet</Note>

  const file = selected === null ? null : filesByPath.get(selected) ?? null
  const selectedUntracked = selected !== null && untrackedNames.has(selected)
  const lastFile = parsed.files.at(-1)

  // A click reads the diff; a double-click reads the file itself, in the same
  // viewer a path in prose opens. Absent without a provider (the gallery, an
  // archived task) the gesture is simply not there.
  return (
    <>
      <div className="scroll-slim min-h-0 flex-1 overflow-y-auto px-2 py-1.5">
        {tracked.map((f) => (
          <FileRow
            key={f.path}
            file={f}
            selected={f.path === selected}
            onSelect={() => onSelect(f.path)}
            onOpen={openFile
              ? () => openFile(f.path, { diff: f, diffTruncated: data.truncated && f === lastFile })
              : undefined}
          />
        ))}
        {data.untracked.map((path) => (
          <UntrackedRow
            key={path}
            path={path}
            selected={path === selected}
            onSelect={() => onSelect(path)}
            onOpen={openFile ? () => {
              const diff = filesByPath.get(path)
              openFile(path, { diff, diffTruncated: data.truncated && diff === lastFile })
            } : undefined}
          />
        ))}
        {file && <FileDiff file={file} />}
        {selectedUntracked && !file && (
          <EmptyDiff>Untracked file — nothing to show</EmptyDiff>
        )}
        {data.truncated && <Note>The diff was truncated by the daemon — run `git diff` in the worktree for all of it</Note>}
      </div>

      <div className="flex h-[30px] shrink-0 items-center gap-2 px-3.5 text-[10.5px] text-faint">
        <span>
          {total} file{total === 1 ? "" : "s"}
        </span>
        <span>·</span>
        <DiffStat adds={parsed.adds} dels={parsed.dels} />
        <span className="flex-1" />
        {/* the base the DAEMON diffed from, never the task's creation commit —
            they differ the moment a branch is checked out into the worktree */}
        {data.base && <span className="font-mono">base {data.base.slice(0, 7)}</span>}
      </div>
    </>
  )
}

function Row({
  onSelect,
  onOpen,
  selected,
  dir,
  base,
  children,
}: {
  onSelect?: () => void
  /** Double-click: the whole file in the viewer, not just its diff. */
  onOpen?: () => void
  selected?: boolean
  dir: string | null
  base: string
  children?: React.ReactNode
}) {
  return (
    <button
      type="button"
      data-diff-file={`${dir ?? ""}${base}`}
      onClick={onSelect}
      onDoubleClick={onOpen}
      className={cn(
        "flex h-7 w-full items-center gap-2 rounded-md px-2 text-left transition-colors",
        selected ? "bg-accent" : "hover:bg-hover",
      )}
    >
      <span className="min-w-0 flex-1 truncate font-mono text-[11.5px]">
        {dir && <span className="text-muted-foreground">{dir}</span>}
        <span className={selected ? "text-foreground" : "text-fg-secondary"}>{base}</span>
      </span>
      {children}
    </button>
  )
}

function split(path: string): { dir: string | null; base: string } {
  const i = path.lastIndexOf("/")
  return i === -1 ? { dir: null, base: path } : { dir: path.slice(0, i + 1), base: path.slice(i + 1) }
}

function FileRow({
  file,
  selected,
  onSelect,
  onOpen,
}: {
  file: DiffFile
  selected: boolean
  onSelect: () => void
  onOpen?: () => void
}) {
  const { dir, base } = split(file.path)
  const note = file.isBinary ? "binary" : file.isNew ? "new" : file.isDeleted ? "deleted" : undefined
  return (
    <Row dir={dir} base={base} selected={selected} onSelect={onSelect} onOpen={onOpen}>
      <DiffStat adds={file.adds} dels={file.dels} note={note} />
    </Row>
  )
}

function UntrackedRow({
  path,
  selected,
  onSelect,
  onOpen,
}: {
  path: string
  selected: boolean
  onSelect: () => void
  onOpen?: () => void
}) {
  const { dir, base } = split(path)
  return (
    <Row dir={dir} base={base} selected={selected} onSelect={onSelect} onOpen={onOpen}>
      <span className="shrink-0 font-mono text-[10.5px] text-faint">untracked</span>
    </Row>
  )
}

function EmptyDiff({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-2.5 rounded-lg border border-border bg-background px-3 py-5 text-center text-[11.5px] text-faint">
      {children}
    </div>
  )
}

/** The selected file: hunk headers, numbered gutters, 10% tints, collapsed gaps. */
function FileDiff({ file }: { file: DiffFile }) {
  if (file.isBinary) return <EmptyDiff>Binary file — nothing to show</EmptyDiff>
  if (file.hunks.length === 0) return <EmptyDiff>Empty file — nothing to show</EmptyDiff>
  const gaps = hunkGaps(file)
  return (
    <div className="mt-2.5 overflow-hidden rounded-lg border border-border bg-background font-mono text-[11px] leading-[1.8]">
      {file.hunks.map((hunk, h) => (
        <div key={h}>
          {gaps[h] !== undefined && gaps[h]! > 0 && (
            <div data-diff-gap className="bg-card py-0.5 pl-[78px] text-[10.5px] text-faint select-none">
              {gaps[h]} unmodified lines
            </div>
          )}
          <div className="flex bg-card">
            <Gutter />
            <Gutter />
            <span className="min-w-0 flex-1 truncate pr-3 text-faint">{hunkSection(hunk) ?? "@@"}</span>
          </div>
          {hunk.lines.map((line, i) => (
            <DiffRow key={i} line={line} />
          ))}
        </div>
      ))}
    </div>
  )
}

function DiffRow({ line }: { line: DiffLine }) {
  return (
    <div
      className={cn(
        "flex",
        line.kind === "add" && "bg-diff-add-bg",
        line.kind === "del" && "bg-diff-del-bg",
      )}
    >
      <Gutter n={line.oldNo} />
      <Gutter n={line.newNo} />
      <span
        className={cn(
          "min-w-0 flex-1 pr-3 break-words whitespace-pre-wrap",
          line.kind === "add" && "text-diff-add",
          line.kind === "del" && "text-diff-del",
          line.kind === "context" && "text-muted-foreground",
        )}
      >
        {line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "}
        {line.text}
      </span>
    </div>
  )
}

function Gutter({ n }: { n?: number | null }) {
  return <span className="w-[34px] shrink-0 pr-2 text-right text-faint select-none">{n ?? ""}</span>
}
