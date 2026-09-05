import { useState } from "react"
import { PreviewCard } from "@base-ui/react/preview-card"

import { ArchiveConfirmDialog } from "@/components/archive-flow"
import { Archive, Pencil, ArrowUp, BranchRequest } from "@/components/icons"
import { POPOVER_SURFACE, StateDot } from "@/components/primitives"
import { useArchiveFlow } from "@/hooks/useArchiveFlow"
import { pullRequestSidebarTone } from "@/lib/pull-request-tone"
import { STATE_TEXT, stateWord, since } from "@/lib/state"
import type { ApiTask, PullRequestOverviewEntry, StatusEntry } from "@/lib/types"
import { cn, oneLine } from "@/lib/utils"

interface TaskRowProps {
  task: ApiTask
  /** GET /api/status — live tasks only; archived rows pass undefined */
  status?: StatusEntry
  /** GET /api/pull-requests — live tasks only; only a found PR renders */
  pullRequest?: PullRequestOverviewEntry
  selected: boolean
  onSelect: (id: string) => void
}

/**
 * ONE 26px line: state dot, task name, PR status, git marks. Nothing else.
 *
 * Branch, agent, turn count and the state detail live in the hover card — you
 * scan the list, then ask one row for the rest. Selection is `bg-accent` and
 * nothing else: no rail, no border, no hue.
 *
 * The right edge carries a provider-owned PR icon plus DIRTY-FILE and AHEAD
 * counts, not a +adds/−dels diffstat: GET /api/tasks does not serve a per-task diffstat and only
 * GET /api/tasks/:id does, so showing one for every row would mean N requests
 * or a lie. These two numbers are real, come free with /api/status, and answer
 * the same question — has this task touched anything, and is it ahead.
 *
 * D2: hover reveals ARCHIVE at the right edge, in the git-marks slot, and the
 * marks yield to it. Three things that shape follows from:
 *
 *  - the archive control is a SIBLING of the preview card, never a child of its
 *    trigger. `PreviewCard.Trigger` renders a `<button>`, and a button inside a
 *    button is invalid HTML with genuinely broken clicks. The sibling structure
 *    is also why clicking archive cannot select the row.
 *  - the hover card is CONTROLLED here (Q9): while the pointer is over the
 *    archive button the card is closed and cannot open, so the two hover
 *    affordances stop racing over the same 280ms.
 *  - an archived row gets no button, and therefore no fade on its marks: there
 *    is nothing to reveal, so nothing may move.
 */
export function TaskRow({ task, status, pullRequest, selected, onSelect }: TaskRowProps) {
  // the card's own wish (hover/focus), and the veto that outranks it
  const [wantsCard, setWantsCard] = useState(false)
  const [overArchive, setOverArchive] = useState(false)
  const archive = useArchiveFlow(task)
  const archivable = !task.archived

  return (
    <div
      className="group/row relative"
      // the pointer can leave a 26px row between two pointerleave targets;
      // resetting both here keeps a stuck hover from suppressing the card
      onPointerLeave={() => {
        setOverArchive(false)
        setWantsCard(false)
      }}
    >
      <PreviewCard.Root open={wantsCard && !overArchive} onOpenChange={setWantsCard}>
        <PreviewCard.Trigger
          render={<button type="button" />}
          delay={280}
          closeDelay={80}
          data-task-id={task.id}
          data-state={task.state}
          data-selected={selected || undefined}
          onClick={() => onSelect(task.id)}
          className={cn(
            "flex h-[26px] w-full items-center gap-2.5 rounded-md pr-2 pl-2.5 text-left transition-colors",
            "focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
            selected ? "bg-accent" : "hover:bg-hover",
            task.archived && "opacity-55",
          )}
        >
          <StateDot state={task.state} />
          <span
            className={cn(
              "min-w-0 flex-1 truncate text-[12.5px]",
              selected ? "font-medium text-foreground" : "text-foreground/90",
              task.state === "creating" && "text-fg-secondary",
            )}
          >
            {task.title}
          </span>
          <SidebarPullRequestStatus
            entry={task.archived ? undefined : pullRequest}
            yields={archivable}
          />
          <GitMarks status={status} yields={archivable} />
        </PreviewCard.Trigger>

        <PreviewCard.Portal>
          <PreviewCard.Positioner
            side="right"
            align="start"
            sideOffset={8}
            collisionPadding={12}
            className="z-(--z-hovercard)"
          >
            <PreviewCard.Popup className={cn(POPOVER_SURFACE, "w-[302px] rounded-xl p-3.5")}>
              <TaskCard
                task={task}
                status={status}
                pullRequest={task.archived ? undefined : pullRequest}
              />
            </PreviewCard.Popup>
          </PreviewCard.Positioner>
        </PreviewCard.Portal>
      </PreviewCard.Root>

      {archivable && (
        <>
          <RowArchiveButton
            task={task}
            onArchive={() => archive.request(false)}
            onPointerEnter={() => setOverArchive(true)}
            onPointerLeave={() => setOverArchive(false)}
          />
          <ArchiveConfirmDialog
            task={task}
            reason={archive.reason}
            pending={archive.pending}
            onCancel={archive.dismiss}
            onForce={() => archive.request(true)}
          />
        </>
      )}
    </div>
  )
}

/**
 * The row's one hover verb. 22px, quiet register, revealed by hover or by
 * keyboard focus reaching the row — and exported so the gallery can show it
 * without pretending to hover.
 */
export function RowArchiveButton({
  task,
  onArchive,
  onPointerEnter,
  onPointerLeave,
  className,
}: {
  task: ApiTask
  onArchive: () => void
  onPointerEnter?: () => void
  onPointerLeave?: () => void
  /** the gallery forces it visible; the row leaves this alone */
  className?: string
}) {
  return (
    <button
      type="button"
      aria-label={`Archive ${task.title}`}
      title="Archive this task"
      onClick={onArchive}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      className={cn(
        "absolute top-1/2 right-1 flex size-[22px] -translate-y-1/2 items-center justify-center rounded-md",
        "text-muted-foreground transition-opacity hover:bg-hover hover:text-foreground",
        "focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
        "opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100 focus-visible:opacity-100",
        className,
      )}
    >
      <Archive className="size-3.5" />
    </button>
  )
}

/**
 * The touch variant. TWO lines, 44px tall, and NO hover card — a finger cannot
 * hover, so the facts the desktop row defers to the card have to be on the row
 * itself. State and branch are the two worth the second line; the rest stays in
 * the task header once you open it.
 *
 * It gets NO archive control, and that is the decision rather than an omission
 * (Q9): hover reveals nothing on a touch screen, and archive is already one tap
 * away in the task header. A long press for exactly one verb would be the app's
 * only long press, and undiscoverable.
 */
export function TaskRowTouch({ task, status, pullRequest, selected, onSelect }: TaskRowProps) {
  return (
    <button
      type="button"
      data-task-id={task.id}
      data-state={task.state}
      data-selected={selected || undefined}
      onClick={() => onSelect(task.id)}
      className={cn(
        "flex min-h-[44px] w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors",
        selected ? "bg-accent" : "active:bg-hover",
        task.archived && "opacity-55",
      )}
    >
      <StateDot state={task.state} className="mt-px" />
      <span className="min-w-0 flex-1">
        <span className={cn("block truncate text-[13.5px]", selected ? "font-medium text-foreground" : "text-foreground/90")}>
          {task.title}
        </span>
        <span className="mt-0.5 flex items-center gap-1.5 text-[11.5px]">
          <span className={STATE_TEXT[task.state]}>{stateWord(task)}</span>
          {task.branch && (
            <>
              <span className="text-faint">·</span>
              <span className="truncate font-mono text-muted-foreground">{task.branch}</span>
            </>
          )}
        </span>
      </span>
      <SidebarPullRequestStatus entry={task.archived ? undefined : pullRequest} />
      <GitMarks status={status} />
    </button>
  )
}

function SidebarPullRequestStatus({
  entry,
  yields = false,
}: {
  entry?: PullRequestOverviewEntry
  yields?: boolean
}) {
  if (entry?.status.kind !== "found") return null
  const pullRequest = entry.status.pullRequest
  const lifecycle = pullRequest.lifecycle === "merged"
    ? "Merged"
    : pullRequest.lifecycle === "closed"
      ? "Closed"
      : pullRequest.lifecycle === "draft"
        ? "Draft"
        : pullRequestSidebarTone(pullRequest) === "text-destructive"
          ? "Blocked"
          : "Open"
  const freshness = entry.stale
    ? ` · Status stale, last checked ${since(entry.checkedAt)}`
    : ""
  const label = `PR #${pullRequest.number} · ${lifecycle}${freshness}`
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      data-testid="sidebar-pull-request-icon"
      className={cn(
        "flex shrink-0 items-center text-muted-foreground",
        yields &&
          "transition-opacity group-hover/row:opacity-0 group-focus-within/row:opacity-0",
      )}
    >
      <BranchRequest
        aria-hidden
        className={cn("size-3", pullRequestSidebarTone(pullRequest))}
      />
    </span>
  )
}

/**
 * Dirty and ahead counts. Muted text and a 10px glyph — no chips, no hue.
 *
 * When git cannot read the worktree the slot carries muted WORDS instead of the
 * counts. Rendering nothing there is what made the reported broken worktree look
 * spotless in the sidebar while the diff pane screamed (D1) — the whole point of
 * this slice is that the row stops being the quiet half of that lie.
 *
 * `yields` is D2: the slot fades out on hover so the archive button can have it.
 * The "No worktree" words fade the same way, on purpose — archive is exactly
 * that row's recovery action.
 */
function GitMarks({ status, yields = false }: { status?: StatusEntry; yields?: boolean }) {
  const fade = yields && "transition-opacity group-hover/row:opacity-0 group-focus-within/row:opacity-0"
  if (!status) return null
  if (status.worktreeReason !== null) {
    return (
      <span
        className={cn("shrink-0 text-[10.5px] text-muted-foreground", fade)}
        title={oneLine(status.worktreeReason)}
      >
        No worktree
      </span>
    )
  }
  const dirty = status.dirtyFiles > 0
  const ahead = status.ahead > 0
  if (!dirty && !ahead) return null
  return (
    <span className={cn("flex shrink-0 items-center gap-2 text-[10.5px] text-muted-foreground", fade)}>
      {dirty && (
        <span className="flex items-center gap-0.5" title={`${status.dirtyFiles} dirty file(s)`}>
          <Pencil className="size-2.5" />
          <span className="font-mono">{status.dirtyFiles}</span>
        </span>
      )}
      {ahead && (
        <span className="flex items-center gap-0.5" title={`${status.ahead} commit(s) ahead of base`}>
          <ArrowUp className="size-2.5" />
          <span className="font-mono">{status.ahead}</span>
        </span>
      )}
    </span>
  )
}

/** The hover card. Exported so the gallery can render it without hovering. */
export function TaskCard({
  task,
  status,
  pullRequest,
}: {
  task: ApiTask
  status?: StatusEntry
  pullRequest?: PullRequestOverviewEntry
}) {
  const worktree =
    status && status.worktreeReason === null
      ? [
          status.dirtyFiles > 0 && `${status.dirtyFiles} dirty`,
          status.ahead > 0 && `${status.ahead} ahead`,
          status.unpushed && "unpushed",
        ]
          .filter(Boolean)
          .join(" · ")
      : status
        ? oneLine(status.worktreeReason)
        : null
  const pr = pullRequest?.status.kind === "found"
    ? pullRequest.status.pullRequest
    : null

  return (
    <div>
      <div className="text-[12.5px] leading-snug font-medium text-foreground">{task.title}</div>

      <div className="mt-2 flex items-center gap-1.5">
        <StateDot state={task.state} className="size-1.5" />
        <span className={cn("text-[11.5px]", STATE_TEXT[task.state])}>{stateWord(task)}</span>
        {task.archived && <span className="text-[11.5px] text-faint">· archived</span>}
      </div>
      {task.state_detail && (
        <div className="mt-1 text-[11.5px] leading-normal text-fg-secondary">{task.state_detail}</div>
      )}

      <div className="my-3 h-px bg-border" />

      <dl className="grid grid-cols-[62px_1fr] items-baseline gap-x-2.5 gap-y-1.5">
        <Key>Branch</Key>
        <Val className="truncate font-mono">{task.branch ?? "—"}</Val>

        {pr && (
          <>
            <Key>Pull request</Key>
            <Val>
              #{pr.number} · {pr.lifecycle}
              {pullRequest?.stale &&
                ` · stale, checked ${since(pullRequest.checkedAt)}`}
            </Val>
          </>
        )}

        {/* only for local: a worktree task's wisp/… branch already says which
            it is, and a row every card carries is a row nobody reads */}
        {task.mode === "local" && (
          <>
            <Key>Runs in</Key>
            <Val>The project directory</Val>
          </>
        )}

        <Key>Agent</Key>
        <Val>
          {task.harness}
          {task.model && <span className="font-mono"> · {task.model}</span>}
          {task.effort && ` · ${task.effort}`}
        </Val>

        <Key>Turns</Key>
        <Val>
          {task.turn_count}
          <span className="text-muted-foreground"> · last {since(task.updated_at)}</span>
        </Val>

        {worktree && (
          <>
            <Key>Worktree</Key>
            <Val>{worktree}</Val>
          </>
        )}
      </dl>
    </div>
  )
}

function Key({ children }: { children: React.ReactNode }) {
  return <dt className="text-[10.5px] text-faint">{children}</dt>
}

function Val({ children, className }: { children: React.ReactNode; className?: string }) {
  return <dd className={cn("min-w-0 text-[11px] text-fg-secondary", className)}>{children}</dd>
}
