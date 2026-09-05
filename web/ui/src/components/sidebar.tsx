import { useState } from "react"

import { ChevronDown, FolderAdd, Gear, Plus } from "@/components/icons"
import { Button, Eyebrow } from "@/components/primitives"
import { TaskRow, TaskRowTouch } from "@/components/task-row"
import type { ProjectGroup } from "@/lib/projects"
import type { ApiTask, PullRequestOverviewEntry, StatusEntry } from "@/lib/types"
import { cn } from "@/lib/utils"

/**
 * Registering a project needs an ABSOLUTE path on the daemon host, and a
 * browser cannot produce one: showDirectoryPicker() hands back a folder NAME
 * with no parent, and webkitdirectory yields paths relative to the chosen
 * root. Rather than ship a text field dressed up as a picker, the web app
 * defers to `wisp project add`, which already exists and takes a real path.
 */
const ADD_PROJECT_HINT = "Add a project from the CLI: wisp project add <path>"

interface SidebarProps {
  groups: ProjectGroup[]
  /** present only when the footer toggle fetched ?archived=1 */
  archivedTasks: ApiTask[]
  status: Record<string, StatusEntry>
  pullRequests: Record<string, PullRequestOverviewEntry>
  selectedId: string | null
  onSelect: (id: string) => void
  showArchived: boolean
  onShowArchivedChange: (value: boolean) => void
  onNewTask: (repoPath: string) => void
  onConfigureProject: (repoPath: string) => void
  /** a tasks/status fetch failure, shown inline */
  error: string | null
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
  error,
  loading,
  touch = false,
}: SidebarProps) {
  return (
    <aside className="flex h-full min-h-0 flex-col bg-sidebar">
      <div
        className={cn("flex shrink-0 items-center gap-2 pr-3 pl-3.5", touch ? "h-14" : "h-[34px]")}
        style={touch ? { paddingTop: "env(safe-area-inset-top)" } : undefined}
      >
        <Eyebrow className="flex-1">Projects</Eyebrow>
        {/* the <span> carries the tooltip: a disabled button fires no mouse
            events, so a `title` on it would never show on hover */}
        <span title={ADD_PROJECT_HINT}>
          <Button size={touch ? "lg" : "sm"} icon disabled aria-label={ADD_PROJECT_HINT}>
            <FolderAdd />
          </Button>
        </span>
      </div>

      {error && <div className="px-3.5 pb-1.5 text-[11.5px] text-destructive">{error}</div>}

      <div className="scroll-slim min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        {loading && groups.length === 0 ? (
          <div className="px-2.5 py-1 text-[11.5px] text-faint">Loading…</div>
        ) : groups.length === 0 && archivedTasks.length === 0 ? (
          <div className="px-2.5 py-2 text-[11.5px] leading-relaxed text-faint">
            No projects yet. Run <code className="text-muted-foreground">wisp project add &lt;path&gt;</code> to register
            one, then its <span className="text-muted-foreground">+</span> creates the first task.
          </div>
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

            {archivedTasks.length > 0 && (
              <section className="mt-3">
                <div className="flex h-6 items-center px-2">
                  <Eyebrow>Archived</Eyebrow>
                </div>
                <div className="mt-px flex flex-col gap-px pl-0.5">
                  {archivedTasks.map((t) =>
                    touch ? (
                      <TaskRowTouch key={t.id} task={t} selected={t.id === selectedId} onSelect={onSelect} />
                    ) : (
                      <TaskRow key={t.id} task={t} selected={t.id === selectedId} onSelect={onSelect} />
                    ),
                  )}
                </div>
              </section>
            )}
          </div>
        )}
      </div>

      <div
        className={cn("flex shrink-0 items-center border-t border-border", touch ? "h-14 px-2" : "h-10 pl-3.5")}
        style={touch ? { paddingBottom: "env(safe-area-inset-bottom)" } : undefined}
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
            touch ? "h-11 flex-1 px-1.5 active:bg-hover" : "",
          )}
        >
          <span
            className={cn(
              "relative h-[15px] w-[26px] shrink-0 rounded-full transition-colors",
              showArchived ? "bg-primary" : "bg-border-strong",
            )}
          >
            <span
              className={cn(
                "absolute top-0.5 size-[11px] rounded-full transition-all",
                showArchived ? "left-[13px] bg-primary-foreground" : "left-0.5 bg-muted-foreground",
              )}
            />
          </span>
          <span className={cn("text-muted-foreground", touch ? "text-[13px]" : "text-[11.5px]")}>Show archived</span>
        </button>
      </div>
    </aside>
  )
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
          touch ? "h-11" : "h-7",
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
            className={cn("size-3 shrink-0 text-muted-foreground transition-transform", !open && "-rotate-90")}
          />
          <span
            className={cn(
              "truncate text-[12.5px] font-medium",
              group.exists ? "text-foreground" : "text-muted-foreground line-through",
            )}
          >
            {group.name}
          </span>
          {!group.exists && <span className="shrink-0 text-[10.5px] text-muted-foreground">missing</span>}
        </button>
        <span
          className={cn("font-mono text-[10.5px] text-faint", !touch && "group-hover/project:hidden")}
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
          className={cn(touch ? "inline-flex" : "hidden group-hover/project:inline-flex")}
        >
          <Gear />
        </Button>
        <Button
          size={touch ? "lg" : "sm"}
          icon
          aria-label={`New task in ${group.name}`}
          title={`New task in ${group.name}`}
          onClick={() => onNewTask(group.path)}
          className={cn(touch ? "inline-flex" : "hidden group-hover/project:inline-flex")}
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
              ),
            )
          ) : (
            <div className="px-2.5 py-1 text-[11.5px] text-faint">No tasks yet</div>
          )}
        </div>
      )}
    </section>
  )
}
