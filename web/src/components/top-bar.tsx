import type { ReactNode, RefObject } from "react"

import { DesktopConnectionChrome } from "@/components/connection-chrome"
import { DesktopZoomControl } from "@/components/desktop-zoom-control"
import { Gear, WispMark } from "@/components/icons"
import { Button } from "@/components/primitives"
import { TopBarLeft, TopBarTask } from "@/components/top-bar-task"
import { TopBarTools } from "@/components/top-bar-tools"
import { UsageLimitsControl } from "@/components/usage-limits-control"
import type { ApiTask, PullRequestStatus } from "@/lib/types"

/**
 * The pointer shell's one bar (frontend §5h). Left to right it answers:
 * which daemon, which task, what you can open for that task, and what you
 * can do to the app. On Desktop it is the window's drag region; every
 * control in it is not.
 */
export function TopBar({
  barRef,
  desktop,
  task,
  pullRequest,
  updateControl,
  onOpenSettings,
}: {
  /** the shell writes `--sidebar-width` here, so the task's title lines up with the centre */
  barRef: RefObject<HTMLElement | null>
  desktop: boolean
  /** null while no task is open, or while first run owns the centre */
  task: ApiTask | null
  pullRequest?: PullRequestStatus
  updateControl: ReactNode
  onOpenSettings: () => void
}) {
  const drag = desktop ? "" : undefined
  return (
    <header
      ref={barRef}
      data-tauri-drag-region={drag}
      className="flex h-9 shrink-0 items-center border-b border-border bg-surface pr-3"
    >
      <TopBarLeft desktop={desktop}>
        {/* The mark is the browser's only left-end identity: no window chrome,
            no tabs. Desktop drops it — the traffic lights own that corner and
            the connection tabs already say which daemon is on screen. */}
        {!desktop && (
          <span role="img" aria-label="Wisp" className="shrink-0">
            <WispMark className="pointer-events-none size-[17px]" />
          </span>
        )}
        {desktop && <DesktopConnectionChrome />}
      </TopBarLeft>
      {/* The middle answers WHICH TASK: its title opens its menu. */}
      <div data-tauri-drag-region={drag} className="flex h-full min-w-0 flex-1 items-center gap-2.5 pl-4.5">
        <TopBarTask task={task} pullRequest={pullRequest} dragRegion={desktop} />
      </div>
      {/* Then WHAT YOU CAN OPEN for it: the tools, beside the task they act on
          and apart from the app's own cluster. */}
      {task && (
        <>
          <TopBarTools task={task} pullRequest={pullRequest} dragRegion={desktop} />
          <span aria-hidden data-tauri-drag-region={drag} className="ml-1.5 h-4 w-px shrink-0 bg-border" />
        </>
      )}
      {/* Everything you can do TO the app is ONE cluster at the right end,
          4px apart against the header's 10px, so the three of them read as a
          group rather than as three unrelated controls that happen to be
          near each other. Usage limits lead: they are read the most. The
          gear stays last: it is still the top-right corner (§5g). */}
      <div data-tauri-drag-region={drag} className="flex h-full shrink-0 items-center gap-1 pl-2.5">
        <UsageLimitsControl harness={task?.harness ?? null} onOpenSettings={onOpenSettings} />
        {updateControl}
        {desktop && <DesktopZoomControl />}
        <Button size="sm" icon aria-label="Settings" onClick={onOpenSettings}>
          <Gear />
        </Button>
      </div>
    </header>
  )
}
