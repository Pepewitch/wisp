import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react"
import { Drawer } from "@base-ui/react/drawer"
import { CleanupPanel } from "./cleanup-panel"

import { BranchRequest, ChevronLeft, Hamburger, Local, PanelBottom } from "@/components/icons"
import { StateDot } from "@/components/primitives"
import { TaskSheet } from "@/components/task-sheet"
import { TOOL_LABEL } from "@/components/tool-hints"
import { PULL_REQUEST_ICON_TONE, pullRequestIconTone } from "@/lib/pull-request-tone"
import { pullRequestWords } from "@/lib/pull-request-words"
import { useDaemonRuntime } from "@/lib/runtime"
import { outcomeWord, pausedOnNetwork, questionWaiting } from "@/lib/state"
import { TOOL_NAMES, type ToolName } from "@/lib/tools"
import type { ApiTask, PullRequestStatus, Turn } from "@/lib/types"
import { uiIntentsFor } from "@/lib/ui-intents"
import { cn } from "@/lib/utils"
import { useMobileViewport } from "@/hooks/use-mobile-viewport"
import { useSubtaskCount } from "@/hooks/useSubtasks"

/** What fills the screen below the header: the conversation, or one tool full screen. */
type Surface = "chat" | ToolName

/**
 * Below the `md` breakpoint (useIsMobile). The three-pane grid does not shrink
 * into a phone, so it is replaced rather than squeezed:
 *
 *  - the sidebar becomes a swipe-dismissable drawer, reached from one hamburger
 *  - the task is three layers (frontend §6b): a header that is the title over
 *    ONE status line, a task sheet (task-sheet.tsx) that is the summary card's
 *    rows plus the tools and the verbs, and a tool full screen with a way
 *    back to the chat
 *  - no resizable groups mount at all, so saved desktop geometry is neither
 *    applied nor overwritten by phone dimensions
 *
 * The range this shell covers is 320px to 767px — a phone AND a narrow Wisp
 * Desktop window, whose `minWidth` is 720 — so the chrome is banded: Wisp
 * Desktop's app band (below), then the task band, and nothing else above the
 * conversation.
 *
 * Two deliberate departures from the desktop language, because touch is not a
 * small mouse:
 *
 *  - drawer task rows are the TWO-LINE touch variant. The desktop row defers
 *    branch and state to a hover card, and a finger cannot hover.
 *  - the composer is pinned under the chat and every tool but the Terminal,
 *    where the shell itself is the input and a second one would fight the
 *    keyboard.
 *
 * Everything is inset for `safe-area-inset-*` so the composer clears a home
 * bar and the header clears a notch (`--safe-top`, which also clears the
 * installed iOS app's own blur).
 */
export function MobileShell({
  task,
  pullRequest,
  turns,
  sidebar,
  conversation,
  changes,
  autopilot,
  workflows,
  subtasks,
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
  /** the task's loaded turns: the sheet's clock and its `/tokens` fallback */
  turns?: Turn[]
  sidebar: (dismiss: () => void) => ReactNode
  conversation: ReactNode
  changes: ReactNode
  /**
   * The Autopilot tool (auto-merge, auto-fix and auto-review), absent on a
   * daemon without autopilot. It is handed a way back to the chat because
   * "View message" must land on a transcript that is on screen.
   */
  autopilot?: (showChat: () => void, hidden: boolean) => ReactNode
  /** Absent when the connected daemon does not support task workflows. */
  workflows?: ReactNode
  /**
   * Absent without `features.subtasks`. The sheet offers it only while the
   * task has subtasks; New subtask is one of the sheet's verbs either way.
   */
  subtasks?: ReactNode
  terminal: ReactNode
  composer: ReactNode
  /**
   * The first-run panel. When set it owns everything below the app band: there
   * is no task, so there is no sheet to open and the composer has nothing to
   * steer. The drawer stays reachable — the hamburger is the one control that
   * still means something.
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
  const { connectionId } = useDaemonRuntime()
  const [chosen, setSurface] = useState<Surface>("chat")
  const [drawer, setDrawer] = useState(false)
  const [sheet, setSheet] = useState(false)
  const viewportRef = useMobileViewport(!desktop)
  const hasSubtasks = useSubtaskCount(task?.id ?? null) > 0
  const tools = offeredTools(autopilot !== undefined, workflows !== undefined, subtasks !== undefined && hasSubtasks)
  // a tool can leave while it is open (the last subtask archived
  // elsewhere): the conversation takes over rather than an empty pane
  const surface = chosen !== "chat" && tools.includes(chosen) ? chosen : "chat"
  const showChat = () => setSurface("chat")
  useChatOnFind(surface, setSurface)

  // a task switch is always about reading the conversation next
  const [seenTask, setSeenTask] = useState(task?.id)
  if (seenTask !== task?.id) {
    setSeenTask(task?.id)
    setSurface("chat")
    setSheet(false)
  }

  return (
    <div ref={viewportRef} className={cn("mobile-shell flex h-dvh flex-col bg-background text-foreground", !desktop && "mobile-browser-shell")}>
      <header className="shrink-0 border-b border-border bg-surface" style={{ paddingTop: "var(--safe-top)" }}>
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
            {/* Same bar as the pointer shell's: no mark on Desktop, where the
                traffic lights own the corner and the connection menu names
                the daemon. The band itself stays — the drag region does not. */}
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

          {task ? (
            <TaskLines
              task={task}
              pullRequest={pullRequest}
              onOpen={() => setSheet(true)}
              onQuestion={() => {
                setSurface("chat")
                // the transcript can only scroll to the question once it is on screen
                requestAnimationFrame(() => uiIntentsFor(connectionId).focusStream())
              }}
            />
          ) : (
            <div className="min-w-0 flex-1 py-3">
              {firstRun ? (
                <div className="text-[15px] font-semibold tracking-[-0.01em]">Wisp</div>
              ) : (
                <div className="text-[14.5px] text-muted-foreground">No task selected</div>
              )}
            </div>
          )}

          {task && (
            <button
              type="button"
              onClick={() => setSheet(true)}
              aria-label="Task sheet"
              aria-haspopup="dialog"
              aria-expanded={sheet}
              className="flex size-11 shrink-0 items-center justify-center rounded-lg text-fg-secondary active:bg-hover"
            >
              <PanelBottom className="size-5" />
            </button>
          )}
        </div>
      </header>
      {connectionStatus}
      {task?.cleanup && <div className="scroll-slim max-h-[40dvh] shrink-0 overflow-y-auto border-b border-border px-3 pb-3 [&_button]:min-h-11"><CleanupPanel task={task} /></div>}

      {!firstRun && surface !== "chat" && (
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border bg-surface pr-3 pl-1">
          <button
            type="button"
            onClick={showChat}
            className="flex h-11 shrink-0 items-center gap-1 rounded-lg pr-3 pl-2 text-[14px] text-fg-secondary active:bg-hover"
          >
            <ChevronLeft aria-hidden className="size-4" />
            Chat
          </button>
          {/* Changes names itself in its own header, beside its refresh */}
          {surface !== "changes" && <span className="min-w-0 truncate text-[14px] font-medium text-foreground">{TOOL_LABEL[surface]}</span>}
        </div>
      )}

      <main className="flex min-h-0 flex-1 flex-col">
        {firstRun ?? (
          <SurfacePanes
            surface={surface}
            onShowConversation={showChat}
            surfaces={{ conversation, autopilot, changes, workflows, subtasks: hasSubtasks ? subtasks : undefined, terminal }}
          />
        )}
      </main>

      {!firstRun && surface !== "terminal" && (
        <div className="shrink-0" style={{ paddingBottom: "var(--mobile-bottom, env(safe-area-inset-bottom))" }}>
          {composer}
        </div>
      )}

      {task && !firstRun && (
        <TaskSheet
          task={task}
          pullRequest={pullRequest}
          turns={turns}
          open={sheet}
          onOpenChange={setSheet}
          tools={tools}
          onOpenTool={setSurface}
          onShowChat={showChat}
        />
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

/**
 * The task band's middle: the title over ONE status line,
 * `● Running · ⎇ #318 open · CI pending`. The whole two-line block is one
 * thumb target (a stretched button under the words): it opens the task sheet,
 * or, while a question waits, goes to the question, which the line then says
 * in amber. The sheet stays one tap away on the task button beside it.
 */
function TaskLines({ task, pullRequest, onOpen, onQuestion }: {
  task: ApiTask
  pullRequest?: PullRequestStatus
  onOpen: () => void
  onQuestion: () => void
}) {
  const waiting = task.state === "needs-input"
  const question = questionWaiting(task)
  const found = pullRequest?.kind === "found" ? pullRequest.pullRequest : null
  const words = found ? pullRequestWords(found, task.autopilot) : null
  // CI belongs on the line only while the PR is still going somewhere
  const checks = found && words && (found.lifecycle === "open" || found.lifecycle === "draft") && found.checks !== "none" ? words.checks : null
  return (
    <div className="relative flex min-h-11 min-w-0 flex-1 flex-col justify-center py-1.5">
      <button
        type="button"
        onClick={waiting ? onQuestion : onOpen}
        aria-label={waiting ? "Show the question" : "Open the task sheet"}
        className="absolute inset-0 rounded-lg active:bg-hover focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
      />
      <h1 className="pointer-events-none relative truncate text-[15px] font-semibold tracking-[-0.01em]" title={task.title}>
        {task.title}
      </h1>
      <p className="pointer-events-none relative mt-0.5 flex min-w-0 items-center gap-1.5 text-[12.5px] whitespace-nowrap text-muted-foreground">
        <StateDot state={task.state} background={task.background} pausedOnNetwork={pausedOnNetwork(task)} />
        <span className={cn("shrink-0", waiting ? "text-state-needs-input" : "text-fg-secondary")}>
          {waiting ? `Waiting for you${question ? " · 1 question" : ""}` : outcomeWord(task)}
        </span>
        {found && words && (
          <>
            <span aria-hidden className="text-faint">·</span>
            <BranchRequest aria-hidden className={cn("size-3.5 shrink-0", PULL_REQUEST_ICON_TONE[pullRequestIconTone(found)])} />
            <span className="min-w-0 truncate tabular-nums">
              #{found.number} {lowerFirst(words.lifecycle)}
              {checks && ` · ${checks}`}
            </span>
          </>
        )}
        {task.mode === "local" && (
          // Worktree is the default; LOCAL is the one worth the width (§5c)
          <span className="flex shrink-0 items-center gap-1">
            <span aria-hidden className="text-faint">·</span>
            <Local aria-hidden className="size-3" />
            Local
          </span>
        )}
        {task.archived && (
          <span className="flex shrink-0 items-center gap-1.5">
            <span aria-hidden className="text-faint">·</span>
            Archived
          </span>
        )}
      </p>
    </div>
  )
}

/** "Open" reads "#318 open" mid-line; "Merged by Wisp" keeps its proper noun. */
function lowerFirst(word: string): string {
  return word.charAt(0).toLowerCase() + word.slice(1)
}

/** Every surface's pane, all mounted: leaving one must not drop the conversation's scroll position or tear down a live shell. */
function SurfacePanes({ surface, onShowConversation, surfaces }: {
  surface: Surface
  onShowConversation: () => void
  surfaces: {
    conversation: ReactNode
    autopilot?: (showConversation: () => void, hidden: boolean) => ReactNode
    changes: ReactNode
    workflows?: ReactNode
    subtasks?: ReactNode
    terminal: ReactNode
  }
}) {
  const { conversation, autopilot, changes, workflows, subtasks, terminal } = surfaces
  return (
    <>
      <Pane show={surface === "chat"}>{conversation}</Pane>
      {autopilot && <Pane show={surface === "autopilot"}>{autopilot(onShowConversation, surface !== "autopilot")}</Pane>}
      <Pane show={surface === "changes"}>{changes}</Pane>
      {workflows !== undefined && <Pane show={surface === "workflows"}>{workflows}</Pane>}
      {subtasks !== undefined && <Pane show={surface === "subtasks"}>{subtasks}</Pane>}
      <Pane show={surface === "terminal"}><div className="flex min-h-0 flex-1 flex-col pb-(--mobile-bottom)">{terminal}</div></Pane>
    </>
  )
}

/** The tools the sheet offers, in the top bar's order. */
function offeredTools(autopilot: boolean, workflows: boolean, subtasks: boolean): ToolName[] {
  return TOOL_NAMES.filter(
    (name) =>
      (name !== "autopilot" || autopilot) &&
      (name !== "workflows" || workflows) &&
      (name !== "subtasks" || subtasks),
  )
}

/**
 * Find-in-task searches the transcript, which the Autopilot tool hides: a
 * find from anywhere (⌘F on a narrow Desktop window) gives the chat back
 * first. The find has already run against a hidden transcript by then, where
 * nothing can scroll, so it is asked again once the chat is on screen — the
 * same frame the Autopilot tool's own "View message" waits. The sheet's Find
 * tile brings the chat back itself, before it asks.
 */
function useChatOnFind(surface: Surface, setSurface: (surface: Surface) => void) {
  const { connectionId } = useDaemonRuntime()
  const intents = uiIntentsFor(connectionId)
  const findSeq = useSyncExternalStore(intents.subscribe, () => intents.findRequest()?.seq ?? 0)
  const seenFind = useRef(findSeq)
  useEffect(() => {
    if (findSeq === seenFind.current) return
    seenFind.current = findSeq
    if (surface !== "autopilot") return
    const request = intents.findRequest()
    setSurface("chat")
    if (request) requestAnimationFrame(() => intents.openFind(request.query, request.turn))
  }, [findSeq, surface, setSurface, intents])
}

/** Kept mounted, hidden when inactive — see the note in MobileShell. */
function Pane({ show, children }: { show: boolean; children: ReactNode }) {
  return (
    <div className={cn("min-h-0 flex-1 flex-col", show ? "flex" : "hidden")} aria-hidden={!show}>
      {children}
    </div>
  )
}
