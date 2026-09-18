import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react"

import { Button, StateDot } from "@/components/primitives"
import { answerText, emptyDraft, type QuestionDraft } from "@/lib/questionnaire"
import type { QuestionPrompt } from "@/lib/types"
import { cn } from "@/lib/utils"
import type { QuestionActivityItem } from "@/stream/reducer"

/**
 * The card the agent asks through.
 *
 * Every question at once, one Send — not the harness's own one-at-a-time
 * wizard. With 1–4 questions of 2–4 options the whole ask fits on screen, and
 * seeing it whole is what lets someone answer in any order and commit once.
 *
 * Two rules from the palette (index.css) shape it:
 *
 *  - SELECTION IS A BACKGROUND CHANGE. A chosen option takes `bg-accent` and a
 *    filled marker, never hue. The card's one violet is the Send button, which
 *    is the same rule the composer's send already lives by.
 *  - The marker SHAPE carries the rule: a circle is choose-one, a square is
 *    choose-any. That is the radio/checkbox contract every reader already has,
 *    and it is a different family from `StateDot`'s one-shape law — that law is
 *    about state markers, not form controls. The `select all that apply` hint
 *    says it in words too, because the words are what actually teach.
 *
 * Answering is always optional: the composer stays live, and a typed message
 * is a legitimate answer ("none of those — do X instead"). When one goes out,
 * the card settles into `superseded` rather than sitting there looking
 * clickable. See `.context/askuser-questionnaire-design.md`.
 */

/**
 * What the CALLER knows. The log already says whether a question settled and
 * how (`item.status` / `item.reason`); this says only whether the reader can
 * still act on one that has not.
 */
export type QuestionnaireState = "pending" | "submitting" | "expired"

export function QuestionnaireCard({
  item,
  state,
  harness,
  error,
  touch = false,
  drafts,
  onDraftChange,
  onSubmit,
  onFocusComposer,
}: {
  item: QuestionActivityItem
  /** What the surrounding turn knows that the log alone cannot say. */
  state: QuestionnaireState
  harness?: string | null
  error?: string | null
  /** Thumb sizing. Same prop the composer takes, from `hasCoarsePointer`. */
  touch?: boolean
  /** Owned above the card: it unmounts on a task switch and every reconnect. */
  drafts?: ReadonlyMap<number, QuestionDraft>
  onDraftChange?: (index: number, change: (draft: QuestionDraft) => QuestionDraft) => void
  onSubmit?: (answers: { index: number; answer: string }[]) => void
  onFocusComposer?: () => void
}) {
  const [ownDrafts, setOwnDrafts] = useState<Map<number, QuestionDraft>>(() => new Map())
  const node = useRef<HTMLDivElement>(null)
  const focused = useRef(false)
  // The log wins: a question the daemon already released is settled for every
  // viewer, whatever this one thinks it could still send.
  const settled = item.status !== "asked" || state === "expired"

  // The gallery and any other provider-less surface still need a working card,
  // so local state is the fallback rather than a requirement.
  const store = drafts ?? ownDrafts
  const draftFor = useCallback((index: number) => store.get(index) ?? emptyDraft(), [store])
  const update = useCallback(
    (index: number, change: (draft: QuestionDraft) => QuestionDraft) => {
      if (onDraftChange) {
        onDraftChange(index, change)
        return
      }
      setOwnDrafts((previous) => {
        const next = new Map(previous)
        next.set(index, change(previous.get(index) ?? emptyDraft()))
        return next
      })
    },
    [onDraftChange],
  )

  const answers = useMemo(
    () =>
      item.questions.map((question) => ({
        index: question.index,
        answer: answerText(question, draftFor(question.index)),
      })),
    [item.questions, draftFor],
  )
  const answered = answers.filter((entry) => entry.answer).length
  const complete = answered === item.questions.length && item.questions.length > 0

  const submit = useCallback(() => {
    if (!complete || state !== "pending" || !onSubmit) return
    onSubmit(answers)
  }, [answers, complete, onSubmit, state])

  // The card is the one thing on screen waiting on a person, so it reaches for
  // focus once — but only if nothing else holds it. A questionnaire can become
  // answerable a beat AFTER it appears (the daemon's answer arrives behind a
  // debounce), and by then the reader may already be typing a reply into the
  // composer; pulling the caret out mid-sentence loses their keystrokes to a
  // div. Anything already focused outranks us.
  useEffect(() => {
    if (state !== "pending" || focused.current) return
    focused.current = true
    const active = document.activeElement
    if (active && active !== document.body) return
    node.current?.focus({ preventScroll: true })
  }, [state])

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault()
      // Escape hands focus back to the composer WITHOUT discarding what is
      // picked — in a GUI, Escape means "leave this control", and Stop is
      // already a button. (The harness's own TUI stops the agent on Escape.)
      onFocusComposer?.()
      return
    }
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      submit()
    }
  }

  if (settled) return <SettledCard item={item} />

  return (
    <div
      ref={node}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      data-testid="questionnaire-card"
      data-state={state}
      className={cn(
        "my-2 rounded-lg border bg-card outline-none",
        "border-state-needs-input/45 focus-visible:ring-2 focus-visible:ring-ring/40",
      )}
    >
      <div className="flex items-center gap-2.5 px-3 py-2">
        <StateDot state="needs-input" />
        <span aria-live="polite" className="text-[12.5px] font-medium text-foreground">
          {harness ? `${labelFor(harness)} is asking you` : "The agent is asking you"}
        </span>
        <span className="ml-auto text-[11px] text-faint">{countLabel(item.questions.length)}</span>
      </div>

      <div className="border-t border-border px-3">
        {item.questions.map((question) => (
          <QuestionBlock
            key={question.index}
            question={question}
            draft={draftFor(question.index)}
            touch={touch}
            disabled={state === "submitting"}
            onChange={(change) => update(question.index, change)}
          />
        ))}
      </div>

      {error && (
        <p role="alert" className="border-t border-border px-3 pt-2 text-[11px] text-destructive">
          {error}
        </p>
      )}
      <div className="flex items-center gap-2.5 border-t border-border px-3 py-2">
        <span className="text-[11px] tabular-nums text-faint">
          {answered} of {item.questions.length} answered
        </span>
        <span className={cn("ml-auto hidden text-[10px] text-faint pointer:inline", !complete && "opacity-0")}>
          <kbd className="rounded border border-border-strong px-1 py-px font-mono">⌘↵</kbd>
        </span>
        <Button
          tone="primary"
          size={touch ? "touch" : "md"}
          onClick={submit}
          disabled={!complete || state === "submitting"}
        >
          {state === "submitting" ? "Sending…" : item.questions.length > 1 ? "Send answers" : "Send answer"}
        </Button>
      </div>
    </div>
  )
}

function QuestionBlock({
  question,
  draft,
  touch,
  disabled,
  onChange,
}: {
  question: QuestionPrompt
  draft: QuestionDraft
  touch: boolean
  disabled: boolean
  onChange: (change: (draft: QuestionDraft) => QuestionDraft) => void
}) {
  const own = useRef<HTMLInputElement>(null)
  const labelId = useId()

  const pick = (option: string) => {
    onChange((current) => {
      if (question.multiSelect) {
        const selected = new Set(current.selected)
        if (selected.has(option)) selected.delete(option)
        else selected.add(option)
        return { ...current, selected }
      }
      // Choosing a listed option on a single-choice question retires whatever
      // was typed: the two are alternatives, not a pair.
      return { selected: new Set([option]), own: "", ownOpen: false }
    })
  }

  // Opening the row is not yet ANSWERING with it: someone who clicks to see
  // what it offers must not silently lose the option they already picked. The
  // pick is retired when they actually type (see `onText`), not before.
  const openOwn = () => {
    onChange((current) => ({ ...current, ownOpen: true }))
    requestAnimationFrame(() => own.current?.focus())
  }

  const onOwnText = (value: string) => {
    onChange((current) => ({
      ...current,
      own: value,
      ownOpen: true,
      // On a single-choice question a typed answer and a listed one are
      // alternatives; an empty box is neither, so it retires nothing.
      selected: question.multiSelect || !value.trim() ? current.selected : new Set(),
    }))
  }

  // An empty box that loses focus was a look, not an answer — collapse it so
  // the list goes back to one uniform column and the row can be re-entered.
  const onOwnBlur = () => {
    onChange((current) => (current.own.trim() ? current : { ...current, ownOpen: false }))
  }

  // The digit beside an option promises a shortcut, so the promise is kept
  // here: 1-9 picks within the question that holds focus, the same way the
  // harness's own TUI does. A hint for a key that does nothing is worse than
  // no hint.
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (disabled || event.metaKey || event.ctrlKey || event.altKey) return
    const slot = Number(event.key)
    if (!Number.isInteger(slot) || slot < 1 || slot > question.options.length) return
    event.preventDefault()
    pick(question.options[slot - 1]!)
  }

  return (
    <div className="border-b border-border py-2.5 last:border-b-0">
      <div className="mb-1.5 flex flex-wrap items-baseline gap-x-1.5">
        <span className="text-[10.5px] tabular-nums text-faint">{question.index}</span>
        {question.topic && <span className="text-[10.5px] text-faint">{question.topic}</span>}
        {question.multiSelect && <span className="text-[10.5px] text-faint">· select all that apply</span>}
        <span
          id={labelId}
          className="mt-px basis-full text-[13px] leading-snug font-medium text-foreground"
        >
          {question.question}
        </span>
      </div>
      <div
        className="flex flex-col gap-0.5"
        role={question.multiSelect ? "group" : "radiogroup"}
        aria-labelledby={labelId}
        onKeyDown={onKeyDown}
      >
        {question.options.map((option, position) => {
          const selected = draft.selected.has(option)
          return (
            <button
              key={option}
              type="button"
              role={question.multiSelect ? "checkbox" : "radio"}
              aria-checked={selected}
              disabled={disabled}
              onClick={() => pick(option)}
              className={cn(
                "group flex w-full items-center gap-2.5 rounded-md px-2.5 text-left transition-colors",
                "disabled:pointer-events-none",
                "focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
                touch ? "min-h-11 text-[13px]" : "min-h-8 text-[12.5px]",
                selected
                  ? "bg-accent font-medium text-foreground"
                  : "text-fg-secondary hover:bg-hover hover:text-foreground",
              )}
            >
              <Marker multi={question.multiSelect} on={selected} />
              <span className="min-w-0 flex-1">{option}</span>
              {/* Chrome, not part of the option's name — a screen reader
                  announcing "Japan 2" would be reading the keyboard hint as
                  though it were the answer. */}
              <span
                aria-hidden
                className={cn(
                  "hidden shrink-0 font-mono text-[10px] text-faint pointer:inline",
                  selected ? "opacity-100" : "opacity-0 group-hover:opacity-100",
                )}
              >
                {position + 1}
              </span>
            </button>
          )
        })}
        <OwnAnswerRow
          ref={own}
          multi={question.multiSelect}
          touch={touch}
          draft={draft}
          disabled={disabled}
          onOpen={openOwn}
          onText={onOwnText}
          onBlur={onOwnBlur}
        />
      </div>
    </div>
  )
}

/**
 * The own-answer row is the last row of the SAME list, not a field below it:
 * one list, one eye path. Every harness with this tool guarantees it, and none
 * of them list it as an option — the interface is expected to add it.
 */
function OwnAnswerRow({
  ref,
  multi,
  touch,
  draft,
  disabled,
  onOpen,
  onText,
  onBlur,
}: {
  ref: React.RefObject<HTMLInputElement | null>
  multi: boolean
  touch: boolean
  draft: QuestionDraft
  disabled: boolean
  onOpen: () => void
  onText: (value: string) => void
  onBlur: () => void
}) {
  const on = draft.own.trim().length > 0
  if (!draft.ownOpen) {
    return (
      <button
        type="button"
        // It wears the same marker and sits in the same list, so it is a real
        // member of the group: without this a screen reader announces "2
        // radio buttons" for a question that offers three ways to answer.
        role={multi ? "checkbox" : "radio"}
        aria-checked={false}
        disabled={disabled}
        onClick={onOpen}
        className={cn(
          "flex w-full items-center gap-2.5 rounded-md px-2.5 text-left text-faint transition-colors",
          "hover:bg-hover disabled:pointer-events-none",
          "focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
          touch ? "min-h-11 text-[13px]" : "min-h-8 text-[12.5px]",
        )}
      >
        <Marker multi={multi} on={false} />
        <span>Or type your own answer…</span>
      </button>
    )
  }
  return (
    <div
      role={multi ? "checkbox" : "radio"}
      aria-checked={on}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-md px-2.5",
        touch ? "min-h-11" : "min-h-8",
        on && "bg-accent",
      )}
    >
      <Marker multi={multi} on={on} />
      <input
        ref={ref}
        value={draft.own}
        disabled={disabled}
        onBlur={onBlur}
        // 1-9 picks a listed option, but inside this box a digit is a digit.
        onKeyDown={(event) => event.stopPropagation()}
        onChange={(event) => onText(event.target.value)}
        placeholder="Or type your own answer…"
        aria-label="Your own answer"
        className={cn(
          "min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-faint",
          touch ? "text-[13px]" : "text-[12.5px]",
        )}
      />
    </div>
  )
}

function Marker({ multi, on }: { multi: boolean; on: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-[13px] shrink-0 items-center justify-center border-[1.5px] transition-colors",
        multi ? "rounded-[4px]" : "rounded-full",
        on ? "border-foreground" : "border-border-strong",
      )}
    >
      {on && (
        <span className={cn("bg-foreground", multi ? "size-[7px] rounded-[1.5px]" : "size-[6px] rounded-full")} />
      )}
    </span>
  )
}

type SettledKind = "answered" | "closed" | "superseded" | "stopped" | "expired"

const SETTLED_HEAD: Record<SettledKind, { title: string; note: string | null; dot: "done" | "creating" }> = {
  answered: { title: "You answered", note: null, dot: "done" },
  closed: { title: "Answered", note: "the answers are not in this transcript", dot: "done" },
  superseded: { title: "Not answered here", note: "you replied in the message below", dot: "creating" },
  stopped: { title: "Not answered", note: "the agent was stopped", dot: "creating" },
  expired: { title: "Not answered", note: "this question expired — answer in a message", dot: "creating" },
}

/**
 * Why a card is read-only, in the order the reader cares about: what actually
 * happened if the daemon said, and otherwise that the channel is simply gone.
 *
 * `reason` is optional on the wire, and a cancel with none is exactly the case
 * where asserting "the agent was stopped" would be inventing a fact — a log
 * written before the reason existed, or a phase we did not annotate. It falls
 * to the neutral sentence instead. Same for an `answered` phase that carries
 * no answers: the questions were answered, we just cannot show what with.
 */
function settledKind(item: QuestionActivityItem): SettledKind {
  if (item.status === "answered") return item.answers?.length ? "answered" : "closed"
  if (item.status === "cancelled") {
    if (item.reason === "superseded") return "superseded"
    return item.reason === "stopped" ? "stopped" : "expired"
  }
  return "expired"
}

/**
 * The record the card leaves in the transcript. Read-only, no hue, and it has
 * to survive a reload and an export — the questions were really asked, so they
 * stay readable whether or not they were ever answered here.
 */
function SettledCard({ item }: { item: QuestionActivityItem }) {
  const kind = settledKind(item)
  const head = SETTLED_HEAD[kind]
  const byIndex = new Map((item.answers ?? []).map((entry) => [entry.index, entry.answer]))
  return (
    <div
      data-testid="questionnaire-card"
      data-state={kind}
      className="my-2 rounded-lg border border-border-strong bg-card"
    >
      <div className="flex items-center gap-2.5 px-3 py-2">
        <StateDot state={head.dot} />
        <span className="text-[12.5px] font-medium text-foreground">{head.title}</span>
        <span className="ml-auto truncate pl-3 text-[11px] text-faint">
          {head.note ?? countLabel(item.questions.length)}
        </span>
      </div>
      <div className="border-t border-border px-3 py-0.5">
        {item.questions.map((question) => {
          const answer = byIndex.get(question.index)
          return (
            <div
              key={question.index}
              className="flex gap-2 border-b border-border py-1.5 text-[12px] leading-normal last:border-b-0"
            >
              <span className="shrink-0 pt-px text-[11px] tabular-nums text-faint">{question.index}</span>
              <span className="min-w-0 flex-1 text-fg-secondary">{question.question}</span>
              <span
                className={cn(
                  "max-w-[46%] shrink-0 text-right",
                  answer ? "font-medium text-foreground" : "text-faint",
                )}
              >
                {answer || "—"}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function countLabel(count: number): string {
  return count === 1 ? "1 question" : `${count} questions`
}

/** `droid` → `Droid`. The harness names itself lowercase everywhere else. */
function labelFor(harness: string): string {
  return harness.charAt(0).toUpperCase() + harness.slice(1)
}
