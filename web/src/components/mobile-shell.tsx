import { useState, type ReactNode } from "react"
import { Drawer } from "@base-ui/react/drawer"
import { CleanupPanel } from "./cleanup-panel"

import { Hamburger, Local, WispMark } from "@/components/icons"
import { PullRequestStatusLink } from "@/components/pull-request-status"
import { TaskActions } from "@/components/task-actions"
import { Meta, StateDot, Tab } from "@/components/primitives"
import { stateWord } from "@/lib/state"
import type { ApiTask, PullRequestStatus } from "@/lib/types"
import { cn } from "@/lib/utils"
import { useMobileViewport } from "@/hooks/use-mobile-viewport"

type MobileTab = "chat" | "changes" | "terminal"

/**
 * Below the `md` breakpoint (useIsMobile). The three-pane grid does not shrink
 * into a phone, so it is replaced rather than squeezed:
 *
 *  - the sidebar becomes a swipe-dismissable drawer, reached from one hamburger
 *  - the three panes become ONE tab strip, so there is exactly one mechanism
 *    for "which surface am I looking at"
 *  - no resizable groups mount at all, so saved desktop geometry is neither
 *    applied nor overwritten by phone dimensions
 *
 * The chrome is BANDED, and each band answers one question, because the range
 * this shell covers is 320px to 767px — a phone AND a narrow Wisp Desktop
 * window, whose `minWidth` is 720. One row carrying app chrome, task identity
 * and task actions at once could not align at either end of that range: the
 * hamburger and the overflow menu centre against a two-or-three line stack, so
 * nothing in the header shares a line with anything else, and an idle daemon
 * version wraps into the width the title needed.
 *
 *  1. the app band — Wisp Desktop only (see below)
 *  2. the task band — one hamburger, the title over ONE metadata line, and the
 *     task's overflow menu, all centred on the same axis
 *  3. the pull request, when there is one, on its own full-width row rather
 *     than splitting the header with the title
 *  4. the tab strip — three equal thirds, a segmented control rather than
 *     left-packed pills with a dead right half
 *
 * Two deliberate departures from the desktop language, because touch is not a
 * small mouse:
 *
 *  - drawer task rows are the TWO-LINE touch variant. The desktop row defers
 *    branch and state to a hover card, and a finger cannot hover.
 *  - the composer is pinned on Chat and Changes but NOT on Terminal, where the
 *    shell itself is the input and a second one would fight the keyboard.
 *
 * Everything is inset for `safe-area-inset-*` so the composer clears a home
 * bar and the header clears a notch.
 */
export function MobileShell({
  task,
  pullRequest,
  sidebar,
  conversation,
  changes,
  terminal,
  composer,
  firstRun,
  desktop = false,
  connectionSwitcher,
  zoomControl,
  connectionStatus,
}: {
  task: ApiTask | null
  pullRequest?: PullRequestStatus
  sidebar: (dismiss: () => void) => ReactNode
  conversation: ReactNode
  changes: ReactNode
  terminal: ReactNode
  composer: ReactNode
  /**
   * The first-run panel. When set it owns everything below the app band: there
   * is no task, so the surface tabs have nothing to switch between and the
   * composer has nothing to steer. The drawer stays reachable — the hamburger
   * is the one control that still means something.
   */
  firstRun?: ReactNode
  /** Wisp Desktop, whose packaged window hides its title bar — see the app band. */
  desktop?: boolean
  /** Desktop mode uses one compact menu here; browser mode leaves it absent. */
  connectionSwitcher?: ReactNode
  /** Desktop-only application zoom surface. */
  zoomControl?: ReactNode
  connectionStatus?: ReactNode
}) {
  const [tab, setTab] = useState<MobileTab>("chat")
  const [drawer, setDrawer] = useState(false)
  const viewportRef = useMobileViewport(!desktop)

  // a task switch is always about reading the conversation next
  const [seenTask, setSeenTask] = useState(task?.id)
  if (seenTask !== task?.id) {
    setSeenTask(task?.id)
    setTab("chat")
  }

  return (
    <div ref={viewportRef} className={cn("mobile-shell flex h-dvh flex-col bg-background text-foreground", !desktop && "mobile-browser-shell")}>
      <header className="shrink-0 border-b border-border bg-surface" style={{ paddingTop: "env(safe-area-inset-top)" }}>
        {/* The app band is Wisp Desktop's alone, and it is not decoration: that
            window is `titleBarStyle: Overlay`, so the traffic lights float over
            whatever sits at the top left, and a hidden title bar leaves nothing
            to drag the window by. `pl-20` reserves them the room the pointer
            shell's top bar already gives them. The browser has neither problem
            and neither control, so it gets no band at all — app-level state on
            touch lives in the drawer footer, beside the gear. */}
        {desktop && (
          <div
            data-tauri-drag-region=""
            className="flex h-11 items-center gap-1 border-b border-border pr-1.5 pl-20"
          >
            <span role="img" aria-label="Wisp" className="shrink-0">
              <WispMark className="size-[17px]" />
            </span>
            {connectionSwitcher}
            <span className="flex-1" />
            {zoomControl}
          </div>
        )}

        <div className="flex items-center gap-1 px-1">
          <button
            type="button"
            onClick={() => setDrawer(true)}
            aria-label="Open tasks"
            className="flex size-11 shrink-0 items-center justify-center rounded-lg text-fg-secondary active:bg-hover"
          >
            <Hamburger className="size-5" />
          </button>

          {/* Exactly two lines, so the 44px control on either side of it centres
              on the axis the title sits on. Nothing else joins this row. */}
          <div className="min-w-0 flex-1 py-2">
            {task ? (
              <>
                <h1 className="truncate text-[14.5px] font-semibold tracking-[-0.01em]" title={task.title}>
                  {task.title}
                </h1>
                <Meta
                  className="mt-1"
                  items={[
                    <span key="state" className="flex shrink-0 items-center gap-1.5">
                      <StateDot state={task.state} background={task.background} />
                      <span className="text-fg-secondary">{stateWord(task)}</span>
                    </span>,
                    // Worktree is the default and says so on its own branch;
                    // LOCAL is the one worth the width (§5c), and the desktop
                    // header marks it the same way.
                    task.mode === "local" && (
                      <span key="mode" className="flex shrink-0 items-center gap-1.5 text-fg-secondary">
                        <Local className="size-3" />
                        Local
                      </span>
                    ),
                    // The composer used to carry these too, three rows down and
                    // truncated to "claudeI…". One place, un-truncated.
                    <span key="agent" className="flex min-w-0 items-center gap-1.5">
                      <span className="shrink-0">{task.harness}</span>
                      {task.model && (
                        <>
                          <span className="text-faint">·</span>
                          <span className="min-w-0 truncate font-mono">{task.model}</span>
                        </>
                      )}
                    </span>,
                  ]}
                />
              </>
            ) : firstRun ? (
              <div className="text-[14.5px] font-semibold tracking-[-0.01em]">Wisp</div>
            ) : (
              <div className="text-[14.5px] text-muted-foreground">No task selected</div>
            )}
          </div>

          {/* 44px hit box around a 26px trigger — the touch floor (§6b) */}
          {task && (
            <span className="flex size-11 shrink-0 items-center justify-center">
              <TaskActions task={task} />
            </span>
          )}
        </div>

        {/* Its own row, indented so its TEXT starts on the title's left edge. */}
        {pullRequest?.kind === "found" && (
          <div className="flex pr-1 pb-1.5 pl-10">
            <PullRequestStatusLink
              pullRequest={pullRequest.pullRequest}
              others={pullRequest.others}
              compact
            />
          </div>
        )}
      </header>
      {connectionStatus}
      {task?.cleanup && <div className="scroll-slim max-h-[40dvh] shrink-0 overflow-y-auto border-b border-border px-3 pb-3 [&_button]:min-h-11"><CleanupPanel task={task} /></div>}

      {!firstRun && (
      <div
        role="tablist"
        aria-label="Task surface"
        className="flex h-11 shrink-0 items-center gap-1 border-b border-border bg-surface px-1.5"
      >
        {(["chat", "changes", "terminal"] as const).map((t) => (
          <Tab key={t} size="lg" active={tab === t} onClick={() => setTab(t)} className="h-full flex-1 justify-center">
            {t === "chat" ? "Chat" : t === "changes" ? "Changes" : "Terminal"}
          </Tab>
        ))}
      </div>
      )}

      <main className="flex min-h-0 flex-1 flex-col">
        {/* every pane stays mounted: switching tabs must not drop the
            conversation's scroll position or tear down a live shell */}
        {firstRun}
        {!firstRun && <Pane show={tab === "chat"}>{conversation}</Pane>}
        {!firstRun && <Pane show={tab === "changes"}>{changes}</Pane>}
        {!firstRun && (
          <Pane show={tab === "terminal"}><div className="flex min-h-0 flex-1 flex-col pb-(--mobile-bottom)">{terminal}</div></Pane>
        )}
      </main>

      {!firstRun && tab !== "terminal" && (
        <div className="shrink-0" style={{ paddingBottom: "var(--mobile-bottom, env(safe-area-inset-bottom))" }}>
          {composer}
        </div>
      )}

      <Drawer.Root open={drawer} onOpenChange={setDrawer} swipeDirection="left">
        <Drawer.Portal>
          <Drawer.Backdrop className="fixed inset-0 z-(--z-backdrop) bg-scrim" />
          <Drawer.Popup
            className={cn(
              "mobile-task-drawer fixed inset-y-0 left-0 z-(--z-modal) flex w-[86vw] max-w-[340px] flex-col",
              "border-r border-border-strong bg-sidebar outline-none",
            )}
          >
            <Drawer.Title className="sr-only">Tasks</Drawer.Title>
            {sidebar(() => setDrawer(false))}
          </Drawer.Popup>
        </Drawer.Portal>
      </Drawer.Root>
    </div>
  )
}

/** Kept mounted, hidden when inactive — see the note in MobileShell. */
function Pane({ show, children }: { show: boolean; children: ReactNode }) {
  return (
    <div className={cn("min-h-0 flex-1 flex-col", show ? "flex" : "hidden")} aria-hidden={!show}>
      {children}
    </div>
  )
}
