import { ArrowUp, Stop } from "@/components/icons"
import { TaskIdentity } from "@/components/steer-box-overlays"
import { SuffixPromptPicker } from "@/components/suffix-prompt-picker"
import {
  TaskAgentPicker,
  type TaskAgentChoice,
} from "@/components/task-agent-picker"
import { backgroundNames } from "@/lib/state"
import type { ApiTask, HarnessInfo } from "@/lib/types"
import { cn } from "@/lib/utils"

/**
 * The composer's control bar: who will answer, what rides along with the
 * draft, and the one violet button on the screen.
 *
 * Four things want one row, and the row is often not wide enough: a phone, a
 * dragged-in centre pane, and — the case a media query would never catch —
 * Desktop's zoom, which leaves the window alone and shrinks every pane in CSS
 * pixels. So the bar answers ITS OWN width (§5c-ii), in two steps, and both
 * things that yield are things the task header two rows up still says.
 *
 *   always       suffix · send
 *   @lg  512px   + harness · model · effort, which truncates before it wraps
 *   @2xl 672px   + the ↵ hint
 *
 * `touch` is a different question — how big a thumb is, not how wide the bar
 * is — and it answers with ONE row of 44px targets: the model, the effort
 * glyph, the suffix glyph, the send. An optional control at its
 * default is a glyph; choosing a value brings the value back as text. Only the
 * model chip yields width, because the task header still names it in full.
 */
export function ComposerControls({
  task,
  taskId,
  suffixPromptId,
  blocked,
  sending,
  disabled,
  canSend,
  canStop,
  touch,
  harnesses,
  canSwitchAgent,
  agentChoice,
  onSuffixPromptChange,
  onAgentChange,
  onSend,
  onStop,
}: {
  task: ApiTask | null
  taskId: string | null
  suffixPromptId: string | null
  blocked: boolean
  sending: boolean
  disabled: boolean
  canSend: boolean
  canStop: boolean
  touch: boolean
  harnesses: HarnessInfo[]
  canSwitchAgent: boolean
  agentChoice: TaskAgentChoice | null
  onSuffixPromptChange: (value: string | null) => void
  onAgentChange: (choice: TaskAgentChoice) => void
  onSend: () => void
  onStop: () => void
}) {
  const backgroundOnly = Boolean(
    !blocked && task?.background && task.background.state !== "none"
  )
  // Name the programs here too: this note sits beside the Stop button, which
  // is the moment the reader has to decide whether stopping is safe.
  const running = backgroundNames(task?.background)
  const picker = Boolean(task && agentChoice && canSwitchAgent && harnesses.length > 0)
  return (
    <div className={touch ? "mt-1" : "mt-2"}>
      <div className={cn("flex items-center", touch ? "gap-1" : "gap-2")}>
        {picker && agentChoice ? (
          // the extra right margin on touch is the hairline's job done quietly:
          // who answers on one side, what to send on the other
          <span className={cn("flex min-w-0 items-center gap-1", touch && "mr-1.5")}>
            <TaskAgentPicker
              harnesses={harnesses}
              value={agentChoice}
              disabled={disabled || sending}
              touch={touch}
              onChange={onAgentChange}
            />
          </span>
        ) : task ? (
          // identity and the hairline that separates it from the actions
          // arrive together at @lg, or not at all — a lone divider against the
          // left edge is a rule with nothing on either side of it
          <span className="hidden min-w-0 items-center gap-2 @lg:flex">
            <TaskIdentity task={task} />
            <Hairline />
          </span>
        ) : null}
        {/* A phone gets no hairline: the chips beside it are already spaced
            for fingers, and one more mark is one more thing to read. */}
        {picker && !touch && <Hairline />}
        <SuffixPromptPicker
          key={taskId ?? "no-task"}
          value={suffixPromptId}
          onValueChange={onSuffixPromptChange}
          disabled={disabled || sending}
          touch={touch}
        />
        <span className="flex-1" />
        {!touch && <WideEnd />}
        <SendButton
          blocked={blocked}
          backgroundOnly={backgroundOnly}
          running={running}
          canSend={canSend}
          canStop={canStop}
          touch={touch}
          onSend={onSend}
          onStop={onStop}
        />
      </div>
    </div>
  )
}

/** The bar's one separator: what will answer on the left, what to send on the right. */
function Hairline() {
  return <span aria-hidden className="h-3 w-px shrink-0 bg-border-strong" />
}

/**
 * What the widest arrangement puts beside the button: the note if there is
 * one, otherwise the keyboard hint. Never on touch, where there is no keyboard
 * to hint at and no width to spend on it.
 */
function WideEnd() {
  return (
    <span
      className="hidden shrink-0 font-mono text-[10.5px] text-faint @2xl:block"
      title="Enter sends · Shift+Enter for a new line"
    >
      ↵
    </span>
  )
}

/**
 * Send, or stop what is running. One button, because at any moment exactly one
 * of them is the thing to do — and its title says what stopping costs, since
 * this is where the reader decides whether it is safe.
 */
function SendButton({
  blocked,
  backgroundOnly,
  running,
  canSend,
  canStop,
  touch,
  onSend,
  onStop,
}: {
  blocked: boolean
  backgroundOnly: boolean
  running: string | null
  canSend: boolean
  canStop: boolean
  touch: boolean
  onSend: () => void
  onStop: () => void
}) {
  const stopName = backgroundOnly ? "Stop background work" : "Stop turn"
  const stopTitle = backgroundOnly
    ? `Stop this task's background work${running ? ` (${running})` : ""}; keep the completed result`
    : "Stop the running turn and background work; the session is kept"
  const sendTitle = blocked
    ? "Send at a safe boundary, or queue for the next turn"
    : "Send"
  return (
    <button
      type="button"
      onClick={canStop ? onStop : onSend}
      disabled={!canStop && !canSend}
      aria-label={canStop ? stopName : blocked ? "Send safely" : "Send"}
      title={canStop ? stopTitle : sendTitle}
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full transition-all",
        "focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
        // the touch floor is the hit box, not the glyph (§6b)
        touch ? "size-11 active:scale-95" : "size-[26px]",
        canSend
          ? "bg-primary text-primary-foreground hover:bg-primary-hover"
          : canStop
            ? "border border-border-strong bg-card text-foreground hover:bg-hover"
            : "bg-border-strong text-muted-foreground"
      )}
    >
      {canStop ? (
        <Stop className={touch ? "size-[18px]" : "size-3.5"} />
      ) : (
        <ArrowUp className={touch ? "size-[18px]" : "size-3.5"} />
      )}
    </button>
  )
}
