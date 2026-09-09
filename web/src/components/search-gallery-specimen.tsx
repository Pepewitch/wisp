import { Eyebrow } from "@/components/primitives"
import { FindBarSpecimen } from "@/components/find-in-task"
import { SEARCH_HITS } from "@/components/gallery-fixtures"
import { ProjectSearchSpecimen } from "@/components/project-search"
import { REPOS } from "@/lib/fixtures"

/**
 * The gallery's search entry (`#/gallery`) — the law rendered on the real
 * components. Its own file because gallery.tsx sits at the file-size budget,
 * the same reason the update and pull-request specimens live outside it.
 */
export function SearchSpecimens() {
  return (
    <div className="grid grid-cols-2 gap-10">
      <div>
        <Eyebrow>⌘F · in the task you are reading</Eyebrow>
        <div className="mt-2.5 rounded-lg border border-border bg-background">
          <FindBarSpecimen />
        </div>
        <Eyebrow className="mt-5 block">
          …and when the answer is elsewhere
        </Eyebrow>
        <div className="mt-2.5 rounded-lg border border-border bg-background">
          <FindBarSpecimen
            query="worktree"
            count={0}
            position=""
            collapsed={3}
          />
        </div>
        <p className="mt-2.5 text-[11.5px] leading-relaxed text-muted-foreground">
          A bar over the reading column, never a dialog: you are narrowing the
          thing you are looking at, and a modal would cover it. It searches the
          transcript that is RENDERED, so it grows as you open a turn's activity
          — and when it finds nothing it says which turns it could not see
          instead of implying they were empty. Matches are painted as ranges
          (::highlight), so nothing in the tree moves and a live turn keeps
          appending underneath.
        </p>
      </div>
      <div>
        <Eyebrow>⌘⇧F · across every task</Eyebrow>
        <div className="mt-2.5">
          <ProjectSearchSpecimen
            hits={SEARCH_HITS}
            repos={REPOS}
            showArchived
          />
        </div>
        <p className="mt-2.5 text-[11.5px] leading-relaxed text-muted-foreground">
          The box pushes the tree down inside the pane that already lists the
          projects — the projects are the context for the answer, so this is not
          a palette floating over the app. A result is TWO lines because a 26px
          row cannot say why it matched: the task, then the daemon's own snippet
          with the hit lit and the field that answered (
          <span className="font-mono">prompt 2</span>,{" "}
          <span className="font-mono">result 1</span>,{" "}
          <span className="font-mono">queued</span>). The match count appears
          only above one, and picking a row is one gesture: the task opens with
          ⌘F already looking for the same words. Archived tasks are searched too
          and land in their own section under the live ones — but only while the
          footer&apos;s <span className="text-fg-secondary">Show archived</span>{" "}
          switch is on. With it off the rows are held back and COUNTED (
          <span className="text-fg-secondary">· 1 archived task hidden</span>),
          because &ldquo;no match&rdquo; and &ldquo;no match I am willing to
          show you&rdquo; are different sentences. Per-turn tool activity stays
          outside the scope, and the empty state says so rather than letting you
          conclude the text is nowhere.
        </p>
      </div>
    </div>
  )
}
