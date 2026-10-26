import { ChevronDown, Local } from "@/components/icons"
import { MenuItem, MenuSeparator } from "@/components/menu"
import { StateDot } from "@/components/primitives"
import { ParentCrumb } from "@/components/subtask-crumb"
import { TaskActions } from "@/components/task-actions"
import { writeClipboardText } from "@/lib/clipboard"
import { pausedOnNetwork, stateWord } from "@/lib/state"
import { baseWords } from "@/lib/subtask-words"
import { cn } from "@/lib/utils"
import type { ApiTask } from "@/lib/types"
import type { ReactNode } from "react"

/**
 * The top bar's task: which task this is, and the verbs that act on it. It
 * replaced the centre column's two-line header, so the conversation starts at
 * the top of the pane (frontend §5h).
 *
 * `● Title ⌄` is ONE control: the dot, the title and the chevron open the
 * title menu, which holds the old `⋯` menu's verbs under the facts you rarely
 * need in view (id, branch, harness · model · effort). A subtask leads with
 * `Parent ›`; Local and Archived follow as quiet words, only when true.
 *
 * Where the pane is too narrow for the summary card, its chip follows the
 * title (`chip`), and the dot moves into it: one quick look per fact.
 *
 * On Desktop the bar is the window's drag region. Tauri drags only on an
 * element that carries `data-tauri-drag-region` itself, never on its children,
 * so every non-interactive box here carries it too and every control does not.
 */
export function TopBarTask({
  task,
  chip,
  dragRegion,
}: {
  task: ApiTask | null
  /** the summary card folded into the bar (task-summary-chip.tsx), when the shell draws it */
  chip?: ReactNode
  dragRegion: boolean
}) {
  const drag = dragRegion ? "" : undefined
  if (!task) return <span data-tauri-drag-region={drag} className="h-full min-w-0 flex-1" />
  const facts = titleMenuFacts(task, stateWord(task))
  return (
    <div data-tauri-drag-region={drag} className="flex h-full min-w-0 flex-1 items-center gap-2">
      <ParentCrumb task={task} dragRegion={dragRegion} />
      <h1 className="flex min-w-0 shrink items-center">
        <TaskActions
          task={task}
          title={{
            trigger: (
              <>
                {!chip && <StateDot state={task.state} background={task.background} pausedOnNetwork={pausedOnNetwork(task)} />}
                <span className="min-w-0 truncate">{task.title}</span>
                {/* wrapped, so the trigger's `[&>svg]` sizing leaves the chevron alone */}
                <span className="flex shrink-0 items-center">
                  <ChevronDown aria-hidden className="size-3 text-faint" />
                </span>
              </>
            ),
            className: "-ml-1.5 min-w-0 shrink gap-2 px-1.5 text-[13px] font-semibold tracking-[-0.005em] text-foreground data-[popup-open]:bg-hover",
            header: <TitleMenuFacts lines={facts} />,
            // the lines are a column on screen, but one run of words to a screen reader
            headerLabel: facts.map((line) => line.text).join(", "),
            after: <CopyRows task={task} />,
          }}
        />
      </h1>
      {chip}
      {task.mode === "local" && (
        // Worktree is the default and the wisp/… branch already says so; LOCAL
        // is the one worth the width, because this task edits your checkout.
        <span data-tauri-drag-region={drag} className="flex shrink-0 items-center gap-1 text-[11.5px] text-muted-foreground" title="This task works in the project checkout, not a worktree">
          <Local aria-hidden className="pointer-events-none size-3" />
          <span className="pointer-events-none">Local</span>
        </span>
      )}
      {task.archived && (
        <span data-tauri-drag-region={drag} className="shrink-0 text-[11.5px] text-muted-foreground">
          Archived
        </span>
      )}
      <span data-tauri-drag-region={drag} className="h-full min-w-4 flex-1" />
    </div>
  )
}

/**
 * The bar's left end answers WHICH DAEMON: the mark in the browser, the
 * connection tabs on Desktop (whose traffic lights own the first 80px). It is
 * at least the sidebar's width (`--sidebar-width`), so the task's title starts
 * over the column it names, and at most 40% of the bar, so a Desktop with
 * four long connection names cannot push the title out: the tab strip
 * scrolls inside it (`ConnectionTabList`). Where the sidebar is wider
 * than 40%, the sidebar's width wins.
 */
export function TopBarLeft({ desktop, children }: { desktop: boolean; children: ReactNode }) {
  return (
    <div
      data-tauri-drag-region={desktop ? "" : undefined}
      className={cn(
        "flex h-full max-w-[40%] min-w-(--sidebar-width) shrink-0 items-center gap-2.5 border-r border-border pr-3",
        desktop ? "pl-20" : "pl-3",
      )}
    >
      {children}
    </div>
  )
}

/** The facts the old header's meta line carried, on demand: id and branch, who works on it, and a subtask's kind and base. */
function titleMenuFacts(task: ApiTask, word: string): { text: string; mono?: boolean }[] {
  const base = task.subtask_kind ? baseWords(task) : null
  return [
    { text: [task.id, task.branch].filter(Boolean).join(" · "), mono: true },
    { text: [word, task.harness, task.model, task.effort && `${task.effort} effort`].filter(Boolean).join(" · ") },
    ...(task.subtask_kind ? [{ text: `${task.subtask_kind} subtask${base ? ` · from ${base}` : ""}` }] : []),
  ]
}

/** The facts, one line each. Selectable, so a branch can be copied by hand too. */
function TitleMenuFacts({ lines }: { lines: { text: string; mono?: boolean }[] }) {
  return (
    <div className="flex max-w-[360px] flex-col gap-0.5 text-[11px] leading-normal text-muted-foreground select-text">
      {lines.map((line) => (
        <span key={line.text} className={cn("truncate", line.mono && "font-mono text-fg-secondary")}>
          {line.text}
        </span>
      ))}
    </div>
  )
}

function CopyRows({ task }: { task: ApiTask }) {
  // a refused clipboard (no focus, no permission) has nothing to undo; the menu closes either way
  const copy = (text: string) => void writeClipboardText(text).catch(() => undefined)
  return (
    <>
      <MenuSeparator />
      <MenuItem onClick={() => copy(task.id)}>Copy task id</MenuItem>
      {task.branch && <MenuItem onClick={() => copy(task.branch!)}>Copy branch name</MenuItem>}
    </>
  )
}
