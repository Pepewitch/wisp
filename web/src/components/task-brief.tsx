import { useId, useState, type ReactNode } from "react"

import { Check, ChevronRight } from "@/components/icons"
import { PaneHeader, Rule, SwitchTrack } from "@/components/primitives"
import { Prose } from "@/components/prose"
import { useTick } from "@/hooks/useTick"
import { useBriefSwitch } from "@/hooks/useBriefSwitch"
import { briefBand, recommendedOption, type BriefBandModel, type BriefInputView, type TaskBriefV1 } from "@/lib/brief"
import { useDaemonRuntime } from "@/lib/runtime"
import type { ApiTask } from "@/lib/types"
import { uiIntentsFor } from "@/lib/ui-intents"
import { cn } from "@/lib/utils"

/** Hand some words to find-in-task, in the turn they belong to. */
type Reveal = (query: string, turn: number | null) => void

/**
 * The task brief: a tab of the task panel, beside Changes and Workflows
 * (frontend reference §5k). The header says which task this is; this says
 * where it stands — your latest words as Wisp recorded them, then the agent's
 * own report of goal, result, what remains, and any decision waiting on you.
 *
 * It used to be a band above the conversation. That cost the reading column
 * a strip of height on every task, open or not, and moved the text you were
 * reading whenever a report changed. A tab costs nothing until you go there,
 * and the panel is where standing state already lives.
 *
 * The switch at the top is the one control here: it decides whether briefs
 * are generated, and is the same switch as the task menu's. Everything else
 * is READING ONLY and writes nothing.
 *
 * Kept mounted while another tab shows (`hidden`), like its siblings, so the
 * scroll position and an open comparison survive a look at the diff.
 */
export function BriefPane({
  task,
  header,
  hidden = false,
  touch = false,
  onShowConversation,
}: {
  task: ApiTask | null
  /** the panel's tab strip; without one the pane names itself */
  header?: ReactNode
  hidden?: boolean
  touch?: boolean
  /** Bring the transcript on screen before a find runs against it (touch, where it is another tab). */
  onShowConversation?: () => void
}) {
  const { connectionId } = useDaemonRuntime()
  const brief = useBriefSwitch(task)
  const now = useTick(brief.enabled)
  const model: BriefBandModel = brief.enabled ? briefBand(brief.query.data, brief.query.error, now) : { kind: "hidden" }

  const intents = uiIntentsFor(connectionId)
  const reveal: Reveal = (words, turn) => {
    if (!onShowConversation) return intents.openFind(words, turn)
    onShowConversation()
    // a frame later, so the find runs against a transcript that is on screen
    requestAnimationFrame(() => intents.openFind(words, turn))
  }

  return (
    <div className={cn("h-full min-h-0 flex-1 flex-col", hidden ? "hidden" : "flex")} aria-hidden={hidden || undefined}>
      {(!touch || header) && (
        <PaneHeader touch={touch} className={header ? "pl-2" : undefined}>
          {header ?? <span className="text-[12.5px] font-medium text-foreground">Brief</span>}
        </PaneHeader>
      )}
      <section aria-label="Task brief" className="@container flex min-h-0 flex-1 flex-col">
        {!task ? (
          <p className="px-3.5 py-3 text-[12.5px] text-muted-foreground">No task selected.</p>
        ) : (
          <>
            {/* pinned above the scroller: a long report must not take the switch out of reach */}
            {brief.switchable && (
              <BriefSwitch
                enabled={brief.enabled}
                disabled={brief.disabled}
                // once a report or its empty line is showing, that says the same thing
                note={brief.enabled && model.kind !== "hidden" ? null : brief.note}
                error={brief.error}
                touch={touch}
                onChange={brief.set}
              />
            )}
            {/* Archived tasks cannot be switched, but a report already written stays readable. */}
            <div className="scroll-slim min-h-0 flex-1 overflow-y-auto">
              {model.kind !== "hidden" && (
                <BriefBody
                  // per task: nothing opened on one task's brief carries to another's
                  key={task.id}
                  model={model}
                  touch={touch}
                  onReveal={reveal}
                  onRetry={() => void brief.query.refetch()}
                />
              )}
            </div>
          </>
        )}
      </section>
    </div>
  )
}

/** The on/off switch and the one line saying what it does. The whole row is the hit target. */
export function BriefSwitch({
  enabled,
  disabled,
  note,
  error,
  touch,
  onChange,
}: {
  enabled: boolean
  disabled: boolean
  note: string | null
  error: string | null
  touch: boolean
  onChange: (enabled: boolean) => void
}) {
  return (
    <div className="border-b border-border">
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        aria-label="Task brief"
        disabled={disabled}
        onClick={() => onChange(!enabled)}
        className={cn(
          "flex w-full items-center justify-between gap-3 px-3.5 text-left transition-colors hover:bg-hover",
          "focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none focus-visible:ring-inset disabled:opacity-60",
          touch ? "min-h-11 py-2" : "py-2",
        )}
      >
        <span className="text-[12.5px] font-medium text-foreground">{enabled ? "Brief on" : "Brief off"}</span>
        <SwitchTrack checked={enabled} />
      </button>
      {(note || error) && (
        <p className="px-3.5 pt-3 pb-3.5 text-[11.5px] leading-relaxed text-muted-foreground">{error ?? note}</p>
      )}
    </div>
  )
}

/** The report itself, from a model alone — which is also how the gallery draws it. */
export function BriefBody({
  model,
  touch = false,
  onReveal,
  onRetry,
}: {
  model: Exclude<BriefBandModel, { kind: "hidden" }>
  touch?: boolean
  onReveal?: Reveal
  onRetry?: () => void
}) {
  if (model.kind === "line") {
    return (
      <div className="flex items-center gap-2 px-3.5 py-3">
        <span className="min-w-0 flex-1 text-[12.5px] text-muted-foreground">{model.text}</span>
        {model.retry && onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className={cn("shrink-0 text-[11.5px] text-muted-foreground transition-colors hover:text-foreground", touch && "min-h-11")}
          >
            Retry
          </button>
        )}
      </div>
    )
  }
  return (
    // a new report (another turn or revision) starts with its comparison closed
    <div key={model.key} className="flex flex-col gap-2.5 px-3.5 py-3">
      <StatusFacts parts={model.status} />
      {model.input && <InputRow key={model.input.key} input={model.input} touch={touch} onReveal={onReveal} />}
      <div className="flex items-center gap-3 pt-0.5">
        <span className="shrink-0 text-[10.5px] text-faint">{model.divider}</span>
        <Rule />
      </div>
      <ReportRows brief={model.brief} touch={touch} originalRequest={model.originalRequest} onReveal={onReveal} />
    </div>
  )
}

/** One muted freshness line: which turn the report is from, and the one fact about how current it is. */
function StatusFacts({ parts }: { parts: string[] }) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 text-[11.5px] text-muted-foreground">
      {parts.map((part, i) => (
        <span key={i} className="flex items-center gap-2">
          {i > 0 && <span className="text-faint">·</span>}
          {part}
        </span>
      ))}
    </div>
  )
}

function Row({ label, children, touch }: { label: string; children: ReactNode; touch: boolean }) {
  return (
    <div className={cn("grid gap-x-3 gap-y-0.5", !touch && "@min-[520px]:grid-cols-[76px_minmax(0,1fr)]")}>
      <div className="pt-[3px] text-[11.5px] text-muted-foreground">{label}</div>
      <div className="min-w-0 text-[13px] leading-[1.6] text-foreground">{children}</div>
    </div>
  )
}

/** Agent text: rendered by the app's one safe prose path, never as HTML. */
function AgentText({ text, className }: { text: string; className?: string }) {
  return <Prose text={text} mode="static" className={cn("text-[13px] leading-[1.6] text-foreground [&_p]:my-0", className)} />
}

function QuietButton({ children, onClick, touch }: { children: ReactNode; onClick: () => void; touch: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1 rounded-sm text-[11.5px] text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline",
        touch && "min-h-11",
      )}
    >
      {children}
    </button>
  )
}

/** A caption item and the separator before it, kept together so a wrapped caption never ends on a dot. */
function CaptionItem({ first, children }: { first: boolean; children: ReactNode }) {
  return (
    <span className="flex items-center gap-2">
      {!first && <span className="text-faint">·</span>}
      {children}
    </span>
  )
}

/** The person's own words — exact, cut only where the brief says it is cut. */
function InputRow({ input, touch, onReveal }: { input: BriefInputView; touch: boolean; onReveal?: Reveal }) {
  const [full, setFull] = useState(false)
  const long = [...input.text].length > 220
  const shown = full || !long ? input.text : `${[...input.text].slice(0, 200).join("").trimEnd()}`
  const cut = (long && !full) || input.truncated
  return (
    <Row label={input.label} touch={touch}>
      {input.question && <div className="text-[12.5px] text-muted-foreground">{input.question}</div>}
      <div className="whitespace-pre-wrap text-fg-secondary">
        “{shown}{cut ? "…" : ""}”
      </div>
      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11.5px] text-muted-foreground">
        {input.caption.map((part, i) => <CaptionItem key={i} first={i === 0}>{part}</CaptionItem>)}
        {long && !full && (
          <CaptionItem first={false}>
            <QuietButton touch={touch} onClick={() => setFull(true)}>Show all</QuietButton>
          </CaptionItem>
        )}
        {onReveal && input.find.query && (
          <CaptionItem first={false}>
            <QuietButton touch={touch} onClick={() => onReveal(input.find.query, input.find.turn)}>Show in conversation</QuietButton>
          </CaptionItem>
        )}
      </div>
    </Row>
  )
}

function ReportRows({
  brief,
  touch,
  originalRequest,
  onReveal,
}: {
  brief: TaskBriefV1
  touch: boolean
  originalRequest: string | null
  onReveal?: Reveal
}) {
  return (
    <>
      <Row label="Goal" touch={touch}>
        {brief.goal ? (
          <AgentText text={brief.goal} />
        ) : (
          <span className="text-muted-foreground">
            Not stated in this report
            {onReveal && originalRequest && (
              <>
                {" · "}
                <QuietButton touch={touch} onClick={() => onReveal(originalRequest, 1)}>Original request</QuietButton>
              </>
            )}
          </span>
        )}
      </Row>
      <Row label="Result" touch={touch}>
        <AgentText text={brief.outcome} />
      </Row>
      <Row label="Remaining" touch={touch}>
        {brief.remaining === null ? (
          <span className="text-muted-foreground">The agent could not say what remains.</span>
        ) : brief.remaining.length === 0 ? (
          <span className="text-muted-foreground">Nothing the agent knows of.</span>
        ) : (
          <ul className="list-disc pl-4">
            {brief.remaining.map((item, i) => (
              <li key={`${i}:${item}`}><AgentText text={item} /></li>
            ))}
          </ul>
        )}
      </Row>
      {brief.decision && <DecisionRow decision={brief.decision} touch={touch} />}
      {brief.scopeChange && (
        <Row label="Scope" touch={touch}>
          <AgentText text={brief.scopeChange} />
        </Row>
      )}
    </>
  )
}

const OPTION_TEXT = "text-[12.5px] leading-[1.55] text-fg-secondary"

function DecisionRow({ decision, touch }: { decision: NonNullable<TaskBriefV1["decision"]>; touch: boolean }) {
  const [compare, setCompare] = useState(false)
  const id = useId()
  const count = decision.options.length
  const recommended = recommendedOption(decision.options.map((option) => option.label), decision.recommendation)
  return (
    <Row label="Decision" touch={touch}>
      <div className="font-medium"><AgentText text={decision.question} /></div>
      {decision.recommendation && (
        <div className="text-fg-secondary">
          <AgentText text={`Recommends: ${decision.recommendation}`} />
        </div>
      )}
      <button
        type="button"
        aria-expanded={compare}
        aria-controls={compare ? id : undefined}
        onClick={() => setCompare(!compare)}
        className={cn("mt-1 inline-flex items-center gap-1 text-[11.5px] text-muted-foreground transition-colors hover:text-foreground", touch && "min-h-11")}
      >
        <ChevronRight className={cn("size-2.5 transition-transform motion-reduce:transition-none", compare && "rotate-90")} />
        {compare ? "Hide options" : count === 1 ? "Show the option" : `Compare ${count} options`}
      </button>
      {compare && (
        <div id={id} className="mt-2.5 flex flex-col gap-3 border-l border-border pl-3">
          {decision.options.map((option, index) => (
            <div key={`${index}:${option.label}`}>
              <div className="flex flex-wrap items-center gap-x-2 text-[12.5px] font-medium text-foreground">
                {option.label}
                {index === recommended && (
                  <span className="flex items-center gap-1 text-[11.5px] font-normal text-muted-foreground">
                    <Check className="size-3" aria-hidden />
                    Recommended
                  </span>
                )}
              </div>
              <dl className="mt-1 grid grid-cols-[64px_minmax(0,1fr)] gap-x-3 gap-y-0.5">
                {([
                  ["Gain", option.gain],
                  ["Downside", option.downside],
                  ["Affects", option.impact],
                  ["Effort", option.effort ?? "Not assessed"],
                ] as const).map(([term, value]) => (
                  <div key={term} className="contents">
                    <dt className="pt-px text-[11.5px] text-muted-foreground">{term}</dt>
                    <dd><AgentText text={value} className={OPTION_TEXT} /></dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
          {decision.unknowns && decision.unknowns.length > 0 && (
            <div>
              <div className="text-[11.5px] text-muted-foreground">Unknown</div>
              <ul className="mt-0.5 list-disc pl-4">
                {decision.unknowns.map((unknown, i) => <li key={`${i}:${unknown}`}><AgentText text={unknown} className={OPTION_TEXT} /></li>)}
              </ul>
            </div>
          )}
          {decision.alternativesNote && (
            <div>
              <div className="text-[11.5px] text-muted-foreground">Alternatives</div>
              <AgentText text={decision.alternativesNote} className={OPTION_TEXT} />
            </div>
          )}
        </div>
      )}
    </Row>
  )
}
