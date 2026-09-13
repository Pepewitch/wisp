import { useState, type ReactNode } from "react"

import { ChevronDown, FolderAdd, Gear, Plus, Search } from "@/components/icons"
import { Button, Eyebrow, SwitchTrack } from "@/components/primitives"
import {
  ProjectSearchInput,
  ProjectSearchResults,
} from "@/components/project-search"
import type { ProjectSearch } from "@/hooks/useProjectSearch"
import { TaskRow, TaskRowTouch } from "@/components/task-row"
import type { ProjectGroup } from "@/lib/projects"
import type {
  ApiTask,
  PullRequestOverviewEntry,
  StatusEntry,
} from "@/lib/types"
import { cn } from "@/lib/utils"

/**
 * Registering a project needs an ABSOLUTE path on the daemon host, and a
 * browser cannot produce one: showDirectoryPicker() hands back a folder NAME
 * with no parent, and webkitdirectory yields paths relative to the chosen
 * root. So the browser does not ship a picker — it ships the daemon-side path
 * field a remote desktop tab already used (`AddProjectDialog`), because the
 * alternative was a disabled button and a sentence sending someone to a
 * terminal, which made this pane a dead end from zero. A caller with no add
 * mechanism at all still gets the honest CLI sentence.
 */
const ADD_PROJECT_HINT = "Add a project from the CLI: wisp project add <path>"

interface SidebarProps {
  groups: ProjectGroup[]
  /** Unfinished cleanup is always included; the footer toggle adds completed archives. */
  archivedTasks: ApiTask[]
  status: Record<string, StatusEntry>
  pullRequests: Record<string, PullRequestOverviewEntry>
  selectedId: string | null
  onSelect: (id: string) => void
  showArchived: boolean
  onShowArchivedChange: (value: boolean) => void
  onNewTask: (repoPath: string) => void
  onConfigureProject: (repoPath: string) => void
  /**
   * Opens Wisp's settings. Only the TOUCH footer offers it: the pointer shell
   * has the top bar's gear, and two gears for one modal is one too many. The
   * caller dismisses the drawer in the same commit.
   */
  onOpenSettings?: () => void
  /**
   * Wisp's update surface. Only the TOUCH footer takes it: below `md` there is
   * no persistent top bar to carry app-level state, and the alternative — an
   * idle daemon version in the task header — wrapped onto two lines and took
   * that width from the one string on screen that says which task this is.
   */
  updateControl?: ReactNode
  /**
   * Cross-project search (⌘⇧F). The state lives above this pane so one search
   * survives the drawer/pane split and can be opened from the keyboard; the
   * pane owns only where the box and the results sit.
   */
  search: ProjectSearch
  /** Desktop-only: native picker for Local, daemon path prompt for remotes. */
  onAddProject?: () => void
  addProjectPending?: boolean
  /** a tasks/status fetch failure, shown inline */
  error: string | null
  /**
   * The repair for that failure, chosen by the caller because only it knows
   * which one applies — a stopped local daemon needs setup, anything else
   * needs another try. A red string with no door was the whole bug.
   */
  errorAction?: { label: string; onClick: () => void }
  loading: boolean
  /** touch mode: two-line rows, no hover cards, thumb-sized controls */
  touch?: boolean
}

/**
 * Grouped by project, one line per task. The drag handle is the divider — this
 * pane carries no border toward it.
 */
export function Sidebar({
  groups,
  archivedTasks,
  status,
  pullRequests,
  selectedId,
  onSelect,
  showArchived,
  onShowArchivedChange,
  onNewTask,
  onConfigureProject,
  onOpenSettings,
  search,
  updateControl,
  onAddProject,
  addProjectPending = false,
  error,
  errorAction,
  loading,
  touch = false,
}: SidebarProps) {
  return (
    <aside className="flex h-full min-h-0 flex-col bg-sidebar">
      <SidebarHeader
        search={search}
        onAddProject={onAddProject}
        addProjectPending={addProjectPending}
        touch={touch}
      />

      {/* The box pushes the tree DOWN rather than covering it: the projects
          are the context for the results, and a pane that jumps to a filtered
          list with no visible input has stopped explaining itself. */}
      {search.open && (
        <ProjectSearchInput
          query={search.query}
          focusToken={search.focusToken}
          onQueryChange={search.setQuery}
          onClose={search.close}
          onCommit={() => search.commit(onSelect)}
          onMove={search.move}
          touch={touch}
        />
      )}

      {error && (
        <div className="flex items-start gap-2 px-3.5 pb-1.5 text-[11.5px] text-destructive">
          <span className="min-w-0 flex-1">{error}</span>
          {errorAction && (
            <button
              type="button"
              onClick={errorAction.onClick}
              className={cn(
                "shrink-0 underline underline-offset-2",
                "hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
                touch && "min-h-11"
              )}
            >
              {errorAction.label}
            </button>
          )}
        </div>
      )}

      <div className="min-h-0 flex-1 scroll-slim overflow-y-auto px-1.5 pb-2">
        {search.open && search.query.trim() !== "" ? (
          <ProjectSearchResults
            query={search.daemonQuery}
            showArchived={showArchived}
            selectedId={selectedId}
            activeId={search.activeId}
            onSelect={onSelect}
            onHitsChange={search.setHits}
            touch={touch}
          />
        ) : loading && groups.length === 0 ? (
          <div className="px-2.5 py-1 text-[11.5px] text-faint">Loading…</div>
        ) : groups.length === 0 && archivedTasks.length === 0 ? (
          <NoProjects
            onAddProject={onAddProject}
            pending={addProjectPending}
            touch={touch}
          />
        ) : (
          <div className="flex flex-col">
            {groups.map((group) => (
              <ProjectSection
                key={group.path}
                group={group}
                status={status}
                pullRequests={pullRequests}
                selectedId={selectedId}
                onSelect={onSelect}
                onNewTask={onNewTask}
                onConfigureProject={onConfigureProject}
                touch={touch}
              />
            ))}

            <ArchiveSections
              archivedTasks={archivedTasks}
              selectedId={selectedId}
              onSelect={onSelect}
              touch={touch}
            />
          </div>
        )}
      </div>

      <div
        className={cn(
          "flex shrink-0 items-center border-t border-border",
          touch ? "h-14 px-2" : "h-10 pl-3.5"
        )}
        style={
          touch ? { paddingBottom: "env(safe-area-inset-bottom)" } : undefined
        }
      >
        <button
          type="button"
          role="switch"
          aria-checked={showArchived}
          aria-label="Show archived"
          onClick={() => onShowArchivedChange(!showArchived)}
          // the whole row is the target on touch — a 15px track is not tappable
          className={cn(
            "flex items-center gap-2.5 rounded-md focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
            touch ? "h-11 flex-1 px-1.5 active:bg-hover" : ""
          )}
        >
          <SwitchTrack checked={showArchived} />
          <span
            className={cn(
              "text-muted-foreground",
              touch ? "text-[13px]" : "text-[11.5px]"
            )}
          >
            Show archived
          </span>
        </button>
        {touch && updateControl && (
          <span className="flex shrink-0 items-center px-1">
            {updateControl}
          </span>
        )}
        {touch && onOpenSettings && (
          <Button size="lg" icon aria-label="Settings" onClick={onOpenSettings}>
            <Gear />
          </Button>
        )}
      </div>
    </aside>
  )
}

/**
 * The pane's own 34px band: its eyebrow and the two things you can do TO the
 * list. Search sits LEFT of add-project — reading a task is the common act and
 * registering one is the rare one, so the pair reads most-used-first toward the
 * edge. A daemon that cannot answer `/api/search` gets no control at all: an
 * icon that can only fail is worse than a missing one.
 */
function SidebarHeader({
  search,
  onAddProject,
  addProjectPending,
  touch,
}: {
  search: ProjectSearch
  onAddProject?: () => void
  addProjectPending: boolean
  touch: boolean
}) {
  return (
    <div
      className={cn(
        "flex shrink-0 items-center gap-2 pr-3 pl-3.5",
        touch ? "h-14" : "h-[34px]"
      )}
      style={touch ? { paddingTop: "env(safe-area-inset-top)" } : undefined}
    >
      <Eyebrow className="flex-1">Projects</Eyebrow>
      {search.available && (
        <Button
          size={touch ? "lg" : "sm"}
          icon
          aria-label="Search tasks"
          title="Search tasks (⌘⇧F)"
          onClick={search.open ? search.close : search.request}
          className={cn(search.open && "bg-hover text-foreground")}
        >
          <Search />
        </Button>
      )}
      {/* the <span> carries the tooltip: a disabled button fires no mouse
          events, so a `title` on it would never show on hover */}
      <span title={onAddProject ? "Add project" : ADD_PROJECT_HINT}>
        <Button
          size={touch ? "lg" : "sm"}
          icon
          disabled={!onAddProject || addProjectPending}
          aria-label={onAddProject ? "Add project" : ADD_PROJECT_HINT}
          onClick={onAddProject}
        >
          <FolderAdd />
        </Button>
      </span>
    </div>
  )
}

/**
 * The one placeholder a pane with no projects at all can honestly show — and
 * it ENDS IN THE CONTROL rather than pointing at one. It used to end in a
 * noun, telling you to use an unlabelled folder icon in the pane header; on a
 * fresh install that was the pane's only instruction and its only dead end.
 */
function NoProjects({
  onAddProject,
  pending,
  touch,
}: {
  onAddProject?: () => void
  pending: boolean
  touch: boolean
}) {
  return (
    <div className="px-2.5 py-2 text-[11.5px] leading-relaxed text-faint">
      No projects yet.
      {onAddProject ? (
        <div className="mt-2">
          <Button
            size={touch ? "touch" : "md"}
            tone="outline"
            disabled={pending}
            onClick={onAddProject}
          >
            <FolderAdd />
            {pending ? "Adding…" : "Add project…"}
          </Button>
        </div>
      ) : (
        <>
          {" "}
          Run{" "}
          <code className="text-muted-foreground">
            wisp project add &lt;path&gt;
          </code>{" "}
          on the daemon host to register one.
        </>
      )}
    </div>
  )
}

/** Unfinished cleanup first, then archived history — two sections, one shape. */
function ArchiveSections({
  archivedTasks,
  selectedId,
  onSelect,
  touch,
}: {
  archivedTasks: ApiTask[]
  selectedId: string | null
  onSelect: (id: string) => void
  touch: boolean
}) {
  return [true, false].map((incomplete) => {
    const rows = archivedTasks.filter(
      (t) => Boolean(t.cleanup && t.cleanup.state !== "complete") === incomplete
    )
    return (
      rows.length > 0 && (
        <section key={String(incomplete)} className="mt-3">
          <div className="flex h-6 items-center px-2">
            <Eyebrow>{incomplete ? "Cleanup" : "Archived"}</Eyebrow>
          </div>
          <div className="mt-px flex flex-col gap-px pl-0.5">
            {rows.map((t) =>
              touch ? (
                <TaskRowTouch
                  key={t.id}
                  task={t}
                  selected={selectedId === t.id}
                  onSelect={onSelect}
                />
              ) : (
                <TaskRow
                  key={t.id}
                  task={t}
                  selected={selectedId === t.id}
                  onSelect={onSelect}
                />
              )
            )}
          </div>
        </section>
      )
    )
  })
}

/** One project: a 28px header row over its task list. */
function ProjectSection({
  group,
  status,
  pullRequests,
  selectedId,
  onSelect,
  onNewTask,
  onConfigureProject,
  touch = false,
}: {
  group: ProjectGroup
  status: Record<string, StatusEntry>
  pullRequests: Record<string, PullRequestOverviewEntry>
  selectedId: string | null
  onSelect: (id: string) => void
  onNewTask: (repoPath: string) => void
  onConfigureProject: (repoPath: string) => void
  touch?: boolean
}) {
  const [open, setOpen] = useState(true)
  return (
    <section className="mt-2 first:mt-0">
      <div
        className={cn(
          "group/project flex items-center gap-1.5 rounded-md pr-1.5 pl-2 hover:bg-hover",
          touch ? "h-11" : "h-7"
        )}
        data-project-path={group.path}
      >
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          title={group.path}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left focus-visible:outline-none"
        >
          <ChevronDown
            aria-hidden
            className={cn(
              "size-3 shrink-0 text-muted-foreground transition-transform",
              !open && "-rotate-90"
            )}
          />
          <span
            className={cn(
              "truncate text-[12.5px] font-medium",
              group.exists
                ? "text-foreground"
                : "text-muted-foreground line-through"
            )}
          >
            {group.name}
          </span>
          {!group.exists && (
            <span className="shrink-0 text-[10.5px] text-muted-foreground">
              missing
            </span>
          )}
        </button>
        <span
          className={cn(
            "font-mono text-[10.5px] text-faint",
            !touch && "group-hover/project:hidden"
          )}
        >
          {group.tasks.length}
        </span>
        <Button
          size={touch ? "lg" : "sm"}
          icon
          aria-label={`Settings for ${group.name}`}
          title={`Settings for ${group.name}`}
          onClick={() => onConfigureProject(group.path)}
          // hover cannot reveal anything on a touch screen
          className={cn(
            touch ? "inline-flex" : "hidden group-hover/project:inline-flex"
          )}
        >
          <Gear />
        </Button>
        <Button
          size={touch ? "lg" : "sm"}
          icon
          aria-label={`New task in ${group.name}`}
          title={`New task in ${group.name}`}
          onClick={() => onNewTask(group.path)}
          className={cn(
            touch ? "inline-flex" : "hidden group-hover/project:inline-flex"
          )}
        >
          <Plus />
        </Button>
      </div>

      {open && (
        <div className="mt-px flex flex-col gap-px pl-0.5">
          {group.tasks.length > 0 ? (
            group.tasks.map((t) =>
              touch ? (
                <TaskRowTouch
                  key={t.id}
                  task={t}
                  status={status[t.id]}
                  pullRequest={pullRequests[t.id]}
                  selected={t.id === selectedId}
                  onSelect={onSelect}
                />
              ) : (
                <TaskRow
                  key={t.id}
                  task={t}
                  status={status[t.id]}
                  pullRequest={pullRequests[t.id]}
                  selected={t.id === selectedId}
                  onSelect={onSelect}
                />
              )
            )
          ) : (
            /**
             * Hover-reveal is right for a dense list and wrong when the row's
             * only content is an empty state: a fresh install has exactly one
             * project, no tasks, and — until this — no visible way to make
             * one. The line stops being dead text and becomes the control.
             */
            <button
              type="button"
              onClick={() => onNewTask(group.path)}
              className={cn(
                "flex w-full items-center gap-1.5 rounded-md px-2.5 text-left text-[11.5px]",
                "text-faint hover:bg-hover hover:text-muted-foreground",
                "focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
                touch ? "h-11" : "h-[26px]"
              )}
            >
              <Plus aria-hidden className="size-3 shrink-0" />
              No tasks yet — create one
            </button>
          )}
        </div>
      )}
    </section>
  )
}
