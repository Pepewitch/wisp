import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react"

import { ArchiveConfirmDialog } from "@/components/archive-flow"
import { ArrowUp, Check, Copy, Stop } from "@/components/icons"
import { AttachButton, PendingAttachmentRows } from "@/components/pending-attachments"
import { Meta, StateDot } from "@/components/primitives"
import { ProbePanel } from "@/components/probe-panel"
import { SlashPalette } from "@/components/slash-palette"
import { SuffixPromptPicker } from "@/components/suffix-prompt-picker"
import { TokensPanel } from "@/components/tokens-panel"
import {
  useSteerCommands,
  type ReportState,
  type SteerNote,
} from "@/hooks/useSteerCommands"
import { useSteerSubmit } from "@/hooks/useSteerSubmit"
import { useTick } from "@/hooks/useTick"
import { usePendingAttachments, type AttachmentPayload, type PendingAttachments } from "@/lib/attachments"
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
import { elapsed } from "@/lib/state"
import type {
  ApiTask,
  HarnessCompact,
  ProbeCommandName,
  StatusEntry,
  TaskSkills,
  Turn,
} from "@/lib/types"
import { cn } from "@/lib/utils"

/**
 * The centre column's footer. Grows with the text, caps at 40% of the pane, and
 * keeps the send affordance on one quiet row: which agent will answer, the
 * paperclip, the shortcut, and the one violet button on the screen.
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
export function SteerBox({
  task,
  hasImage = true,
  imageNote,
  status,
  turns,
  probeCommands,
  skills,
  compact,
  onSend,
  onInterrupt,
  runningSince = null,
  touch = false,
}: {
  task: ApiTask | null
  hasImage?: boolean
  /** the harness's delivery caveat, shown while images are pending (A1c) */
  imageNote?: string
  /** the task's /api/status entry — the git half of `/status`'s note */
  status?: StatusEntry
  /** the task's turns — the numbers `/tokens` reports from (Theme B) */
  turns?: Turn[]
  /**
   * The task's harness's declared out-of-turn reads (A3) — the palette's
   * Tier 2. Undefined/empty renders no Tier-2 group, which is also the honest
   * state while /api/harnesses is still loading.
   */
  probeCommands?: ProbeCommandName[]
  /**
   * The harness's own skill registry (A4) — the palette's Tier 3. Undefined
   * while loading or after a refusal (a running turn), and the group is
   * absent rather than populated with anything stale or invented.
   */
  skills?: TaskSkills
  /**
   * The task's harness's compaction (A5) — one entry in the harness's group:
   * a prefill when the harness compacts as an ordinary turn (claude), an
   * out-of-band dispatch when the daemon runs it (droid/codex), absent when
   * the harness honestly has none.
   */
  compact?: HarnessCompact | null
  /**
   * Injectable send, for tests and the gallery. Left out, the box posts through
   * `useSendMessage` itself, which is what lets a refusal land in its own note
   * instead of nowhere.
   */
  onSend?: (message: string, attachments?: AttachmentPayload[], suffixPromptId?: string) => Promise<void> | void
  /** Injectable interrupt for tests and the gallery; production posts through useInterruptTask. */
  onInterrupt?: () => Promise<void> | void
  /** started_at of the turn running right now; null when nothing is running */
  runningSince?: string | null
  /** thumb-sized controls and larger type below the md breakpoint */
  touch?: boolean
}) {
  const [value, setValue] = useState("")
  const [sending, setSending] = useState(false)
  const [note, setNote] = useState<SteerNote | null>(null)
  const [copied, setCopied] = useState(false)
  const initialTaskId = task?.id ?? null
  const [suffixSelection, setSuffixSelection] = useState<SuffixSelection>({
    taskId: initialTaskId,
    value: null,
  })
  const { taskId, suffixPromptId, disabled, blocked, canSend, canStop, shown } = steerState({
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

  const attachments = usePendingAttachments({ harness: task?.harness ?? null, hasImage, imageNote })
  const commands = useSteerCommands({ task, status, setNote, setReport })
  const archive = commands.archive

  useEffect(() => {
    const pos = caret.current
    if (pos === null) return
    caret.current = null
    box.current?.focus()
    box.current?.setSelectionRange(pos, pos)
  })

  const { send, stop } = useSteerSubmit({
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
  const shownReport = report && task && report.taskId === task.id ? report : null

  return (
    <div
      className={cn(
        "relative shrink-0 bg-gradient-to-t from-background from-60% to-transparent",
        touch ? "px-3 pt-2 pb-2.5" : "px-4.5 pt-2.5 pb-3.5",
      )}
    >
      {/* Palette and reports share the composer's content width, not the
          wider footer outside its responsive padding. */}
      <div className="relative">
        {shownReport?.kind === "probe" && task && (
          <ProbePanel
            harness={task.harness}
            command={shownReport.command}
            answer={shownReport.answer}
            onClose={dismissReport}
            className="absolute inset-x-0 bottom-full z-(--z-menu) mb-1.5"
          />
        )}

        {shownReport?.kind === "tokens" && task && (
          <TokensPanel
            harness={task.harness}
            turns={turns}
            onClose={dismissReport}
            className="absolute inset-x-0 bottom-full z-(--z-menu) mb-1.5"
          />
        )}

        {palette && task && (
          <SlashPalette
            groups={groups}
            query={palette.query}
            onPick={pick}
            commandRef={command}
            touch={touch}
          />
        )}

        {runningSince && <RunningFor startedAt={runningSince} />}

        {shown && <SteerNoteRow note={shown} copied={copied} onCopied={setCopied} />}

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
          onValueChange={setValue}
          onTrack={track}
          onDismissPalette={dismiss}
          onDismissReport={dismissReport}
          onSuffixPromptChange={(value) => setSuffixSelection({ taskId, value })}
          onSend={send}
          onStop={stop}
        />
      </div>

      {task && (
        <ArchiveConfirmDialog
          task={task}
          reason={archive.reason}
          pending={archive.pending}
          onCancel={archive.dismiss}
          onForce={() => archive.request(true)}
        />
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
  const suffixPromptId = suffixSelection.taskId === taskId ? suffixSelection.value : null
  const disabled = !task || task.archived || task.state === "creating"
  // A stuck task still owns a live turn; it must stop/steer like running,
  // rather than offering a send the daemon will reject.
  const blocked = task?.state === "running" || task?.state === "stuck"
  const hasMessage = value.trim().length > 0
  const canSend = hasMessage && !disabled && !sending
  const canStop = blocked && !hasMessage && !disabled && !sending
  const shown = note && task && note.taskId === task.id ? note : null
  return { taskId, suffixPromptId, disabled, blocked, canSend, canStop, shown }
}

function slashGroups(
  task: ApiTask | null,
  probeCommands: ProbeCommandName[] | undefined,
  skills: TaskSkills | undefined,
  compact: HarnessCompact | null | undefined,
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

function SteerNoteRow({
  note,
  copied,
  onCopied,
}: {
  note: SteerNote
  copied: boolean
  onCopied: (copied: boolean) => void
}) {
  return (
    <div className="mb-1.5 flex items-center gap-2 pl-1.5">
      <span
        data-testid="steer-note"
        title={note.title ?? note.text}
        className={cn(
          "min-w-0 flex-1 truncate text-[11.5px]",
          note.tone === "muted" ? "text-muted-foreground" : "text-destructive",
          note.copyable && "font-mono",
        )}
      >
        {note.text}
      </span>
      {note.copyable && (
        <button
          type="button"
          aria-label="Copy"
          onClick={() => {
            void navigator.clipboard?.writeText(note.copyable!)
            onCopied(true)
            setTimeout(() => onCopied(false), 1_200)
          }}
          className="shrink-0 rounded-sm p-0.5 text-faint transition-colors hover:text-foreground"
        >
          {copied ? <Check className="size-3" aria-label="Copied" /> : <Copy className="size-3" />}
        </button>
      )}
    </div>
  )
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
  onValueChange,
  onTrack,
  onDismissPalette,
  onDismissReport,
  onSuffixPromptChange,
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
  onValueChange: (value: string) => void
  onTrack: (value: string, caret: number | null) => void
  onDismissPalette: () => void
  onDismissReport: () => void
  onSuffixPromptChange: (value: string | null) => void
  onSend: () => void
  onStop: () => void
}) {
  const [focused, setFocused] = useState(false)
  return (
    <div
      className={cn(
        "rounded-xl border bg-surface px-3 pt-2.5 pb-2 transition-colors",
        focused ? "border-accent-dim ring-2 ring-ring/15" : "border-border-strong",
      )}
    >
      <textarea
        ref={boxRef}
        rows={3}
        value={value}
        disabled={disabled}
        onChange={(event) => {
          onValueChange(event.target.value)
          onTrack(event.target.value, event.target.selectionStart)
        }}
        onKeyUp={(event) => onTrack(event.currentTarget.value, event.currentTarget.selectionStart)}
        onClick={(event) => onTrack(event.currentTarget.value, event.currentTarget.selectionStart)}
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
              commandRef.current?.dispatchEvent(new KeyboardEvent("keydown", { key: event.key, bubbles: true }))
              return
            }
          }
          if (event.key === "Escape" && reportOpen) {
            event.preventDefault()
            onDismissReport()
            return
          }
          if (event.key !== "Enter" || event.shiftKey) return
          if (event.nativeEvent.isComposing && !(event.metaKey || event.ctrlKey)) return
          event.preventDefault()
          onSend()
        }}
        placeholder={disabled ? "This task is read-only" : "Ask for changes, or / for commands"}
        className={cn(
          "scroll-slim max-h-[40vh] w-full resize-none bg-transparent leading-relaxed",
          "text-foreground placeholder:text-faint focus:outline-none",
          touch ? "min-h-[60px] text-[15px]" : "min-h-[52px] text-[12.5px]",
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
        onSuffixPromptChange={onSuffixPromptChange}
        onSend={onSend}
        onStop={onStop}
      />
      <PendingAttachmentRows pending={attachments} />
    </div>
  )
}

function ComposerControls({
  task,
  taskId,
  suffixPromptId,
  blocked,
  sending,
  disabled,
  canSend,
  canStop,
  touch,
  attachments,
  onSuffixPromptChange,
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
  attachments: PendingAttachments
  onSuffixPromptChange: (value: string | null) => void
  onSend: () => void
  onStop: () => void
}) {
  return (
    <div className="mt-2 flex items-center gap-2">
      {task && <TaskIdentity task={task} />}
      <span aria-hidden className="h-3 w-px bg-border-strong" />
      <AttachButton pending={attachments} touch={touch} />
      <SuffixPromptPicker
        key={taskId ?? "no-task"}
        value={suffixPromptId}
        onValueChange={onSuffixPromptChange}
        disabled={disabled || sending}
        touch={touch}
      />
      <span className="flex-1" />
      {blocked ? (
        <span className="text-[10.5px] text-faint">running · send won&apos;t interrupt</span>
      ) : (
        <span className="font-mono text-[10.5px] text-faint" title="Enter sends · Shift+Enter for a new line">
          ↵
        </span>
      )}
      <button
        type="button"
        onClick={canStop ? onStop : onSend}
        disabled={!canStop && !canSend}
        aria-label={canStop ? "Stop turn" : blocked ? "Send safely" : "Send"}
        title={
          canStop
            ? "Stop the running turn; the session is kept"
            : blocked
              ? "Send at a safe boundary, or queue for the next turn"
              : "Send"
        }
        className={cn(
          "flex shrink-0 items-center justify-center rounded-full transition-all",
          "focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
          touch ? "size-10" : "size-[26px]",
          canSend
            ? "bg-primary text-primary-foreground hover:brightness-110"
            : canStop
              ? "border border-border-strong bg-card text-foreground hover:bg-hover"
              : "bg-border-strong text-muted-foreground",
        )}
      >
        {canStop ? (
          <Stop className={touch ? "size-5" : "size-3.5"} />
        ) : (
          <ArrowUp className={touch ? "size-5" : "size-3.5"} />
        )}
      </button>
    </div>
  )
}

function TaskIdentity({ task }: { task: ApiTask }) {
  return (
    <Meta
      className="gap-1.5"
      items={[
        task.harness,
        task.model ? <span key="model" className="min-w-0 truncate font-mono">{task.model}</span> : null,
        task.effort ? `${task.effort} effort` : null,
      ]}
    />
  )
}

/** Forwarded to cmdk while the palette is open; Enter must not send. */
const PALETTE_KEYS = new Set(["ArrowDown", "ArrowUp", "Home", "End", "Enter"])

/**
 * The live turn, immediately above the box you would type into — which is the
 * one place you look when wondering whether to wait or to steer, and which is
 * disabled while a turn runs.
 *
 * A breathing violet dot and a gray count, and nothing else: the dot is the
 * `running` state marker the whole app already uses for "this is alive", so it
 * needs no label. Mono with tabular figures because a proportional timer
 * reflows on every tick, which is far more distracting than the motion.
 */
function RunningFor({ startedAt }: { startedAt: string }) {
  const now = useTick(true)
  const text = elapsed(startedAt, now)
  if (!text) return null
  return (
    <div className="mb-1.5 flex items-center gap-2 pl-1.5" aria-live="off">
      <StateDot state="running" className="animate-breathe" />
      <span className="font-mono text-[11px] text-muted-foreground tabular-nums">{text}</span>
    </div>
  )
}
