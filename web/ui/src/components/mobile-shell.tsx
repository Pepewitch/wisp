import { useState, type ReactNode } from "react"
import { Drawer } from "@base-ui/react/drawer"

import { Hamburger } from "@/components/icons"
import { PullRequestStatusLink } from "@/components/pull-request-status"
import { TaskActions } from "@/components/task-actions"
import { StateDot, Tab } from "@/components/primitives"
import { stateWord } from "@/lib/state"
import type { ApiTask, PullRequestStatus } from "@/lib/types"
import { cn } from "@/lib/utils"

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
}: {
  task: ApiTask | null
  pullRequest?: PullRequestStatus
  sidebar: (dismiss: () => void) => ReactNode
  conversation: ReactNode
  changes: ReactNode
  terminal: ReactNode
  composer: ReactNode
}) {
  const [tab, setTab] = useState<MobileTab>("chat")
  const [drawer, setDrawer] = useState(false)

  // a task switch is always about reading the conversation next
  const [seenTask, setSeenTask] = useState(task?.id)
  if (seenTask !== task?.id) {
    setSeenTask(task?.id)
    setTab("chat")
  }

  return (
    <div className="flex h-dvh flex-col bg-background text-foreground">
      <header
        className="flex shrink-0 items-center gap-2 border-b border-border bg-surface pr-2 pl-1"
        style={{ paddingTop: "env(safe-area-inset-top)" }}
      >
        <button
          type="button"
          onClick={() => setDrawer(true)}
          aria-label="Open tasks"
          className="flex size-11 shrink-0 items-center justify-center rounded-lg text-fg-secondary active:bg-hover"
        >
          <Hamburger className="size-5" />
        </button>

        <div className="min-w-0 flex-1 py-2">
          {task ? (
            <>
              <div className="truncate text-[13.5px] font-semibold tracking-[-0.01em]">{task.title}</div>
              <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <StateDot state={task.state} />
                <span>{stateWord(task)}</span>
                {task.model && (
                  <>
                    <span className="text-faint">·</span>
                    <span className="truncate font-mono">{task.model}</span>
                  </>
                )}
              </div>
            </>
          ) : (
            <div className="text-[13.5px] text-muted-foreground">No task selected</div>
          )}
        </div>

        {pullRequest?.kind === "found" && (
          <PullRequestStatusLink pullRequest={pullRequest.pullRequest} compact />
        )}
        {/* 44px hit box around a 26px trigger — the touch floor (§6b) */}
        {task && (
          <span className="flex size-11 shrink-0 items-center justify-center">
            <TaskActions task={task} />
          </span>
        )}
      </header>

      <div
        role="tablist"
        aria-label="Task surface"
        className="flex h-12 shrink-0 items-center gap-1 border-b border-border bg-surface px-1.5"
      >
        {(["chat", "changes", "terminal"] as const).map((t) => (
          <Tab key={t} size="lg" active={tab === t} onClick={() => setTab(t)}>
            {t === "chat" ? "Chat" : t === "changes" ? "Changes" : "Terminal"}
          </Tab>
        ))}
      </div>

      <main className="flex min-h-0 flex-1 flex-col">
        {/* every pane stays mounted: switching tabs must not drop the
            conversation's scroll position or tear down a live shell */}
        <Pane show={tab === "chat"}>{conversation}</Pane>
        <Pane show={tab === "changes"}>{changes}</Pane>
        <Pane show={tab === "terminal"}>{terminal}</Pane>
      </main>

      {tab !== "terminal" && (
        <div className="shrink-0" style={{ paddingBottom: "env(safe-area-inset-bottom)" }}>
          {composer}
        </div>
      )}

      <Drawer.Root open={drawer} onOpenChange={setDrawer} swipeDirection="left">
        <Drawer.Portal>
          <Drawer.Backdrop className="fixed inset-0 z-(--z-backdrop) bg-black/60" />
          <Drawer.Popup
            className={cn(
              "fixed inset-y-0 left-0 z-(--z-modal) flex w-[86vw] max-w-[340px] flex-col",
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
