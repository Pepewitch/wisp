import { useCallback, useEffect, useRef, useState, type RefObject } from "react"

import { ArchiveConfirmDialog } from "@/components/archive-flow"
import { FreshContextDialog } from "@/components/fresh-context-dialog"
import { PendingAttachmentRows } from "@/components/pending-attachments"
import { SteerOverlays } from "@/components/steer-box-overlays"
import { ComposerControls } from "@/components/steer-controls"
import { type TaskAgentChoice } from "@/components/task-agent-picker"
import {
  useSteerCommands,
  type ReportState,
  type SteerNote,
} from "@/hooks/useSteerCommands"
import {
  useSteerSubmit,
  type AgentSubmission,
} from "@/hooks/useSteerSubmit"
import { useAutosizeTextarea } from "@/hooks/useAutosizeTextarea"
import { hasCoarsePointer } from "@/hooks/useMediaQuery"
import { useTaskAgentSelection } from "@/hooks/useTaskAgentSelection"
import {
  useDesktopPendingAttachments,
  useRememberedDraft,
} from "@/hooks/useRememberedDesktopInput"
import {
  type AttachmentPayload,
  type PendingAttachments,
} from "@/lib/attachments"
import { handleComposerPaste } from "@/lib/paste-links"
import {
  compactEntry,
  isTier1Command,
  slashTokenAt,
  TIER1_ENTRIES,
  tier2Entries,
  tier3Entries,
  type SlashEntry,
  type SlashGroup,
  type SlashToken,
} from "@/lib/slash"
import type {
  ApiTask,
  HarnessCompact,
  HarnessInfo,
  ProbeCommandName,
  StatusEntry,
  TaskSkills,
  Turn,
} from "@/lib/types"
import { cn } from "@/lib/utils"

/**
 * The centre column's footer. Grows with the text, caps at 40% of the pane,
 * and keeps the send affordance on one quiet row — `steer-controls.tsx` owns
 * that row and how it answers its own width and a thumb.
 *
 * It owns three things beyond the textarea:
 *
 *  - the `/` palette (A2) — a real keyboard picker, bound to the slash token
 *    under the caret. The palette never deletes what you typed; only PICKING
 *    an item consumes the token.
 *  - Tier-1 dispatch — the wisp-native commands, every write through the hooks
 *    in hooks/mutations.ts.
 *  - the send itself, including its refusals. A refused send used to vanish
 *    into the mutation object: the draft was kept (right) and the reason was
 *    dropped (wrong), so the user lost nothing and learnt nothing.
 *
 * Compact command answers use one note row; larger context and usage reports
 * use one dismissible panel. Both are keyed to the task that produced them, so
 * switching tasks never shows task A's answer under task B.
 */
interface SteerBoxProps {
  task: ApiTask | null
  hasImage?: boolean
  imageNote?: string
  status?: StatusEntry
  turns?: Turn[]
  probeCommands?: ProbeCommandName[]
  skills?: TaskSkills
  compact?: HarnessCompact | null
  harnesses?: HarnessInfo[]
  /** Daemon feature flag; absent on an older daemon, whose /send would ignore a switch. */
  canSwitchAgent?: boolean
  onSend?: (
    message: string,
    attachments?: AttachmentPayload[],
    suffixPromptId?: string,
    agent?: AgentSubmission
  ) => Promise<void> | void
  onInterrupt?: () => Promise<void> | void
  runningSince?: string | null
  touch?: boolean
}

export function SteerBox({
  task,
  hasImage = true,
  imageNote,
  status,
  turns,
  probeCommands,
  skills,
  compact,
  harnesses = [],
  canSwitchAgent = false,
  onSend,
  onInterrupt,
  runningSince = null,
  touch = false,
}: SteerBoxProps) {
  const [value, setValue] = useRememberedDraft(task?.id ?? null)
  const [sending, setSending] = useState(false)
  const [note, setNote] = useState<SteerNote | null>(null)
  const initialTaskId = task?.id ?? null
  const [suffixSelection, setSuffixSelection] = useState<SuffixSelection>({
    taskId: initialTaskId,
    value: null,
  })
  const agent = useTaskAgentSelection(task, harnesses)
  const { taskId, suffixPromptId, disabled, blocked, canSend, canStop, shown } =
    steerState({
      task,
      value,
      sending,
      note,
      suffixSelection,
    })
  // A draft may survive a task switch, but a reusable instruction must be
  // chosen deliberately for the task that will receive it.
  if (suffixSelection.taskId !== taskId) {
    setSuffixSelection({ taskId, value: null })
  }
  /** the slash token the palette is bound to; null = closed */
  const [palette, setPalette] = useState<SlashToken | null>(null)
  /** One task-keyed report: either a harness probe or Wisp's task-level tokens. */
  const [report, setReport] = useState<ReportState>(null)
  const dismissReport = useCallback(() => setReport(null), [])

  const box = useRef<HTMLTextAreaElement>(null)
  const command = useRef<HTMLDivElement>(null)
  /** where the caret goes after a pick rewrote the draft */
  const caret = useRef<number | null>(null)
  /**
   * The token start a dismissal applies to. Escape has to mean "leave me
   * alone": without this, the very next keystroke inside `/st` would reopen the
   * list the user just closed.
   */
  const suppressed = useRef<number | null>(null)

  const attachments = useDesktopPendingAttachments({
    taskId,
    harness: agent.choice?.harness ?? task?.harness ?? null,
    hasImage: agent.selectedHarness?.hasImage ?? hasImage,
    imageNote: agent.selectedHarness?.imageNote ?? imageNote,
  })
  const commands = useSteerCommands({ task, status, setNote, setReport })
  const archive = commands.archive

  useEffect(() => {
    const pos = caret.current
    if (pos === null) return
    caret.current = null
    box.current?.focus()
    box.current?.setSelectionRange(pos, pos)
  })

  const { send: submit, stop } = useSteerSubmit({
    task,
    canSend,
    canStop,
    value,
    suffixPromptId,
    attachments,
    onSend,
    onInterrupt,
    onSent: (taskId) => setSuffixSelection({ taskId, value: null }),
    setValue,
    setSending,
    setNote,
    setPalette,
  })
  const send = () => agent.requestSend(submit)

  /** Recompute what the caret is sitting in. The one place the palette opens. */
  const track = (value: string, at: number | null) => {
    if (disabled) return
    const token = at === null ? null : slashTokenAt(value, at)
    if (!token) {
      // the token is gone, so the dismissal that suppressed it is spent
      suppressed.current = null
      setPalette(null)
      return
    }
    if (suppressed.current === token.start) {
      setPalette(null)
      return
    }
    setPalette(token)
  }

  const dismiss = () => {
    if (palette) suppressed.current = palette.start
    setPalette(null)
  }

  const pick = (entry: SlashEntry) => {
    const token = palette
    setPalette(null)
    if (!token || !task) return
    const tier1Command = isTier1Command(entry.name) ? entry.name : null
    if (tier1Command || entry.probe || entry.compact) {
      // a wisp command, a probe, or a compaction is not text the harness
      // should ever see: the token is consumed and whatever surrounded it is
      // left as typed
      setValue(value.slice(0, token.start) + value.slice(token.end))
      caret.current = token.start
      suppressed.current = null
      if (entry.probe) commands.probe(entry.probe)
      else if (entry.compact) commands.compact()
      else if (tier1Command) commands.dispatch(tier1Command)
      return
    }
    // Tier 3 is prompt text the harness honors, and a skill may take arguments:
    // prefill WITHOUT sending, and let the user review what costs a turn. The
    // text is the entry's own — `/name` on slash harnesses, a plain-text ask
    // on codex, which has no headless slash surface (SP2).
    const text = entry.prefill ?? `/${entry.name}`
    setValue(value.slice(0, token.start) + text + value.slice(token.end))
    caret.current = token.start + text.length
    suppressed.current = token.start
  }

  const groups = slashGroups(task, probeCommands, skills, compact)
  const shownReport =
    report && task && report.taskId === task.id ? report : null

  return (
    <div
      className={cn(
        // @container, not a media query: Desktop's zoom shrinks this pane in
        // CSS pixels without touching the window, and a dragged divider does
        // the same. The bar has to answer the space it actually has.
        "@container relative shrink-0 bg-gradient-to-t from-background from-60% to-transparent",
        touch ? "px-3 pt-2 pb-2.5" : "px-4.5 pt-2.5 pb-3.5"
      )}
    >
      {/* Palette and reports share the composer's content width, not the
          wider footer outside its responsive padding. */}
      <div className="relative">
        <SteerOverlays
          shownReport={shownReport}
          task={task}
          turns={turns}
          onDismissReport={dismissReport}
          palette={palette}
          groups={groups}
          onPick={pick}
          commandRef={command}
          touch={touch}
          runningSince={runningSince}
          note={shown}
        />

        <SteerComposer
          task={task}
          taskId={taskId}
          value={value}
          disabled={disabled}
          blocked={blocked}
          sending={sending}
          canSend={canSend}
          canStop={canStop}
          touch={touch}
          palette={palette}
          reportOpen={shownReport !== null}
          suffixPromptId={suffixPromptId}
          boxRef={box}
          caretRef={caret}
          commandRef={command}
          attachments={attachments}
          harnesses={harnesses}
          canSwitchAgent={canSwitchAgent}
          agentChoice={agent.choice}
          onValueChange={setValue}
          onTrack={track}
          onDismissPalette={dismiss}
          onDismissReport={dismissReport}
          onSuffixPromptChange={(value) =>
            setSuffixSelection({ taskId, value })
          }
          onAgentChange={agent.setChoice}
          onSend={send}
          onStop={stop}
        />
      </div>

      {task && (
        <>
          <ArchiveConfirmDialog
            task={task}
            reason={archive.reason}
            pending={archive.pending}
            onCancel={archive.dismiss}
            onForce={() => archive.request(true)}
          />
          {agent.choice && (
            <FreshContextDialog
              choice={agent.choice}
              open={agent.confirmFresh}
              pending={sending}
              onCancel={agent.cancel}
              onConfirm={() => agent.confirm(submit)}
            />
          )}
        </>
      )}
    </div>
  )
}

interface SuffixSelection {
  taskId: string | null
  value: string | null
}

function steerState({
  task,
  value,
  sending,
  note,
  suffixSelection,
}: {
  task: ApiTask | null
  value: string
  sending: boolean
  note: SteerNote | null
  suffixSelection: SuffixSelection
}) {
  const taskId = task?.id ?? null
  const suffixPromptId =
    suffixSelection.taskId === taskId ? suffixSelection.value : null
  const disabled = !task || task.archived || task.state === "creating"
  // A stuck task still owns a live turn; it must stop/steer like running,
  // rather than offering a send the daemon will reject.
  const blocked = task?.state === "running" || task?.state === "stuck"
  const hasMessage = value.trim().length > 0
  const canSend = hasMessage && !disabled && !sending
  const hasBackground = task?.background && task.background.state !== "none"
  const canStop = (blocked || hasBackground) && !hasMessage && !disabled && !sending
  const shown = note && task && note.taskId === task.id ? note : null
  return { taskId, suffixPromptId, disabled, blocked, canSend, canStop: Boolean(canStop), shown }
}

function slashGroups(
  task: ApiTask | null,
  probeCommands: ProbeCommandName[] | undefined,
  skills: TaskSkills | undefined,
  compact: HarnessCompact | null | undefined
): SlashGroup[] {
  const groups: SlashGroup[] = [{ label: "Wisp", entries: TIER1_ENTRIES }]
  if (task) {
    groups.push({
      label: task.harness,
      entries: [...tier2Entries(probeCommands), ...compactEntry(compact)],
    })
  }
  const skillGroup: SlashGroup = {
    label: "Skills",
    entries: tier3Entries(skills?.skills, skills?.invoke),
    costsTurn: true,
  }
  if (skills?.errors.length) {
    skillGroup.footer = `${skills.errors.length} skill${skills.errors.length === 1 ? "" : "s"} skipped by the harness`
    skillGroup.footerTitle = skills.errors.join("\n")
  } else if (skills?.partialNote) {
    skillGroup.footer = skills.partialNote
  }
  groups.push(skillGroup)
  return groups
}

function SteerComposer({
  task,
  taskId,
  value,
  disabled,
  blocked,
  sending,
  canSend,
  canStop,
  touch,
  palette,
  reportOpen,
  suffixPromptId,
  boxRef,
  caretRef,
  commandRef,
  attachments,
  harnesses,
  canSwitchAgent,
  agentChoice,
  onValueChange,
  onTrack,
  onDismissPalette,
  onDismissReport,
  onSuffixPromptChange,
  onAgentChange,
  onSend,
  onStop,
}: {
  task: ApiTask | null
  taskId: string | null
  value: string
  disabled: boolean
  blocked: boolean
  sending: boolean
  canSend: boolean
  canStop: boolean
  touch: boolean
  palette: SlashToken | null
  reportOpen: boolean
  suffixPromptId: string | null
  boxRef: RefObject<HTMLTextAreaElement | null>
  caretRef: RefObject<number | null>
  commandRef: RefObject<HTMLDivElement | null>
  attachments: PendingAttachments
  harnesses: HarnessInfo[]
  canSwitchAgent: boolean
  agentChoice: TaskAgentChoice | null
  onValueChange: (value: string) => void
  onTrack: (value: string, caret: number | null) => void
  onDismissPalette: () => void
  onDismissReport: () => void
  onSuffixPromptChange: (value: string | null) => void
  onAgentChange: (choice: TaskAgentChoice) => void
  onSend: () => void
  onStop: () => void
}) {
  const [focused, setFocused] = useState(false)
  // The mobile shell also covers a narrow Desktop window, so "is this sized
  // for a thumb" and "is the Return key a soft one" are two questions.
  const softKeyboard = touch && hasCoarsePointer()
  useAutosizeTextarea(boxRef, value)
  return (
    <div
      className={cn(
        "border bg-surface transition-colors",
        // a softer, roomier sheet under a thumb; the pointer box is unchanged
        touch ? "rounded-2xl px-2.5 pt-2 pb-1.5" : "rounded-xl px-3 pt-2.5 pb-2",
        focused
          ? "border-accent-dim ring-2 ring-ring/15"
          : "border-border-strong"
      )}
    >
      <textarea
        ref={boxRef}
        rows={touch ? 2 : 3}
        value={value}
        disabled={disabled}
        onChange={(event) => {
          onValueChange(event.target.value)
          onTrack(event.target.value, event.target.selectionStart)
        }}
        onKeyUp={(event) =>
          onTrack(event.currentTarget.value, event.currentTarget.selectionStart)
        }
        onClick={(event) =>
          onTrack(event.currentTarget.value, event.currentTarget.selectionStart)
        }
        onPaste={(event) =>
          handleComposerPaste(event, {
            onImagePaste: attachments.onPaste,
            value,
            onChange: (next, pos) => {
              caretRef.current = pos
              onValueChange(next)
              onTrack(next, pos)
            },
          })
        }
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyDown={(event) => {
          if (palette && !event.nativeEvent.isComposing) {
            if (event.key === "Escape") {
              event.preventDefault()
              onDismissPalette()
              return
            }
            if (PALETTE_KEYS.has(event.key) && !event.shiftKey) {
              event.preventDefault()
              commandRef.current?.dispatchEvent(
                new KeyboardEvent("keydown", { key: event.key, bubbles: true })
              )
              return
            }
          }
          if (event.key === "Escape" && reportOpen) {
            event.preventDefault()
            onDismissReport()
            return
          }
          if (event.key !== "Enter" || event.shiftKey) return
          if (
            event.nativeEvent.isComposing &&
            !(event.metaKey || event.ctrlKey)
          )
            return
          // A soft keyboard's Return is a newline: there is no Shift to hold,
          // the send is a 44px button an inch away, and a stray Return firing
          // a half-written prompt costs a turn. ⌘/Ctrl+Return still sends, for
          // a phone with a keyboard attached.
          if (softKeyboard && !(event.metaKey || event.ctrlKey)) return
          event.preventDefault()
          onSend()
        }}
        placeholder={
          disabled
            ? "This task is read-only"
            : "Ask for changes, or / for commands"
        }
        // the Return key draws itself as what it does here
        enterKeyHint={softKeyboard ? "enter" : undefined}
        className={cn(
          "max-h-[40vh] w-full resize-none scroll-slim bg-transparent leading-relaxed",
          "text-foreground placeholder:text-faint focus:outline-none",
          // A short floor on touch: the box grows into the draft, and the room
          // it does not need yet belongs to the transcript, which the keyboard
          // has already taken half of.
          touch ? "min-h-11 text-[15px]" : "min-h-[52px] text-[12.5px]"
        )}
      />
      <ComposerControls
        task={task}
        taskId={taskId}
        suffixPromptId={suffixPromptId}
        blocked={blocked}
        sending={sending}
        disabled={disabled}
        canSend={canSend}
        canStop={canStop}
        touch={touch}
        attachments={attachments}
        harnesses={harnesses}
        canSwitchAgent={canSwitchAgent}
        agentChoice={agentChoice}
        onSuffixPromptChange={onSuffixPromptChange}
        onAgentChange={onAgentChange}
        onSend={onSend}
        onStop={onStop}
      />
      <PendingAttachmentRows pending={attachments} touch={touch} />
    </div>
  )
}

/** Forwarded to cmdk while the palette is open; Enter must not send. */
const PALETTE_KEYS = new Set(["ArrowDown", "ArrowUp", "Home", "End", "Enter"])
