import { useEffect, useMemo, useRef } from "react"

import { Dismiss, Search } from "@/components/icons"
import { Button, Eyebrow, StateDot } from "@/components/primitives"
import { useTaskSearch } from "@/hooks/queries"
import { snippetParts } from "@/lib/find"
import type { ProjectGroup } from "@/lib/projects"
import { useDaemonRuntime } from "@/lib/runtime"
import type { ApiTask, SearchSnippet, SearchTaskHit } from "@/lib/types"
import { uiIntentsFor } from "@/lib/ui-intents"
import { cn } from "@/lib/utils"

/**
 * Search across the projects, in the pane that already lists them.
 *
 * Two things this deliberately is NOT. It is not a command palette: a palette
 * floats over the app and takes it away from you, and the question here —
 * "which task said this" — is answered by the sidebar's own tree, in place,
 * with the tasks still where they were. And it is not a filtered task list:
 * a 26px row cannot say WHY it matched, so a result is two lines, the second
 * one being the daemon's snippet with the hit lit. Same argument as
 * `TaskRowTouch` — the anatomy genuinely differs, so it is its own row rather
 * than a prop on the one that carries the tree.
 *
 * Picking a result selects the task AND seeds find-in-task with the same
 * query, so one search is one gesture: type it once, land on the words.
 */

const SCOPE_NOTE =
  "Exact text in task titles, prompts, results and queued messages. Archived tasks are not searched."

/** What the daemon matched, in the fewest words that are still true. */
const WHERE: Record<SearchSnippet["kind"], string> = {
  title: "title",
  prompt: "prompt",
  result: "result",
  message: "queued",
}

export function ProjectSearchInput({
  query,
  focusToken,
  onQueryChange,
  onClose,
  onCommit,
  onMove,
  touch = false,
}: {
  query: string
  focusToken: number
  onQueryChange: (query: string) => void
  onClose: () => void
  /** Enter — open whatever the list has highlighted */
  onCommit: () => void
  /** ↓/↑ — walk the results without leaving the box */
  onMove: (delta: number) => void
  touch?: boolean
}) {
  const input = useRef<HTMLInputElement | null>(null)
  useEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [focusToken])

  return (
    <div className={cn("flex shrink-0 items-center gap-1.5 pr-2 pl-3.5", touch ? "h-12" : "h-8")}>
      <Search aria-hidden className="size-3.5 shrink-0 text-faint" />
      <input
        ref={input}
        type="text"
        value={query}
        spellCheck={false}
        autoComplete="off"
        placeholder="Search tasks"
        aria-label="Search tasks"
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault()
            onClose()
          } else if (event.key === "Enter") {
            event.preventDefault()
            onCommit()
          } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault()
            onMove(event.key === "ArrowDown" ? 1 : -1)
          }
        }}
        className={cn(
          "min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-faint",
          touch ? "h-9 text-[13px]" : "h-[22px] text-[12.5px]",
        )}
      />
      {/* 44px hit box on touch (§6b); the shared `lg` control is 32 */}
      <Button
        size={touch ? "lg" : "sm"}
        icon
        className={touch ? "size-11" : undefined}
        aria-label="Close search"
        onClick={onClose}
      >
        <Dismiss />
      </Button>
    </div>
  )
}

export function ProjectSearchResults({
  query,
  groups,
  selectedId,
  activeId,
  onSelect,
  onHitsChange,
  touch = false,
}: {
  /** the DEBOUNCED query — what these results are an answer to */
  query: string
  groups: ProjectGroup[]
  selectedId: string | null
  /** the keyboard's cursor, which is not the app's selection */
  activeId: string | null
  onSelect: (id: string) => void
  onHitsChange: (hits: SearchTaskHit[]) => void
  touch?: boolean
}) {
  const runtime = useDaemonRuntime()
  // `query` is already the settled one (useProjectSearch owns the debounce),
  // and the previous answer stays on screen while the next is in flight
  // (queries.ts), so the list narrows instead of blinking.
  const search = useTaskSearch(query)
  const hits = useMemo(() => search.data?.tasks ?? [], [search.data])

  useEffect(() => {
    onHitsChange(hits)
  }, [hits, onHitsChange])

  const byProject = useMemo(() => {
    const index = new Map(hits.map((hit) => [hit.id, hit]))
    return groups
      .map((group) => ({
        group,
        rows: group.tasks
          .map((task) => ({ task, hit: index.get(task.id) }))
          .filter((row): row is { task: ApiTask; hit: SearchTaskHit } => row.hit !== undefined),
      }))
      .filter((entry) => entry.rows.length > 0)
  }, [groups, hits])

  const total = hits.reduce((sum, hit) => sum + hit.matches, 0)

  if (search.isPending) return <Note>Searching…</Note>
  if (search.error instanceof Error) {
    return <div className="px-2.5 py-2 text-[11.5px] text-destructive">search: {search.error.message}</div>
  }
  if (byProject.length === 0) {
    return (
      <div className="flex flex-col gap-1.5 px-2.5 py-2">
        <span className="text-[11.5px] text-muted-foreground">No match in your live tasks.</span>
        <span className="text-[10.5px] leading-relaxed text-faint">{SCOPE_NOTE}</span>
      </div>
    )
  }

  return (
    <div className="flex flex-col">
      <div className="px-2.5 pt-1 pb-1.5 text-[10.5px] text-faint">
        {total} {total === 1 ? "match" : "matches"} in {hits.length} {hits.length === 1 ? "task" : "tasks"}
        {search.data?.truncated && " · showing the most recent"}
      </div>
      {byProject.map(({ group, rows }) => (
        <section key={group.path} className="mt-1.5 first:mt-0">
          <div className="flex h-6 items-center px-2">
            <Eyebrow>{group.name}</Eyebrow>
          </div>
          <div className="mt-px flex flex-col gap-px pl-0.5">
            {rows.map(({ task, hit }) => (
              <SearchResultRow
                key={task.id}
                task={task}
                hit={hit}
                selected={task.id === selectedId}
                active={task.id === activeId}
                touch={touch}
                onSelect={() => {
                  onSelect(task.id)
                  // one gesture: the transcript opens already looking for it
                  uiIntentsFor(runtime.connectionId).openFind(query)
                }}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}

function Note({ children }: { children: string }) {
  return <div className="px-2.5 py-1.5 text-[11.5px] text-faint">{children}</div>
}

/**
 * Two lines: what the task is, then what it said. The match count sits on the
 * right of the first line only when there is more than one — a `1` beside
 * every row is not a fact anybody wanted (§5b).
 */
function SearchResultRow({
  task,
  hit,
  selected,
  active,
  onSelect,
  touch,
}: {
  task: ApiTask
  hit: SearchTaskHit
  selected: boolean
  active: boolean
  onSelect: () => void
  touch: boolean
}) {
  const snippet = hit.snippets[0]
  return (
    <button
      type="button"
      onClick={onSelect}
      data-search-result={task.id}
      aria-current={active ? "true" : undefined}
      className={cn(
        "flex w-full flex-col gap-0.5 rounded-md px-2 text-left transition-colors",
        touch ? "min-h-[44px] py-2" : "py-1.5",
        selected ? "bg-accent" : active ? "bg-hover" : "hover:bg-hover",
      )}
    >
      <span className="flex min-w-0 items-center gap-2">
        <StateDot state={task.state} background={task.background} />
        <span className={cn("min-w-0 flex-1 truncate", touch ? "text-[13px]" : "text-[12.5px]")}>{task.title}</span>
        {hit.matches > 1 && (
          <span className="shrink-0 font-mono text-[10.5px] text-faint">{hit.matches}</span>
        )}
      </span>
      {snippet && (
        <span className="flex min-w-0 items-baseline gap-1.5 pl-3.5">
          <span className="shrink-0 text-[10.5px] text-faint">
            {WHERE[snippet.kind]}
            {snippet.turn !== null && ` ${snippet.turn}`}
          </span>
          <Snippet snippet={snippet} />
        </span>
      )}
    </button>
  )
}

/** The daemon located the match, so nothing here searches the string again. */
function Snippet({ snippet }: { snippet: SearchSnippet }) {
  const { before, match, after } = snippetParts(snippet.text, snippet.offset, snippet.length)
  return (
    <span className="min-w-0 truncate text-[11px] text-muted-foreground">
      {before}
      <span className="bg-find-match text-foreground">{match}</span>
      {after}
    </span>
  )
}

/**
 * Gallery specimen (`#/gallery`). The rows only — the live results component
 * asks the daemon, and a gallery entry never does.
 */
export function ProjectSearchSpecimen({
  tasks,
  hits,
  projectName,
}: {
  tasks: ApiTask[]
  hits: SearchTaskHit[]
  projectName: string
}) {
  return (
    // the REAL pane width, so the entry shows what truncates and what does not
    <div className="w-[268px] rounded-lg border border-border bg-sidebar p-1.5">
      <ProjectSearchInput
        query="vacuum"
        focusToken={0}
        onQueryChange={() => {}}
        onClose={() => {}}
        onCommit={() => {}}
        onMove={() => {}}
      />
      <div className="px-2.5 pt-1 pb-1.5 text-[10.5px] text-faint">
        {hits.reduce((sum, hit) => sum + hit.matches, 0)} matches in {hits.length} tasks
      </div>
      <div className="flex h-6 items-center px-2">
        <Eyebrow>{projectName}</Eyebrow>
      </div>
      <div className="mt-px flex flex-col gap-px pl-0.5">
        {hits.map((hit, index) => {
          const task = tasks.find((candidate) => candidate.id === hit.id)
          return (
            task && (
              <SearchResultRow
                key={hit.id}
                task={task}
                hit={hit}
                selected={index === 0}
                active={index === 1}
                touch={false}
                onSelect={() => {}}
              />
            )
          )
        })}
      </div>
    </div>
  )
}
