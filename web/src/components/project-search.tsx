import { useEffect, useMemo, useRef } from "react"

import { Dismiss, Search } from "@/components/icons"
import { Button, Eyebrow, StateDot } from "@/components/primitives"
import { useRepos, useTaskSearch } from "@/hooks/queries"
import { snippetParts } from "@/lib/find"
import { pathBasename } from "@/lib/projects"
import { useDaemonRuntime } from "@/lib/runtime"
import {
  displaySnippet,
  layoutSearchHits,
  type SearchLayout,
  type SearchSection,
} from "@/lib/search-sections"
import type { RepoInfo, SearchSnippet, SearchTaskHit } from "@/lib/types"
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
  "Exact text in titles, prompts, results, queued messages, and what the agent said. Tool calls and reasoning are not searched."

/**
 * What the daemon matched, in the fewest words that are still true. `said` is
 * the agent's prose from inside the turn, which is not the same fact as
 * `result` — that one is how the turn concluded.
 */
const WHERE: Record<SearchSnippet["kind"], string> = {
  title: "title",
  prompt: "prompt",
  result: "result",
  message: "queued",
  prose: "said",
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
    <div
      className={cn(
        "flex shrink-0 items-center gap-1.5 pr-2 pl-3.5",
        touch ? "h-12" : "h-8"
      )}
    >
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
          touch ? "h-9 text-[13px]" : "h-[22px] text-[12.5px]"
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
  showArchived,
  selectedId,
  activeId,
  onSelect,
  onHitsChange,
  touch = false,
}: {
  /** the DEBOUNCED query — what these results are an answer to */
  query: string
  /** the pane's own switch: archived hits are shown only when it is on */
  showArchived: boolean
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
  const repos = useRepos()
  const hits = useMemo(() => search.data?.tasks ?? [], [search.data])

  useEffect(() => {
    onHitsChange(hits)
  }, [hits, onHitsChange])

  // ONE layout for the render and for ↑/↓ (lib/search-sections.ts)
  const layout = useMemo(
    () => layoutSearchHits(hits, showArchived),
    [hits, showArchived]
  )

  if (search.isPending) return <Note>Searching…</Note>
  if (search.error instanceof Error) {
    return (
      <div className="px-2.5 py-2 text-[11.5px] text-destructive">
        search: {search.error.message}
      </div>
    )
  }
  if (layout.sections.length === 0) {
    return (
      <NoResults
        hiddenArchived={layout.hiddenArchived}
        indexing={search.data?.indexing?.remainingTurns ?? 0}
      />
    )
  }

  return (
    <div className="flex flex-col">
      <ResultsSummary
        layout={layout}
        truncated={search.data?.truncated === true}
        indexing={search.data?.indexing?.remainingTurns ?? 0}
      />
      <SearchSections
        layout={layout}
        repos={repos.data}
        selectedId={selectedId}
        activeId={activeId}
        touch={touch}
        onSelect={(id) => {
          onSelect(id)
          // one gesture: the transcript opens already looking for it
          uiIntentsFor(runtime.connectionId).openFind(query)
        }}
      />
    </div>
  )
}

/** What the answer is, in one muted line — including what it is holding back. */
function ResultsSummary({
  layout,
  truncated,
  indexing,
}: {
  layout: SearchLayout
  truncated: boolean
  indexing: number
}) {
  return (
    <div className="px-2.5 pt-1 pb-1.5 text-[10.5px] leading-relaxed text-faint">
      {layout.matches} {layout.matches === 1 ? "match" : "matches"} in{" "}
      {layout.shown} {layout.shown === 1 ? "task" : "tasks"}
      {/* "no match" and "no match I am willing to show you" are different
          sentences, and only one of them is true while the switch is off */}
      {layout.hiddenArchived > 0 &&
        ` · ${layout.hiddenArchived} archived ${layout.hiddenArchived === 1 ? "task" : "tasks"} hidden`}
      {truncated && " · showing the most recent"}
      <IndexingNote remaining={indexing} />
    </div>
  )
}

/**
 * The daemon is still projecting the prose of turns that ended before the
 * index existed (turn-text-backfill.ts). Said out loud, because during that
 * window an answer is provisional — and a search that has not read half your
 * history must not look like one that has.
 */
function IndexingNote({ remaining }: { remaining: number }) {
  if (remaining === 0) return null
  return (
    <>
      <br />
      still indexing what the agent said in {remaining} older{" "}
      {remaining === 1 ? "turn" : "turns"}
    </>
  )
}

/** The laid-out answer. Shared with the gallery entry, so they cannot drift. */
function SearchSections({
  layout,
  repos,
  selectedId,
  activeId,
  onSelect,
  touch,
}: {
  layout: SearchLayout
  repos: RepoInfo[] | undefined
  selectedId: string | null
  activeId: string | null
  onSelect: (id: string) => void
  touch: boolean
}) {
  return (
    <>
      {layout.sections.map((section) => (
        <ResultSection
          key={section.path ?? "archived"}
          section={section}
          label={sectionLabel(section, repos)}
          selectedId={selectedId}
          activeId={activeId}
          touch={touch}
          onSelect={onSelect}
        />
      ))}
    </>
  )
}

/** A project's configured name, else its basename; the archived pile says so. */
function sectionLabel(
  section: SearchSection,
  repos: RepoInfo[] | undefined
): string {
  if (section.kind === "archived") return "Archived"
  const path = section.path ?? ""
  return repos?.find((repo) => repo.path === path)?.name ?? pathBasename(path)
}

function ResultSection({
  section,
  label,
  selectedId,
  activeId,
  onSelect,
  touch,
}: {
  section: SearchSection
  label: string
  selectedId: string | null
  activeId: string | null
  onSelect: (id: string) => void
  touch: boolean
}) {
  return (
    <section className="mt-1.5 first:mt-0">
      <div className="flex h-6 items-center px-2">
        <Eyebrow>{label}</Eyebrow>
      </div>
      <div className="mt-px flex flex-col gap-px pl-0.5">
        {section.hits.map((hit) => (
          <SearchResultRow
            key={hit.id}
            hit={hit}
            selected={hit.id === selectedId}
            active={hit.id === activeId}
            touch={touch}
            onSelect={() => onSelect(hit.id)}
          />
        ))}
      </div>
    </section>
  )
}

/**
 * Nothing to show — which is two different facts. A miss is a miss; a miss
 * with archived matches behind the switch is a miss plus a way forward.
 */
function NoResults({
  hiddenArchived,
  indexing,
}: {
  hiddenArchived: number
  indexing: number
}) {
  return (
    <div className="flex flex-col gap-1.5 px-2.5 py-2">
      <span className="text-[11.5px] text-muted-foreground">
        {hiddenArchived === 0
          ? "No match in your tasks."
          : "No match in your live tasks."}
      </span>
      {/* A miss while the index is catching up is not a definitive miss. */}
      {indexing > 0 && (
        <span className="text-[10.5px] leading-relaxed text-faint">
          Still indexing what the agent said in {indexing} older{" "}
          {indexing === 1 ? "turn" : "turns"} — try again shortly.
        </span>
      )}
      {hiddenArchived > 0 && (
        <span className="text-[10.5px] leading-relaxed text-faint">
          {hiddenArchived === 1
            ? "One archived task matches"
            : `${hiddenArchived} archived tasks match`}{" "}
          — turn on Show archived to see {hiddenArchived === 1 ? "it" : "them"}.
        </span>
      )}
      <span className="text-[10.5px] leading-relaxed text-faint">
        {SCOPE_NOTE}
      </span>
    </div>
  )
}

function Note({ children }: { children: string }) {
  return (
    <div className="px-2.5 py-1.5 text-[11.5px] text-faint">{children}</div>
  )
}

/**
 * Two lines: what the task is, then what it said. The match count sits on the
 * right of the first line only when there is more than one — a `1` beside
 * every row is not a fact anybody wanted (§5b).
 */
function SearchResultRow({
  hit,
  selected,
  active,
  onSelect,
  touch,
}: {
  hit: SearchTaskHit
  selected: boolean
  active: boolean
  onSelect: () => void
  touch: boolean
}) {
  const snippet = displaySnippet(hit)
  return (
    <button
      type="button"
      onClick={onSelect}
      data-search-result={hit.id}
      aria-current={active ? "true" : undefined}
      className={cn(
        "flex w-full flex-col gap-0.5 rounded-md px-2 text-left transition-colors",
        touch ? "min-h-[44px] py-2" : "py-1.5",
        selected ? "bg-accent" : active ? "bg-hover" : "hover:bg-hover"
      )}
    >
      <span className="flex min-w-0 items-center gap-2">
        <StateDot state={hit.state} />
        <span
          className={cn(
            "min-w-0 flex-1 truncate",
            touch ? "text-[13px]" : "text-[12.5px]"
          )}
        >
          {hit.title}
        </span>
        {hit.matches > 1 && (
          <span className="shrink-0 font-mono text-[10.5px] text-faint">
            {hit.matches}
          </span>
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
  const { before, match, after } = snippetParts(
    snippet.text,
    snippet.offset,
    snippet.length
  )
  return (
    <span className="min-w-0 truncate text-[11px] text-muted-foreground">
      {before}
      <span className="bg-find-match text-foreground">{match}</span>
      {after}
    </span>
  )
}

/**
 * Gallery specimen (`#/gallery`). It renders through the SAME summary line and
 * section list the pane uses, so the entry cannot drift from the surface; only
 * the daemon call is missing, because a gallery entry never makes one.
 */
export function ProjectSearchSpecimen({
  hits,
  repos,
  showArchived,
}: {
  hits: SearchTaskHit[]
  repos: RepoInfo[]
  showArchived: boolean
}) {
  const layout = layoutSearchHits(hits, showArchived)
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
      <ResultsSummary layout={layout} truncated={false} indexing={0} />
      <SearchSections
        layout={layout}
        repos={repos}
        selectedId={hits[0]?.id ?? null}
        activeId={hits[1]?.id ?? null}
        touch={false}
        onSelect={() => {}}
      />
    </div>
  )
}
