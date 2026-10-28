import { useId, useState, type KeyboardEvent, type PointerEvent } from "react"

import { ChevronDown, Gear, Plus, Verify } from "@/components/icons"
import { Button, Eyebrow } from "@/components/primitives"
import { TaskTree } from "@/components/subtask-rows"
import type { SubtaskTreeView } from "@/hooks/useSidebarTree"
import { VERIFICATION_DOT, verificationTitle, verificationTone } from "@/lib/auto-review-words"
import type { ProjectGroup } from "@/lib/projects"
import type { SidebarList } from "@/lib/subtask-tree"
import { isApplePlatform } from "@/lib/terminal"
import type { PullRequestOverviewEntry, StatusEntry } from "@/lib/types"
import { cn } from "@/lib/utils"

/*
 * The sidebar's sections: each project with its tasks, and the archive below
 * them. Beside sidebar.tsx, which keeps the pane's frame.
 */

/** Unfinished cleanup first, then archived history — two sections, one shape, each nested on its own. */
export function ArchiveSections({
  lists,
  view,
  selectedId,
  onSelect,
  touch,
}: {
  /** the archive's lists, Cleanup then Archived */
  lists: readonly SidebarList[]
  view: SubtaskTreeView
  selectedId: string | null
  onSelect: (id: string) => void
  touch: boolean
}) {
  return lists.map(
    (list) =>
      list.nodes.length > 0 && (
        <section key={list.key} className="mt-3">
          <div className="flex h-6 items-center px-2">
            <Eyebrow>{list.key === "archive:Cleanup" ? "Cleanup" : "Archived"}</Eyebrow>
          </div>
          <div className="mt-px flex flex-col gap-px pl-0.5">
            <TaskTree nodes={list.nodes} view={view} selectedId={selectedId} onSelect={onSelect} touch={touch} />
          </div>
        </section>
      )
  )
}

/**
 * The project's verification recipe, as one quiet glyph beside the gear. It
 * hides until hover like the gear while there is nothing to say; a dot (a
 * draft to activate, a recipe task working, a reviewer reporting the recipe
 * broken) keeps it on screen. Its title says the state; a click opens the
 * project's settings at Verification.
 */
function VerificationButton({
  group,
  summary,
  touch,
  onClick,
}: {
  group: ProjectGroup
  summary: NonNullable<ProjectGroup["verification"]>
  touch: boolean
  onClick: () => void
}) {
  const tone = verificationTone(summary)
  const title = verificationTitle(summary)
  return (
    <Button
      size={touch ? "lg" : "sm"}
      icon
      aria-label={`${title} — ${group.name}`}
      title={title}
      data-verification={tone ?? "quiet"}
      onClick={onClick}
      // hover cannot reveal anything on a touch screen; a dot is always worth showing
      className={cn("relative", touch || tone ? "inline-flex" : "hidden group-hover/project:inline-flex")}
    >
      <Verify />
      {tone && (
        <span
          aria-hidden
          className={cn("absolute size-1.5 rounded-full", touch ? "top-1.5 right-1.5" : "top-0.5 right-0.5", VERIFICATION_DOT[tone])}
        />
      )}
    </Button>
  )
}

/** A configured project's place in the order, when the daemon can save a new one. */
export interface ProjectOrderControls {
  canMoveUp: boolean
  canMoveDown: boolean
  /** a move from the focused header's keys; the header keeps focus */
  onMove: (step: -1 | 1) => void
  /** this project's header is the one being dragged */
  dragging: boolean
  onPointerDown: (event: PointerEvent) => void
}

/** The modifier's name as the keyboard prints it; `aria-keyshortcuts` says Alt everywhere. */
const MOVE_KEY = isApplePlatform() ? "Option" : "Alt"

/** Alt+↑ / Alt+↓ on a focused header move its project. */
function moveKey(event: KeyboardEvent, order: ProjectOrderControls): void {
  if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
  const step = event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0
  if (step === 0) return
  event.preventDefault()
  if (step === -1 ? order.canMoveUp : order.canMoveDown) order.onMove(step)
}

/** The row has no visible move control, so its toggle says how to move it. */
function moveDescription(touch: boolean): string {
  const drag = touch ? "press and hold the row, then drag it" : "drag the row"
  return `To reorder, ${drag}, or press ${MOVE_KEY}+Up Arrow or ${MOVE_KEY}+Down Arrow.`
}

/** One project: a 28px header row over its task list. */
export function ProjectSection({
  group,
  list,
  view,
  status,
  pullRequests,
  selectedId,
  onSelect,
  onNewTask,
  onConfigureProject,
  verification = false,
  touch = false,
  order,
}: {
  group: ProjectGroup
  /** the group's tasks as the sidebar draws them: nested, or flat */
  list: SidebarList
  view: SubtaskTreeView
  status: Record<string, StatusEntry>
  pullRequests: Record<string, PullRequestOverviewEntry>
  selectedId: string | null
  onSelect: (id: string) => void
  onNewTask: (repoPath: string) => void
  onConfigureProject: (repoPath: string, section?: "verification") => void
  verification?: boolean
  touch?: boolean
  /** absent: this project does not reorder (an older daemon, or a repo known only from tasks) */
  order?: ProjectOrderControls
}) {
  const [open, setOpen] = useState(true)
  const moveHintId = useId()
  const dragging = order?.dragging === true
  return (
    <section className="mt-2 first:mt-0">
      <div
        className={cn(
          "group/project flex items-center gap-1.5 rounded-md pr-1.5 pl-2 hover:bg-hover",
          touch ? "h-11" : "h-7",
          order && "wisp-lift",
          dragging && "relative z-(--z-pane) bg-popover"
        )}
        data-project-path={group.path}
        data-project-header=""
        data-orderable={order ? "" : undefined}
        data-dragging={dragging ? "" : undefined}
        onPointerDown={order?.onPointerDown}
        onKeyDown={order ? (event) => moveKey(event, order) : undefined}
      >
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          aria-keyshortcuts={order ? "Alt+ArrowUp Alt+ArrowDown" : undefined}
          aria-describedby={order ? moveHintId : undefined}
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
        {order && (
          <span id={moveHintId} className="sr-only">
            {moveDescription(touch)}
          </span>
        )}
        <span
          className={cn(
            "font-mono text-[10.5px] text-faint",
            !touch && "group-hover/project:hidden"
          )}
        >
          {group.tasks.length}
        </span>
        {verification && group.verification && (
          <VerificationButton
            group={group}
            summary={group.verification}
            touch={touch}
            onClick={() => onConfigureProject(group.path, "verification")}
          />
        )}
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

      {/* a dragged project folds its tasks away, so the drop slots stay close together */}
      {open && !dragging && (
        <div className="mt-px flex flex-col gap-px pl-0.5">
          {group.tasks.length > 0 ? (
            <TaskTree
              nodes={list.nodes}
              view={view}
              status={status}
              pullRequests={pullRequests}
              selectedId={selectedId}
              onSelect={onSelect}
              touch={touch}
            />
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
